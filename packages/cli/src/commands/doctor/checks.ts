/**
 * Diagnostic check functions for `grafema doctor` command - REG-214
 *
 * Checks are organized in levels:
 * - Level 1: Prerequisites (fail-fast) - checkBinaries, checkGrafemaInitialized, checkServerStatus
 * - Level 2: Configuration - checkConfigValidity, checkEntrypoints
 * - Level 3: Graph Health - checkDatabaseExists, checkGraphStats, checkConnectivity, checkFreshness
 * - Level 4: Informational - checkVersions
 */

import { existsSync, readFileSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
  RFDBServerBackend,
  RFDBClient,
  loadConfig,
  GraphFreshnessChecker,
  listBinaryCandidates,
  resolvePlatformPackageBinary,
  getPlatformPackageName,
  findRfdbBinary,
  findOrchestratorBinary,
  GRAFEMA_VERSION,
  getSchemaVersion,
} from '@grafema/util';
import type { BinaryCandidate } from '@grafema/util';
import type { DoctorCheckResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Valid built-in plugin names (for config validation)
const VALID_PLUGIN_NAMES = new Set([
  // Discovery
  'SimpleProjectDiscovery', 'MonorepoServiceDiscovery', 'WorkspaceDiscovery',
  // Indexing
  'JSModuleIndexer', 'RustModuleIndexer',
  // Analysis
  'JSASTAnalyzer', 'ExpressRouteAnalyzer', 'SocketIOAnalyzer', 'DatabaseAnalyzer',
  'FetchAnalyzer', 'ServiceLayerAnalyzer', 'ReactAnalyzer', 'RustAnalyzer',
  // Enrichment
  'MethodCallResolver', 'AliasTracker', 'ValueDomainAnalyzer', 'MountPointResolver',
  'PrefixEvaluator', 'InstanceOfResolver', 'ImportExportLinker', 'HTTPConnectionEnricher',
  'RustFFIEnricher',
  // Validation
  'CallResolverValidator', 'EvalBanValidator', 'SQLInjectionValidator', 'ShadowingDetector',
  'GraphConnectivityValidator', 'DataFlowValidator',
]);

// =============================================================================
// Level 1: Prerequisites (fail-fast)
// =============================================================================

type BinaryName = 'rfdb-server' | 'grafema-orchestrator';

/** A candidate plus what it says its version is. */
interface InspectedCandidate {
  source: string;
  path: string;
  /** Version reported by `<binary> --version`, or null when unreadable. */
  version: string | null;
}

/** What one asking module resolves for a binary. */
interface AnchorOutcome {
  path: string | null;
  version: string | null;
  source: string | null;
  /** Why this anchor produced nothing, when it produced nothing. */
  unavailable?: string;
}

/** Injection points so the divergence report can be exercised on a fixture. */
export interface CheckBinariesDeps {
  listCandidates?: (binaryName: BinaryName) => BinaryCandidate[];
  readVersion?: (path: string) => string | null;
  /** The binary the server is really spawned with; defaults to the real lookup. */
  spawnBinary?: (binaryName: BinaryName) => string | null;
  anchors?: (binaryName: BinaryName) => Record<string, AnchorOutcome>;
}

/**
 * Version a binary reports for itself: `rfdb-server 0.4.1` → `0.4.1`.
 *
 * Returns null rather than throwing — an unreadable candidate is a fact worth
 * printing, not a reason to abandon the check.
 */
function readBinaryVersion(binaryPath: string): string | null {
  const result = spawnSync(binaryPath, ['--version'], { encoding: 'utf-8', timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  const match = `${result.stdout || ''}${result.stderr || ''}`.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

/**
 * rfdb-server is released in lockstep with the JS packages, and
 * RFDBServerBackend warns when the two disagree — so "different from expected"
 * is a real finding for it. grafema-orchestrator carries its own crate version
 * (0.1.0), so comparing it to GRAFEMA_VERSION would only ever print noise.
 */
function expectedVersionFor(binaryName: BinaryName): string | null {
  return binaryName === 'rfdb-server' ? getSchemaVersion(GRAFEMA_VERSION) : null;
}

/**
 * Resolve the platform package from the CLI's own module location, falling
 * back to @grafema/util's.
 *
 * Node resolution is anchored at the asking module, and that anchor is the
 * whole mechanism here: measured in this tree, `@grafema/grafema-darwin-x64`
 * resolves from packages/cli and packages/grafema but is MODULE_NOT_FOUND from
 * packages/util. So a doctor that only ever asked with util's anchor would
 * still be blind to the package that actually serves installed consumers. In a
 * hoisted npm install both anchors resolve to the same package, so this only
 * ever adds visibility.
 */
function platformPackageForDoctor(binaryName: BinaryName): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require(getPlatformPackageName());
    const named =
      binaryName === 'rfdb-server' ? pkg.rfdbServerPath : pkg.orchestratorPath;
    if (named && existsSync(named)) return named;
    if (pkg.binDir) {
      const p = join(pkg.binDir, binaryName);
      if (existsSync(p)) return p;
    }
  } catch {
    // Not installed next to the CLI — fall through to util's own lookup.
  }
  return null;
}

/**
 * Resolve the platform package as the named package would: find that package
 * first, then ask node from ITS location.
 *
 * Throws a human-readable reason when the package cannot be reached from here —
 * "we could not look" and "there is nothing there" are different answers and
 * must not be printed as the same one.
 */
function platformPackageFromPackage(pkgName: string, binaryName: BinaryName): string | null {
  const require = createRequire(import.meta.url);
  let anchorPath: string;
  try {
    anchorPath = require.resolve(pkgName);
  } catch {
    throw new Error(`${pkgName} is not resolvable from the CLI, so its view cannot be checked here`);
  }
  try {
    const pkg = createRequire(anchorPath)(getPlatformPackageName());
    const named = binaryName === 'rfdb-server' ? pkg.rfdbServerPath : pkg.orchestratorPath;
    if (named && existsSync(named)) return named;
    if (pkg.binDir) {
      const p = join(pkg.binDir, binaryName);
      if (existsSync(p)) return p;
    }
  } catch {
    // Platform package not visible from that anchor — a real answer, not a gap.
  }
  return null;
}

/**
 * The shared candidate list, asked with the CLI's anchor for the platform
 * package. Never shorter than `listBinaryCandidates(name)` — a diagnostic that
 * sees fewer places than the resolver is how this defect stayed invisible.
 */
export function listCandidatesForDoctor(binaryName: BinaryName): BinaryCandidate[] {
  return listBinaryCandidates(binaryName, {}, {
    platformPackagePath: (n) => platformPackageForDoctor(n) ?? resolvePlatformPackageBinary(n),
  });
}

/**
 * The binary the server is ACTUALLY started with.
 *
 * Not a guess about which anchor wins: every spawn site (RFDBConnectionBase,
 * `grafema server start`, `grafema start`, the orchestrator runners) resolves
 * through @grafema/util's findBinary, so this asks that exact function. If a
 * spawn site is ever changed to resolve differently, this line becomes wrong
 * together with it rather than drifting silently — and the acceptance test
 * checks it against the executable of a live server process.
 *
 * Caveat worth knowing: when this returns null the callers fall back to a lazy
 * download, which doctor reports separately as a missing binary.
 */
function spawnBinaryFor(binaryName: BinaryName): string | null {
  return binaryName === 'rfdb-server' ? findRfdbBinary() : findOrchestratorBinary();
}

/**
 * What each asking module resolves, one row per anchor.
 *
 * There is no single true arrow here: node resolution is anchored at the asking
 * module, so `@grafema/grafema-darwin-x64` can be visible from packages/cli and
 * packages/grafema and MODULE_NOT_FOUND from packages/util — measured, that is
 * this machine. A doctor that printed ONE winner had to be wrong for somebody:
 * with util's anchor it understated the problem (the original defect), with its
 * own it overstated it (the first fix, which named a 0.3.28 binary that never
 * runs).
 */
function anchorOutcomes(
  binaryName: BinaryName,
  readVersion: (path: string) => string | null,
): Record<string, AnchorOutcome> {
  const anchors: Array<[string, () => string | null]> = [
    // Asked of util itself, not re-derived: this is the resolver the spawn uses.
    ['@grafema/util', () => resolvePlatformPackageBinary(binaryName)],
    ['@grafema/cli', () => platformPackageForDoctor(binaryName)],
    ['grafema', () => platformPackageFromPackage('grafema', binaryName)],
  ];

  const out: Record<string, AnchorOutcome> = {};
  for (const [name, resolvePlatform] of anchors) {
    let winner: BinaryCandidate | undefined;
    try {
      winner = listBinaryCandidates(binaryName, {}, { platformPackagePath: resolvePlatform })[0];
    } catch (err) {
      out[name] = {
        path: null,
        version: null,
        source: null,
        unavailable: err instanceof Error ? err.message : String(err),
      };
      continue;
    }
    out[name] = winner
      ? { path: winner.path, version: readVersion(winner.path), source: winner.source }
      : { path: null, version: null, source: null, unavailable: 'nothing found from this anchor' };
  }
  return out;
}

function inspect(
  binaryName: BinaryName,
  deps: CheckBinariesDeps,
): InspectedCandidate[] {
  const list = deps.listCandidates ?? listCandidatesForDoctor;
  const readVersion = deps.readVersion ?? readBinaryVersion;
  return list(binaryName).map((c) => ({ ...c, version: readVersion(c.path) }));
}

/**
 * One candidate per line, in resolution order.
 *
 * Deliberately NOT marked with a winner: which one wins depends on who is
 * asking, and a single arrow next to a list is read as the answer.
 */
function renderCandidates(binaryName: BinaryName, candidates: InspectedCandidate[]): string[] {
  return candidates.map(
    (c) => `    ${binaryName} ${c.version ?? 'version unreadable'}  ${c.source}  ${c.path}`,
  );
}

/** One line per asking module, marking those that differ from what spawns. */
function renderAnchors(
  anchors: Record<string, AnchorOutcome>,
  spawnPath: string | null,
): string[] {
  return Object.entries(anchors).map(([name, outcome]) => {
    if (!outcome.path) {
      return `    from ${name.padEnd(14)} → ${outcome.unavailable ?? 'nothing found'}`;
    }
    const differs = spawnPath && outcome.path !== spawnPath ? '   (differs from what spawns)' : '';
    return `    from ${name.padEnd(14)} → ${outcome.version ?? 'version unreadable'}  ${outcome.source}  ${outcome.path}${differs}`;
  });
}

/**
 * Everything that makes this set of candidates untrustworthy.
 *
 * REG-1198: the previous check could not produce any of these — it reported the
 * single path IT would have chosen, using a different order from the one
 * consumers walk (monorepo first, platform package not consulted at all). A
 * check that cannot observe one of the two possible outcomes can only ever
 * answer "fine".
 */
function divergences(
  binaryName: BinaryName,
  candidates: InspectedCandidate[],
  anchors: Record<string, AnchorOutcome>,
  spawn: InspectedCandidate | null,
): string[] {
  const problems: string[] = [];
  const expected = expectedVersionFor(binaryName);

  for (const c of candidates) {
    if (expected && c.version && getSchemaVersion(c.version) !== expected) {
      problems.push(
        `${binaryName} in ${c.source} is v${c.version}, expected v${expected} (${c.path})`,
      );
    }
  }

  const versions = new Set(candidates.filter((c) => c.version).map((c) => c.version as string));
  if (versions.size > 1) {
    problems.push(
      `${binaryName} resolves to different versions depending on which package asks: ` +
        `${[...versions].join(' vs ')}`,
    );
  }

  // The one that bites: a consumer resolving from its own package gets a
  // different binary than the server that actually starts.
  const disagreeing = Object.entries(anchors).filter(
    ([, a]) => a.path && spawn?.path && a.path !== spawn.path,
  );
  if (disagreeing.length > 0 && spawn) {
    problems.push(
      `which ${binaryName} you get depends on the asking module — ` +
        disagreeing
          .map(([name, a]) =>
            a.version && a.version === spawn.version
              ? `${name} resolves a different build of the same version ${a.version} (${a.path})`
              : `${name} resolves ${a.version ?? 'an unreadable version'} (${a.path})`,
          )
          .join(', ') +
        `, while the server actually spawns ${spawn.version ?? 'an unreadable version'} (${spawn.path})`,
    );
  }

  return problems;
}

/**
 * Check that the native binaries (rfdb-server, grafema-orchestrator) are
 * findable AND that everyone who asks gets the same one.
 *
 * FAIL if both missing, WARN if one is missing or anything diverges, PASS
 * otherwise. Three things are always printed and none of them is a single
 * arrow: what actually spawns, what each asking module resolves, and every
 * candidate with its version. Printing one winner is what let a three-month-old
 * rfdb-server serve consumers while doctor reported the fresh monorepo build —
 * and then, with the arrow moved to doctor's own anchor, let doctor name a
 * binary that never runs.
 */
export async function checkBinaries(deps: CheckBinariesDeps = {}): Promise<DoctorCheckResult> {
  const readVersion = deps.readVersion ?? readBinaryVersion;
  const rfdb = inspect('rfdb-server', deps);
  const orchestrator = inspect('grafema-orchestrator', deps);

  const found: string[] = [];
  const missing: string[] = [];
  const lines: string[] = [];
  const problems: string[] = [];
  const spawnByName: Record<string, InspectedCandidate | null> = {};
  const anchorsByName: Record<string, Record<string, AnchorOutcome>> = {};

  // A fixture candidate list describes a whole world: taking the anchors and
  // the spawn from the real machine instead would report two worlds at once,
  // and the mismatch would read as a finding.
  const injected = deps.listCandidates;
  const defaultSpawn: (n: BinaryName) => string | null = injected
    ? (n) => injected(n)[0]?.path ?? null
    : spawnBinaryFor;
  const defaultAnchors: (n: BinaryName) => Record<string, AnchorOutcome> = injected
    ? (n) => {
        const first = injected(n)[0];
        return {
          'injected fixture': first
            ? { path: first.path, version: readVersion(first.path), source: first.source }
            : { path: null, version: null, source: null, unavailable: 'fixture has no candidates' },
        };
      }
    : (n) => anchorOutcomes(n, readVersion);

  for (const [name, candidates] of [
    ['rfdb-server', rfdb],
    ['grafema-orchestrator', orchestrator],
  ] as const) {
    const anchors = (deps.anchors ?? defaultAnchors)(name);
    const spawnPath = (deps.spawnBinary ?? defaultSpawn)(name);
    const spawn: InspectedCandidate | null = spawnPath
      ? {
          path: spawnPath,
          version: readVersion(spawnPath),
          source: candidates.find((c) => c.path === spawnPath)?.source ?? 'unlisted',
        }
      : null;
    anchorsByName[name] = anchors;
    spawnByName[name] = spawn;

    if (candidates.length === 0 && !spawn) {
      missing.push(name);
      continue;
    }

    found.push(
      spawn
        ? `${name} ${spawn.version ?? 'version unreadable'} (spawns from ${spawn.source})`
        : `${name} (found, but nothing would spawn it)`,
    );
    lines.push(
      `  ${name} — actual spawn: ${spawn ? `${spawn.version ?? 'version unreadable'}  ${spawn.path}` : 'nothing resolves'}`,
    );
    lines.push("    (@grafema/util's findBinary — the resolver every spawn site calls)");
    lines.push('  resolution per asking module (node resolution is anchored at the caller):');
    lines.push(...renderAnchors(anchors, spawn?.path ?? null));
    lines.push(`  all candidates seen from here — ${candidates.length}, in resolution order:`);
    lines.push(...renderCandidates(name, candidates));
    problems.push(...divergences(name, candidates, anchors, spawn));
  }

  const details = {
    rfdbServer: spawnByName['rfdb-server']?.path ?? null,
    orchestrator: spawnByName['grafema-orchestrator']?.path ?? null,
    spawn: spawnByName,
    anchors: anchorsByName,
    candidates: { 'rfdb-server': rfdb, 'grafema-orchestrator': orchestrator },
    divergences: problems,
  };

  if (missing.length === 2) {
    return {
      name: 'binaries',
      status: 'fail',
      message: 'Native binaries not found: rfdb-server, grafema-orchestrator',
      recommendation:
        'Install: npm install grafema, or build from source: cd packages/<name> && cargo build --release, or set GRAFEMA_RFDB_SERVER / GRAFEMA_ORCHESTRATOR env vars',
      details,
    };
  }

  if (missing.length === 1) {
    return {
      name: 'binaries',
      status: 'warn',
      message: [`Missing binary: ${missing[0]} (found: ${found[0]})`, ...lines, ...problems.map((p) => `  ! ${p}`)].join('\n'),
      recommendation:
        missing[0] === 'rfdb-server'
          ? 'Set GRAFEMA_RFDB_SERVER env var or build: cd packages/rfdb-server && cargo build --release'
          : 'Set GRAFEMA_ORCHESTRATOR env var or build: cd packages/grafema-orchestrator && cargo build --release',
      details,
    };
  }

  if (problems.length > 0) {
    return {
      name: 'binaries',
      status: 'warn',
      message: [
        `Binaries: ${found.join(', ')} — resolution depends on the asking module`,
        ...lines,
        ...problems.map((p) => `  ! ${p}`),
      ].join('\n'),
      recommendation:
        'Rebuild or reinstall the diverging candidate so every consumer loads the same binary: ' +
        'cd packages/<name> && cargo build --release, then refresh the platform package ' +
        '(packages/grafema-<os>-<arch>/bin/). Until they agree, which binary you get depends on ' +
        'which package made the call.',
      details,
    };
  }

  return {
    name: 'binaries',
    status: 'pass',
    message: [`Binaries: ${found.join(', ')}`, ...lines].join('\n'),
    details,
  };
}

/**
 * Check if .grafema directory exists with config file.
 * FAIL if not initialized.
 */
export async function checkGrafemaInitialized(
  projectPath: string
): Promise<DoctorCheckResult> {
  const grafemaDir = join(projectPath, '.grafema');
  const configYaml = join(grafemaDir, 'config.yaml');
  const configJson = join(grafemaDir, 'config.json');

  if (!existsSync(grafemaDir)) {
    return {
      name: 'initialization',
      status: 'fail',
      message: '.grafema directory not found',
      recommendation: 'Run: grafema init',
    };
  }

  if (!existsSync(configYaml) && !existsSync(configJson)) {
    return {
      name: 'initialization',
      status: 'fail',
      message: 'Config file not found',
      recommendation: 'Run: grafema init',
    };
  }

  const configFile = existsSync(configYaml) ? 'config.yaml' : 'config.json';
  const deprecated = configFile === 'config.json';

  return {
    name: 'initialization',
    status: deprecated ? 'warn' : 'pass',
    message: `Config file: .grafema/${configFile}`,
    recommendation: deprecated ? 'Run: grafema init --force (migrate to YAML)' : undefined,
  };
}

/**
 * Check if RFDB server is running and responsive.
 * WARN if not running (server starts on-demand during analyze).
 */
export async function checkServerStatus(
  projectPath: string
): Promise<DoctorCheckResult> {
  const socketPath = join(projectPath, '.grafema', 'rfdb.sock');

  if (!existsSync(socketPath)) {
    return {
      name: 'server',
      status: 'warn',
      message: 'RFDB server not running',
      recommendation: 'Run: grafema analyze (starts server automatically)',
    };
  }

  const client = new RFDBClient(socketPath, 'cli');
  client.on('error', () => {}); // Suppress error events

  // Tracks whether the server accepted our connection. If `connect()` resolves,
  // a live listener is bound to the socket — so the socket is NOT stale and must
  // not be removed even if a later operation (e.g. `ping`) fails. We capture this
  // in a local rather than reading `client.connected`, because a server that
  // drops the connection flips `client.connected` back to false.
  let serverAccepted = false;

  try {
    await client.connect();
    serverAccepted = true;
    const version = await client.ping();
    await client.close();

    return {
      name: 'server',
      status: 'pass',
      message: `Server: connected (RFDB ${version || 'unknown'})`,
      details: { version, socketPath },
    };
  } catch {
    try { await client.close(); } catch { /* best-effort */ }

    if (serverAccepted) {
      // The server accepted the connection but did not respond to `ping`
      // (e.g. it is busy/starting up, or stalled under RFDB write-lock
      // contention where reads can time out at 60s). The listener is alive, so
      // removing the socket file here would break a healthy server. Report it
      // as unresponsive instead of deleting its socket.
      return {
        name: 'server',
        status: 'warn',
        message: 'RFDB server is running but did not respond to ping (may be busy or starting up).',
        recommendation: 'Wait a moment and retry; if it persists, restart: grafema stop && grafema analyze',
        details: { socketPath },
      };
    }

    // `connect()` failed: nothing is listening on the socket path, so the
    // socket file is a stale leftover from a crashed/stopped server. Remove it.
    try { unlinkSync(socketPath); } catch { /* already gone */ }
    return {
      name: 'server',
      status: 'warn',
      message: 'Stale socket removed. Run grafema analyze to restart server.',
      recommendation: 'Run: grafema analyze (starts fresh server)',
    };
  }
}

// =============================================================================
// Level 2: Configuration Validity
// =============================================================================

/**
 * Validate config file syntax and structure.
 * Uses existing loadConfig() which throws on errors.
 */
export async function checkConfigValidity(
  projectPath: string
): Promise<DoctorCheckResult> {
  try {
    // Silent logger to suppress warnings during validation
    const config = loadConfig(projectPath, { warn: () => {} });

    // Check for unknown plugins
    const unknownPlugins: string[] = [];
    const phases = ['discovery', 'indexing', 'analysis', 'enrichment', 'validation'] as const;

    for (const phase of phases) {
      const plugins = config.plugins[phase] || [];
      for (const name of plugins) {
        if (!VALID_PLUGIN_NAMES.has(name)) {
          unknownPlugins.push(name);
        }
      }
    }

    if (unknownPlugins.length > 0) {
      return {
        name: 'config',
        status: 'warn',
        message: `Plugin(s) not found: ${unknownPlugins.join(', ')} (will be skipped during analysis)`,
        recommendation: 'Check plugin names for typos or add custom plugins to .grafema/plugins/. Run: grafema doctor --verbose for available plugins',
        details: { unknownPlugins },
      };
    }

    const totalPlugins = phases.reduce(
      (sum, phase) => sum + (config.plugins[phase]?.length || 0), 0
    );

    return {
      name: 'config',
      status: 'pass',
      message: `Config valid: ${totalPlugins} plugins configured`,
      details: { pluginCount: totalPlugins, services: config.services.length },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      name: 'config',
      status: 'fail',
      message: `Config error: ${error.message}`,
      recommendation: 'Fix config.yaml syntax or run: grafema init --force',
    };
  }
}

/**
 * Check that entrypoints can be resolved.
 * For config-defined services, validates that entrypoint files exist.
 */
export async function checkEntrypoints(
  projectPath: string
): Promise<DoctorCheckResult> {
  let config;
  try {
    config = loadConfig(projectPath, { warn: () => {} });
  } catch {
    // Config loading failed - already reported by checkConfigValidity
    return {
      name: 'entrypoints',
      status: 'skip',
      message: 'Skipped (config error)',
    };
  }

  if (config.services.length === 0) {
    // Auto-discovery mode - check package.json exists
    const pkgJson = join(projectPath, 'package.json');
    if (!existsSync(pkgJson)) {
      return {
        name: 'entrypoints',
        status: 'warn',
        message: 'No package.json found for auto-discovery',
        recommendation: 'Add package.json or configure services in config.yaml',
      };
    }
    return {
      name: 'entrypoints',
      status: 'pass',
      message: 'Using auto-discovery mode',
    };
  }

  // Config-defined services - validate each
  const issues: string[] = [];
  const valid: string[] = [];

  for (const svc of config.services) {
    const svcPath = join(projectPath, svc.path);
    let entrypoint: string;

    if (svc.entryPoint) {
      entrypoint = join(svcPath, svc.entryPoint);
    } else {
      // Auto-detect from package.json
      const pkgPath = join(svcPath, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          entrypoint = join(svcPath, pkg.main || 'index.js');
        } catch {
          entrypoint = join(svcPath, 'index.js');
        }
      } else {
        entrypoint = join(svcPath, 'index.js');
      }
    }

    if (existsSync(entrypoint)) {
      valid.push(svc.name);
    } else {
      issues.push(`${svc.name}: ${entrypoint} not found`);
    }
  }

  if (issues.length > 0) {
    return {
      name: 'entrypoints',
      status: 'warn',
      message: `${issues.length} service(s) with missing entrypoints`,
      recommendation: 'Check service paths in config.yaml',
      details: { issues, valid },
    };
  }

  return {
    name: 'entrypoints',
    status: 'pass',
    message: `Entrypoints: ${valid.length} service(s) found`,
    details: { services: valid },
  };
}

// =============================================================================
// Level 3: Graph Health
// =============================================================================

/**
 * Check if database file exists and has data.
 */
export async function checkDatabaseExists(
  projectPath: string
): Promise<DoctorCheckResult> {
  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');

  if (!existsSync(dbPath)) {
    return {
      name: 'database',
      status: 'fail',
      message: 'Database not found',
      recommendation: 'Run: grafema analyze',
    };
  }

  // Check file size (empty DB is typically < 100 bytes)
  const stats = statSync(dbPath);
  if (stats.size < 100) {
    return {
      name: 'database',
      status: 'warn',
      message: 'Database appears empty',
      recommendation: 'Run: grafema analyze',
    };
  }

  return {
    name: 'database',
    status: 'pass',
    message: `Database: ${dbPath}`,
    details: { size: stats.size },
  };
}

/**
 * Get graph statistics (requires server running).
 */
export async function checkGraphStats(
  projectPath: string
): Promise<DoctorCheckResult> {
  const socketPath = join(projectPath, '.grafema', 'rfdb.sock');
  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');

  if (!existsSync(socketPath)) {
    return {
      name: 'graph_stats',
      status: 'skip',
      message: 'Server not running (skipped stats check)',
    };
  }

  const backend = new RFDBServerBackend({ dbPath, clientName: 'cli' });
  try {
    await backend.connect();
    const stats = await backend.getStats();
    await backend.close();

    if (stats.nodeCount === 0) {
      return {
        name: 'graph_stats',
        status: 'fail',
        message: 'Database is empty (0 nodes)',
        recommendation: 'Run: grafema analyze',
      };
    }

    return {
      name: 'graph_stats',
      status: 'pass',
      message: `Graph: ${stats.nodeCount.toLocaleString()} nodes, ${stats.edgeCount.toLocaleString()} edges`,
      details: {
        nodeCount: stats.nodeCount,
        edgeCount: stats.edgeCount,
        nodesByType: stats.nodesByType,
        edgesByType: stats.edgesByType,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'graph_stats',
      status: 'warn',
      message: `Could not read graph stats: ${message}`,
    };
  }
}

/**
 * Check graph connectivity - find disconnected nodes.
 * Thresholds:
 *   0-5%: pass (normal for external modules)
 *   5-20%: warn
 *   >20%: fail (critical issue)
 */
export async function checkConnectivity(
  projectPath: string
): Promise<DoctorCheckResult> {
  const socketPath = join(projectPath, '.grafema', 'rfdb.sock');
  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');

  if (!existsSync(socketPath)) {
    return {
      name: 'connectivity',
      status: 'skip',
      message: 'Server not running (skipped connectivity check)',
    };
  }

  const backend = new RFDBServerBackend({ dbPath, clientName: 'cli' });
  try {
    await backend.connect();

    // Get all nodes
    const allNodes: Array<{ id: string; type: string }> = [];
    for await (const node of backend.queryNodes({})) {
      allNodes.push({ id: node.id, type: node.type as string });
    }
    const totalCount = allNodes.length;

    if (totalCount === 0) {
      await backend.close();
      return {
        name: 'connectivity',
        status: 'skip',
        message: 'No nodes to check',
      };
    }

    // Find root nodes (SERVICE, MODULE, PROJECT)
    const rootTypes = ['SERVICE', 'MODULE', 'PROJECT'];
    const rootNodes = allNodes.filter(n => rootTypes.includes(n.type));

    if (rootNodes.length === 0) {
      await backend.close();
      return {
        name: 'connectivity',
        status: 'warn',
        message: 'No root nodes found (SERVICE/MODULE/PROJECT)',
        recommendation: 'Run: grafema analyze',
      };
    }

    // Get all edges and build adjacency
    const allEdges = await backend.getAllEdges();

    const adjacencyOut = new Map<string, string[]>();
    const adjacencyIn = new Map<string, string[]>();

    for (const edge of allEdges) {
      if (!adjacencyOut.has(edge.src)) adjacencyOut.set(edge.src, []);
      adjacencyOut.get(edge.src)!.push(edge.dst);
      if (!adjacencyIn.has(edge.dst)) adjacencyIn.set(edge.dst, []);
      adjacencyIn.get(edge.dst)!.push(edge.src);
    }

    // BFS from roots
    const reachable = new Set<string>();
    const queue = [...rootNodes.map(n => n.id)];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      const outgoing = adjacencyOut.get(nodeId) || [];
      const incoming = adjacencyIn.get(nodeId) || [];
      for (const targetId of [...outgoing, ...incoming]) {
        if (!reachable.has(targetId)) queue.push(targetId);
      }
    }

    await backend.close();

    const unreachableCount = totalCount - reachable.size;
    const percentage = (unreachableCount / totalCount) * 100;

    if (unreachableCount === 0) {
      return {
        name: 'connectivity',
        status: 'pass',
        message: 'All nodes connected',
        details: { totalNodes: totalCount },
      };
    }

    // Group unreachable by type
    const unreachableNodes = allNodes.filter(n => !reachable.has(n.id));
    const byType: Record<string, number> = {};
    for (const node of unreachableNodes) {
      byType[node.type] = (byType[node.type] || 0) + 1;
    }

    if (percentage > 20) {
      return {
        name: 'connectivity',
        status: 'fail',
        message: `Critical: ${unreachableCount} disconnected nodes (${percentage.toFixed(1)}%)`,
        recommendation: 'Run: grafema analyze --clear (rebuild graph)',
        details: { unreachableCount, percentage, byType },
      };
    }

    if (percentage > 5) {
      return {
        name: 'connectivity',
        status: 'warn',
        message: `${unreachableCount} disconnected nodes (${percentage.toFixed(1)}%)`,
        recommendation: 'Run: grafema analyze --clear (may fix)',
        details: { unreachableCount, percentage, byType },
      };
    }

    return {
      name: 'connectivity',
      status: 'pass',
      message: `${unreachableCount} disconnected nodes (${percentage.toFixed(1)}% - normal)`,
      details: { unreachableCount, percentage, byType },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'connectivity',
      status: 'warn',
      message: `Could not check connectivity: ${message}`,
    };
  }
}

/**
 * Check if graph is fresh (no stale modules).
 */
export async function checkFreshness(
  projectPath: string
): Promise<DoctorCheckResult> {
  const socketPath = join(projectPath, '.grafema', 'rfdb.sock');
  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');

  if (!existsSync(socketPath)) {
    return {
      name: 'freshness',
      status: 'skip',
      message: 'Server not running (skipped freshness check)',
    };
  }

  const backend = new RFDBServerBackend({ dbPath, clientName: 'cli' });
  try {
    await backend.connect();
    const freshnessChecker = new GraphFreshnessChecker();
    const result = await freshnessChecker.checkFreshness(backend, projectPath);
    await backend.close();

    if (result.isFresh) {
      return {
        name: 'freshness',
        status: 'pass',
        message: 'Graph is up to date',
      };
    }

    return {
      name: 'freshness',
      status: 'warn',
      message: `${result.staleCount} stale module(s) detected`,
      recommendation: 'Run: grafema analyze (or grafema check for auto-reanalysis)',
      details: {
        staleCount: result.staleCount,
        staleModules: result.staleModules.slice(0, 5).map(m => m.file),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'freshness',
      status: 'warn',
      message: `Could not check freshness: ${message}`,
    };
  }
}

// =============================================================================
// Level 4: Informational
// =============================================================================

/**
 * Collect version information (always passes).
 */
export async function checkVersions(
  projectPath: string
): Promise<DoctorCheckResult> {
  let cliVersion = 'unknown';
  let coreVersion = 'unknown';
  let rfdbVersion: string | undefined;

  // Read CLI version - from dist/commands/doctor/ go up 3 levels to cli/
  try {
    const cliPkgPath = join(__dirname, '../../../package.json');
    const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf-8'));
    cliVersion = cliPkg.version;
  } catch {
    // Ignore errors
  }

  // Read core version
  try {
    const require = createRequire(import.meta.url);
    const corePkgPath = require.resolve('@grafema/util/package.json');
    const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf-8'));
    coreVersion = corePkg.version;
  } catch {
    // Ignore errors
  }

  // Get RFDB version from server if running
  const socketPath = join(projectPath, '.grafema', 'rfdb.sock');
  if (existsSync(socketPath)) {
    const client = new RFDBClient(socketPath, 'cli');
    client.on('error', () => {});
    try {
      await client.connect();
      const version = await client.ping();
      rfdbVersion = version || undefined;
      await client.close();
    } catch {
      // Ignore errors
    }
  }

  return {
    name: 'versions',
    status: 'pass',
    message: `CLI ${cliVersion}, Core ${coreVersion}${rfdbVersion ? `, RFDB ${rfdbVersion}` : ''}`,
    details: { cli: cliVersion, core: coreVersion, rfdb: rfdbVersion },
  };
}

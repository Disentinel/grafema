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

/** Injection points so the divergence report can be exercised on a fixture. */
export interface CheckBinariesDeps {
  listCandidates?: (binaryName: BinaryName) => BinaryCandidate[];
  readVersion?: (path: string) => string | null;
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
 * The shared candidate list, asked with the CLI's anchor for the platform
 * package. Never shorter than `listBinaryCandidates(name)` — a diagnostic that
 * sees fewer places than the resolver is how this defect stayed invisible.
 */
export function listCandidatesForDoctor(binaryName: BinaryName): BinaryCandidate[] {
  return listBinaryCandidates(binaryName, {}, {
    platformPackagePath: (n) => platformPackageForDoctor(n) ?? resolvePlatformPackageBinary(n),
  });
}

function inspect(
  binaryName: BinaryName,
  deps: CheckBinariesDeps,
): InspectedCandidate[] {
  const list = deps.listCandidates ?? listCandidatesForDoctor;
  const readVersion = deps.readVersion ?? readBinaryVersion;
  return list(binaryName).map((c) => ({ ...c, version: readVersion(c.path) }));
}

/** One candidate per line, winner first and marked. */
function renderCandidates(binaryName: BinaryName, candidates: InspectedCandidate[]): string[] {
  return candidates.map((c, i) => {
    const marker = i === 0 ? '→' : ' ';
    return `  ${marker} ${binaryName} ${c.version ?? 'version unreadable'}  ${c.source}  ${c.path}`;
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
function divergences(binaryName: BinaryName, candidates: InspectedCandidate[]): string[] {
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
        `${[...versions].join(' vs ')} — the first candidate (${candidates[0].source}) wins`,
    );
  }

  return problems;
}

/**
 * Check that the native binaries (rfdb-server, grafema-orchestrator) are
 * findable AND that every place they are findable from agrees.
 *
 * FAIL if both missing, WARN if one is missing or any candidate diverges,
 * PASS otherwise. Candidates are always listed, with versions: printing only
 * the winner is what let a three-month-old rfdb-server serve consumers while
 * doctor reported the fresh monorepo build.
 */
export async function checkBinaries(deps: CheckBinariesDeps = {}): Promise<DoctorCheckResult> {
  const rfdb = inspect('rfdb-server', deps);
  const orchestrator = inspect('grafema-orchestrator', deps);

  const found: string[] = [];
  const missing: string[] = [];
  const lines: string[] = [];
  const problems: string[] = [];

  for (const [name, candidates] of [
    ['rfdb-server', rfdb],
    ['grafema-orchestrator', orchestrator],
  ] as const) {
    if (candidates.length === 0) {
      missing.push(name);
      continue;
    }
    const winner = candidates[0];
    found.push(`${name} ${winner.version ?? 'version unreadable'} (${winner.source})`);
    lines.push(`  ${name} — ${candidates.length} candidate(s), in resolution order:`);
    lines.push(...renderCandidates(name, candidates));
    problems.push(...divergences(name, candidates));
  }

  const details = {
    rfdbServer: rfdb[0]?.path ?? null,
    orchestrator: orchestrator[0]?.path ?? null,
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
        `Binaries: ${found.join(', ')} — version divergence`,
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

/**
 * Unified binary lookup for Grafema native binaries.
 *
 * Used by CLI, MCP server, and the unified grafema package.
 * Finds rfdb-server, grafema-orchestrator, or any binary by name.
 *
 * Search order (ONE order, defined by listBinaryCandidates; findBinary is its
 * first element and every diagnostic reports the same list — REG-1198):
 * 1. Explicit path (from config or flag)
 * 2. Environment variable (GRAFEMA_RFDB_SERVER / GRAFEMA_ORCHESTRATOR)
 * 3. Platform package (@grafema/grafema-{os}-{arch})
 * 4. Monorepo target/release (development)
 * 5. Monorepo target/debug (development)
 * 6. System PATH lookup
 * 7. ~/.grafema/bin/ (lazy-downloaded analyzers)
 * 8. ~/.local/bin/ (user-installed)
 * 9. @grafema/rfdb legacy prebuilt (rfdb-server only)
 */

import { existsSync } from 'fs';
import { join, delimiter, dirname, resolve } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type BinaryName = 'rfdb-server' | 'grafema-orchestrator';

export interface FindBinaryOptions {
  /** Explicit path to binary (highest priority) */
  explicitPath?: string;
  /** Base directory for monorepo search (defaults to auto-detect) */
  monorepoRoot?: string;
}

interface BinaryConfig {
  envVar: string;
  monorepoPackage: string;
}

const BINARY_CONFIG: Record<BinaryName, BinaryConfig> = {
  'rfdb-server': {
    envVar: 'GRAFEMA_RFDB_SERVER',
    monorepoPackage: 'rfdb-server',
  },
  'grafema-orchestrator': {
    envVar: 'GRAFEMA_ORCHESTRATOR',
    monorepoPackage: 'grafema-orchestrator',
  },
};

/**
 * Get platform directory name for prebuilt binaries.
 * E.g., "darwin-arm64", "linux-x64"
 */
export function getPlatformDir(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  } else if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  }
  return `${platform}-${arch}`;
}

/**
 * Get platform package name for the current OS/arch.
 * E.g., "@grafema/grafema-darwin-arm64"
 */
export function getPlatformPackageName(): string {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `@grafema/grafema-${platform}-${arch}`;
}

/**
 * Try to load the platform package and get a binary path from it.
 *
 * Exported because node resolution is anchored at the asking module: a caller
 * that can see `@grafema/grafema-{os}-{arch}` when this module cannot needs to
 * supply its own anchor and still fall back to this one (REG-1198).
 */
export function resolvePlatformPackageBinary(binaryName: BinaryName): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgName = getPlatformPackageName();
    const pkg = require(pkgName);

    if (binaryName === 'rfdb-server' && pkg.rfdbServerPath) {
      const p = pkg.rfdbServerPath;
      if (existsSync(p)) return p;
    }
    if (binaryName === 'grafema-orchestrator' && pkg.orchestratorPath) {
      const p = pkg.orchestratorPath;
      if (existsSync(p)) return p;
    }

    // Fallback: try binDir + binaryName
    if (pkg.binDir) {
      const p = join(pkg.binDir, binaryName);
      if (existsSync(p)) return p;
    }
  } catch {
    // Platform package not installed
  }
  return null;
}

/**
 * Find monorepo root by looking for characteristic files.
 */
function findMonorepoRoot(startDir?: string): string | null {
  // Walk up from provided dir or this file's location
  let dir = startDir || join(__dirname, '..', '..', '..', '..');
  for (let i = 0; i < 8; i++) {
    const hasPackagesDir = existsSync(join(dir, 'packages', 'util'));
    const hasPnpmWorkspace = existsSync(join(dir, 'pnpm-workspace.yaml'));
    if (hasPackagesDir && hasPnpmWorkspace) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Try GRAFEMA_ROOT env var
  const envRoot = process.env.GRAFEMA_ROOT;
  if (envRoot && existsSync(join(envRoot, 'packages', 'util'))) {
    return envRoot;
  }

  return null;
}

/**
 * One place a binary can come from.
 *
 * `source` is the human-readable label diagnostics print; it is the same label
 * for the same step regardless of who asks.
 */
export interface BinaryCandidate {
  source: string;
  path: string;
}

/** Injection points, used by tests to stand up a candidate set on disk. */
export interface ListBinaryCandidatesDeps {
  existsSync?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
  /** Resolve the platform package's binary, or null when it is not installed. */
  platformPackagePath?: (binaryName: BinaryName) => string | null;
  /** Resolve the legacy @grafema/rfdb prebuilt path, or null. */
  legacyRfdbPath?: (binaryName: BinaryName) => string | null;
}

/**
 * Legacy @grafema/rfdb npm package (old prebuilt location).
 */
function tryLegacyRfdbPackage(binaryName: BinaryName): string | null {
  if (binaryName !== 'rfdb-server') return null;
  try {
    const require = createRequire(import.meta.url);
    const rfdbPkg = require.resolve('@grafema/rfdb');
    const rfdbDir = dirname(rfdbPkg);
    const npmBinary = join(rfdbDir, 'prebuilt', getPlatformDir(), 'rfdb-server');
    if (existsSync(npmBinary)) return npmBinary;
  } catch {
    // @grafema/rfdb not installed
  }
  return null;
}

/**
 * EVERY place this binary is currently findable, in resolution order.
 *
 * REG-1198: the resolution order used to exist twice — here, and again inside
 * `grafema doctor`, in the opposite order and without the platform package.
 * Both answers were true of their own path, so consumers loaded rfdb-server
 * 0.3.28 out of the platform package while doctor cheerfully reported
 * "monorepo (release)". A diagnostic that walks a different path from the code
 * it diagnoses can only agree with itself, so the order lives here once and
 * `findBinary` is defined as "the first of these".
 *
 * The list does NOT stop at the winner: a second candidate is exactly what a
 * silent version divergence looks like, and callers cannot report what the
 * resolver never told them about.
 */
export function listBinaryCandidates(
  binaryName: BinaryName,
  options: FindBinaryOptions = {},
  deps: ListBinaryCandidatesDeps = {},
): BinaryCandidate[] {
  const config = BINARY_CONFIG[binaryName];
  const _existsSync = deps.existsSync ?? existsSync;
  const env = deps.env ?? process.env;
  const _platformPackagePath = deps.platformPackagePath ?? resolvePlatformPackageBinary;
  const _legacyRfdbPath = deps.legacyRfdbPath ?? tryLegacyRfdbPackage;

  const candidates: BinaryCandidate[] = [];
  const add = (source: string, path: string | null | undefined): void => {
    if (!path) return;
    if (candidates.some((c) => c.path === path)) return;
    candidates.push({ source, path });
  };

  // 1. Explicit path (from config or flag) — no fallback, by design: an
  //    explicit path that does not exist is an error, not an invitation to
  //    search elsewhere.
  if (options.explicitPath) {
    const resolved = resolve(options.explicitPath);
    return _existsSync(resolved) ? [{ source: 'explicit path', path: resolved }] : [];
  }

  // 2. Environment variable
  const envPath = env[config.envVar];
  if (envPath && _existsSync(envPath)) {
    add(`$${config.envVar}`, envPath);
  }

  // 3. Platform package (@grafema/grafema-{os}-{arch})
  add(`platform package ${getPlatformPackageName()}`, _platformPackagePath(binaryName));

  // 4-5. Monorepo development builds
  const monorepoRoot = findMonorepoRoot(options.monorepoRoot);
  if (monorepoRoot) {
    for (const profile of ['release', 'debug']) {
      const p = join(monorepoRoot, 'packages', config.monorepoPackage, 'target', profile, binaryName);
      if (_existsSync(p)) add(`monorepo (${profile})`, p);
    }
  }

  // 6. System PATH lookup
  const pathDirs = (env.PATH || '').split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const p = join(dir, binaryName);
    if (_existsSync(p)) add('PATH', p);
  }

  // 7. ~/.grafema/bin/ (lazy-downloaded analyzers)
  const home = env.HOME || env.USERPROFILE || '';
  if (home) {
    const p = join(home, '.grafema', 'bin', binaryName);
    if (_existsSync(p)) add('~/.grafema/bin', p);
  }

  // 8. ~/.local/bin/ (user-installed)
  if (home) {
    const p = join(home, '.local', 'bin', binaryName);
    if (_existsSync(p)) add('~/.local/bin', p);
  }

  // 9. Legacy: @grafema/rfdb npm package (old prebuilt location)
  add('@grafema/rfdb (legacy prebuilt)', _legacyRfdbPath(binaryName));

  return candidates;
}

/**
 * Find a Grafema native binary.
 *
 * Defined as the first candidate of {@link listBinaryCandidates}, so nothing
 * can consult a different order than the one diagnostics report.
 *
 * @param binaryName - Which binary to find
 * @param options - Search options
 * @returns Absolute path to the binary, or null if not found
 */
export function findBinary(binaryName: BinaryName, options: FindBinaryOptions = {}): string | null {
  return listBinaryCandidates(binaryName, options)[0]?.path ?? null;
}

/**
 * Find rfdb-server binary.
 *
 * @param options - Search options
 * @returns Path to binary or null if not found
 */
export function findRfdbBinary(options: FindBinaryOptions = {}): string | null {
  return findBinary('rfdb-server', options);
}

/**
 * Find grafema-orchestrator binary.
 *
 * @param options - Search options
 * @returns Path to binary or null if not found
 */
export function findOrchestratorBinary(options: FindBinaryOptions = {}): string | null {
  return findBinary('grafema-orchestrator', options);
}

/**
 * Find an analyzer binary by name (e.g. "grafema-analyzer", "haskell-resolve").
 *
 * Simpler search than findBinary() — no env var or platform package lookup.
 * Search order: ~/.grafema/bin/, ~/.local/bin/, ~/.cabal/bin/, system PATH.
 */
export function findAnalyzerBinary(binaryName: string): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || '';

  // ~/.grafema/bin/ (lazy-downloaded)
  if (home) {
    const p = join(home, '.grafema', 'bin', binaryName);
    if (existsSync(p)) return p;
  }

  // ~/.local/bin/
  if (home) {
    const p = join(home, '.local', 'bin', binaryName);
    if (existsSync(p)) return p;
  }

  // ~/.cabal/bin/ (Haskell builds)
  if (home) {
    const p = join(home, '.cabal', 'bin', binaryName);
    if (existsSync(p)) return p;
  }

  // System PATH
  const pathDirs = (process.env.PATH || '').split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const p = join(dir, binaryName);
    if (existsSync(p)) return p;
  }

  return null;
}

/**
 * Get human-readable error message when binary not found.
 */
export function getBinaryNotFoundMessage(binaryName?: BinaryName): string {
  const name = binaryName || 'rfdb-server';
  const config = BINARY_CONFIG[name];
  const platformDir = getPlatformDir();

  return `${name} binary not found for ${platformDir}

Options:
1. Install the grafema package (includes all binaries):
   npm install grafema

2. Set environment variable:
   export ${config.envVar}=/path/to/${name}

3. Build from source:
   cd packages/${config.monorepoPackage} && cargo build --release

4. Install to system PATH or ~/.local/bin:
   cp target/release/${name} ~/.local/bin/
`;
}

/**
 * Unified binary lookup for Grafema native binaries.
 *
 * Used by CLI, MCP server, and the unified grafema package.
 * Finds rfdb-server, grafema-orchestrator, or any binary by name.
 *
 * Search order:
 * 1. Explicit path (from config or flag)
 * 2. Environment variable (GRAFEMA_RFDB_SERVER / GRAFEMA_ORCHESTRATOR)
 * 3. Platform package (@grafema/grafema-{os}-{arch})
 * 4. Monorepo target/release (development)
 * 5. Monorepo target/debug (development)
 * 6. System PATH lookup
 * 7. ~/.local/bin/ (user-installed)
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
 */
function tryPlatformPackage(binaryName: BinaryName): string | null {
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
 * Find a Grafema native binary.
 *
 * @param binaryName - Which binary to find
 * @param options - Search options
 * @returns Absolute path to the binary, or null if not found
 */
export function findBinary(binaryName: BinaryName, options: FindBinaryOptions = {}): string | null {
  const config = BINARY_CONFIG[binaryName];

  // 1. Explicit path (from config or flag) — no fallback
  if (options.explicitPath) {
    const resolved = resolve(options.explicitPath);
    return existsSync(resolved) ? resolved : null;
  }

  // 2. Environment variable
  const envPath = process.env[config.envVar];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // 3. Platform package (@grafema/grafema-{os}-{arch})
  const platformPath = tryPlatformPackage(binaryName);
  if (platformPath) return platformPath;

  // 4-5. Monorepo development builds
  const monorepoRoot = findMonorepoRoot(options.monorepoRoot);
  if (monorepoRoot) {
    for (const profile of ['release', 'debug']) {
      const p = join(monorepoRoot, 'packages', config.monorepoPackage, 'target', profile, binaryName);
      if (existsSync(p)) return p;
    }
  }

  // 6. System PATH lookup
  const pathDirs = (process.env.PATH || '').split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const p = join(dir, binaryName);
    if (existsSync(p)) return p;
  }

  // 7. ~/.local/bin/ (user-installed)
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    const p = join(home, '.local', 'bin', binaryName);
    if (existsSync(p)) return p;
  }

  // Legacy: @grafema/rfdb npm package (old prebuilt location)
  if (binaryName === 'rfdb-server') {
    try {
      const require = createRequire(import.meta.url);
      const rfdbPkg = require.resolve('@grafema/rfdb');
      const rfdbDir = dirname(rfdbPkg);
      const platformDir = getPlatformDir();
      const npmBinary = join(rfdbDir, 'prebuilt', platformDir, 'rfdb-server');
      if (existsSync(npmBinary)) {
        return npmBinary;
      }
    } catch {
      // @grafema/rfdb not installed
    }
  }

  return null;
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

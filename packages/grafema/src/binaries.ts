/**
 * Unified binary lookup for Grafema native binaries.
 *
 * Replaces 3 separate findOrchestratorBinary / findRfdbBinary implementations
 * with a single module. Search order:
 *
 * 1. Environment variable (GRAFEMA_RFDB_SERVER / GRAFEMA_ORCHESTRATOR)
 * 2. Platform package (@grafema/grafema-{os}-{arch})
 * 3. Monorepo target/release (development)
 * 4. Monorepo target/debug (development)
 * 5. System $PATH
 * 6. ~/.local/bin/
 */

import { existsSync } from 'fs';
import { join, delimiter, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type BinaryName = 'rfdb-server' | 'grafema-orchestrator';

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
 * Get platform package name for the current OS/arch.
 * E.g., "@grafema/grafema-darwin-arm64"
 */
export function getPlatformPackageName(): string {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `@grafema/grafema-${platform}-${arch}`;
}

/**
 * Try to load the platform package and get binary paths from it.
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
function findMonorepoRoot(): string | null {
  // Walk up from this file's location
  let dir = __dirname;
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
 * @param explicitPath - If provided, use this path (highest priority, no fallback)
 * @returns Absolute path to the binary, or null if not found
 */
export function findBinary(binaryName: BinaryName, explicitPath?: string): string | null {
  // 0. Explicit path (from config/flag) — no fallback
  if (explicitPath) {
    return existsSync(explicitPath) ? explicitPath : null;
  }

  const config = BINARY_CONFIG[binaryName];

  // 1. Environment variable
  const envPath = process.env[config.envVar];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // 2. Platform package (@grafema/grafema-{os}-{arch})
  const platformPath = tryPlatformPackage(binaryName);
  if (platformPath) return platformPath;

  // 3-4. Monorepo development builds
  const monorepoRoot = findMonorepoRoot();
  if (monorepoRoot) {
    for (const profile of ['release', 'debug']) {
      const p = join(monorepoRoot, 'packages', config.monorepoPackage, 'target', profile, binaryName);
      if (existsSync(p)) return p;
    }
  }

  // 5. System PATH
  const pathDirs = (process.env.PATH || '').split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const p = join(dir, binaryName);
    if (existsSync(p)) return p;
  }

  // 6. ~/.local/bin
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    const p = join(home, '.local', 'bin', binaryName);
    if (existsSync(p)) return p;
  }

  return null;
}

/**
 * Find rfdb-server binary. Convenience wrapper around findBinary.
 */
export function findRfdbServerBinary(explicitPath?: string): string | null {
  return findBinary('rfdb-server', explicitPath);
}

/**
 * Find grafema-orchestrator binary. Convenience wrapper around findBinary.
 */
export function findOrchestratorBinary(explicitPath?: string): string | null {
  return findBinary('grafema-orchestrator', explicitPath);
}

/**
 * Get human-readable error message when a binary is not found.
 */
export function getBinaryNotFoundMessage(binaryName: BinaryName): string {
  const config = BINARY_CONFIG[binaryName];
  const pkgName = getPlatformPackageName();

  return `${binaryName} binary not found.

Options:
  1. Install the grafema package (includes binaries):
     npm install grafema

  2. Set environment variable:
     export ${config.envVar}=/path/to/${binaryName}

  3. Build from source:
     cd packages/${config.monorepoPackage} && cargo build --release

  4. Install to PATH:
     cp target/release/${binaryName} ~/.local/bin/

Platform package expected: ${pkgName}
`;
}

/**
 * Shared utility for finding rfdb-server binary
 *
 * Used by:
 * - RFDBServerBackend (core)
 * - CLI server command
 * - VS Code extension
 * - rfdb-server bin wrapper
 *
 * Search order:
 * 1. Explicit path (from config or flag)
 * 2. GRAFEMA_RFDB_SERVER environment variable
 * 3. Monorepo target/release (development)
 * 4. Monorepo target/debug (development)
 * 5. @grafema/rfdb npm package (prebuilt)
 * 6. ~/.local/bin/rfdb-server (user-installed)
 */

import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface FindBinaryOptions {
  /** Explicit path to binary (highest priority) */
  explicitPath?: string;
  /** Base directory for monorepo search (defaults to auto-detect) */
  monorepoRoot?: string;
}

/**
 * Get platform directory name for prebuilt binaries
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
 * Find rfdb-server binary using standard search order
 *
 * @param options - Search options
 * @returns Path to binary or null if not found
 */
export function findRfdbBinary(options: FindBinaryOptions = {}): string | null {
  // 1. Explicit path (from config or --binary flag)
  if (options.explicitPath) {
    const resolved = resolve(options.explicitPath);
    if (existsSync(resolved)) {
      return resolved;
    }
    // Explicit path was given but not found - don't fallback
    return null;
  }

  // 2. Environment variable
  const envBinary = process.env.GRAFEMA_RFDB_SERVER;
  if (envBinary && existsSync(envBinary)) {
    return envBinary;
  }

  // 3-4. Monorepo development builds
  const monorepoRoot = options.monorepoRoot || findMonorepoRoot();
  if (monorepoRoot) {
    const releaseBinary = join(monorepoRoot, 'packages', 'rfdb-server', 'target', 'release', 'rfdb-server');
    if (existsSync(releaseBinary)) {
      return releaseBinary;
    }

    const debugBinary = join(monorepoRoot, 'packages', 'rfdb-server', 'target', 'debug', 'rfdb-server');
    if (existsSync(debugBinary)) {
      return debugBinary;
    }
  }

  // 5. @grafema/rfdb npm package
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

  // 6. User-installed binary in ~/.local/bin
  const homeBinary = join(process.env.HOME || '', '.local', 'bin', 'rfdb-server');
  if (existsSync(homeBinary)) {
    return homeBinary;
  }

  return null;
}

/**
 * Find monorepo root by looking for characteristic files
 */
function findMonorepoRoot(): string | null {
  // Start from this file's location and walk up
  const searchPaths = [
    // From packages/core/src/utils -> packages/core -> packages -> root
    join(__dirname, '..', '..', '..', '..'),
    // Common development locations
    process.env.GRAFEMA_ROOT,
  ].filter(Boolean) as string[];

  for (const candidate of searchPaths) {
    // Check for grafema monorepo markers
    const hasPackagesDir = existsSync(join(candidate, 'packages', 'core'));
    const hasRfdbServer = existsSync(join(candidate, 'packages', 'rfdb-server', 'Cargo.toml'));
    if (hasPackagesDir && hasRfdbServer) {
      return candidate;
    }
  }

  return null;
}

/**
 * Get human-readable error message when binary not found
 */
export function getBinaryNotFoundMessage(): string {
  const platformDir = getPlatformDir();
  return `RFDB server binary not found for ${platformDir}

Options:
1. Specify path: grafema server start --binary /path/to/rfdb-server

2. Add to config.yaml:
   server:
     binaryPath: /path/to/rfdb-server

3. Set environment variable:
   export GRAFEMA_RFDB_SERVER=/path/to/rfdb-server

4. Build from source and install:
   git clone https://github.com/Disentinel/grafema.git
   cd grafema/packages/rfdb-server
   cargo build --release
   mkdir -p ~/.local/bin
   cp target/release/rfdb-server ~/.local/bin/

5. Install prebuilt (if available for your platform):
   npm install @grafema/rfdb
`;
}

/**
 * Binary lookup for the unified `grafema` package.
 *
 * REG-1198: this file used to carry its own copy of the search order — the
 * third one in the repo, next to `packages/util/src/utils/findRfdbBinary.ts`
 * and an inlined one in `grafema doctor`. Three copies drifted: doctor put the
 * monorepo builds first and never looked at the platform package, so it
 * reported "monorepo (release)" while consumers were being handed
 * rfdb-server 0.3.28 out of `@grafema/grafema-darwin-x64`.
 *
 * The order now lives once, in @grafema/util. What legitimately differs here
 * is only WHERE the platform package is resolved from: this package declares
 * `@grafema/grafema-{os}-{arch}` among its own optional dependencies, so it
 * must resolve it against ITS module location — @grafema/util cannot see it
 * from inside the monorepo. That anchor is injected; the order is not.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import {
  listBinaryCandidates,
  getPlatformPackageName,
  type BinaryName,
  type BinaryCandidate,
} from '@grafema/util';

export type { BinaryName };
export { getPlatformPackageName };

/**
 * Resolve the platform package from THIS package's node_modules.
 */
function tryPlatformPackage(binaryName: BinaryName): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require(getPlatformPackageName());

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
 * Every place this binary is findable from the unified package, in the shared
 * resolution order.
 */
export function listBinaries(binaryName: BinaryName, explicitPath?: string): BinaryCandidate[] {
  return listBinaryCandidates(binaryName, { explicitPath }, { platformPackagePath: tryPlatformPackage });
}

/**
 * Find a Grafema native binary.
 *
 * @param binaryName - Which binary to find
 * @param explicitPath - If provided, use this path (highest priority, no fallback)
 * @returns Absolute path to the binary, or null if not found
 */
export function findBinary(binaryName: BinaryName, explicitPath?: string): string | null {
  return listBinaries(binaryName, explicitPath)[0]?.path ?? null;
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
  const envVar =
    binaryName === 'rfdb-server' ? 'GRAFEMA_RFDB_SERVER' : 'GRAFEMA_ORCHESTRATOR';
  const pkgName = getPlatformPackageName();

  return `${binaryName} binary not found.

Options:
  1. Install the grafema package (includes binaries):
     npm install grafema

  2. Set environment variable:
     export ${envVar}=/path/to/${binaryName}

  3. Build from source:
     cd packages/${binaryName} && cargo build --release

  4. Install to PATH:
     cp target/release/${binaryName} ~/.local/bin/

Platform package expected: ${pkgName}
`;
}

/**
 * Resolves TypeScript source entrypoints for projects.
 *
 * This utility prefers TypeScript source files (src/index.ts) over compiled
 * output (dist/index.js) when analyzing TypeScript projects.
 *
 * Resolution order:
 * 1. If no tsconfig.json exists -> return null (not a TypeScript project)
 * 2. Check package.json "source" field (explicit source declaration)
 * 3. Try standard TypeScript source candidates
 * 4. Return null if no source found (caller should fallback to main)
 *
 * @module resolveSourceEntrypoint
 */

import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Package.json fields relevant for source resolution
 */
export interface PackageJsonForResolution {
  main?: string;
  source?: string;  // Used by bundlers like Parcel
}

/**
 * Standard TypeScript source candidates in priority order.
 *
 * Order rationale:
 * - src/ is the most common convention
 * - lib/ is used by some projects
 * - root-level is fallback
 * - index is more common than main
 * - .ts preferred over .tsx over .mts
 */
const TS_SOURCE_CANDIDATES = [
  'src/index.ts',
  'src/index.tsx',
  'src/index.mts',
  'src/main.ts',
  'src/main.tsx',
  'lib/index.ts',
  'lib/index.tsx',
  'index.ts',
  'index.tsx',
  'index.mts',
  'main.ts',
  'main.tsx',
] as const;

/**
 * Resolves the source entrypoint for a project, preferring TypeScript source
 * over compiled output.
 *
 * @param projectPath - Absolute path to the project/service directory
 * @param packageJson - Parsed package.json content (only relevant fields needed)
 * @returns Source entrypoint relative to projectPath, or null if not found
 *
 * @example
 * // TypeScript project with src/index.ts
 * resolveSourceEntrypoint('/path/to/project', { main: 'dist/index.js' })
 * // Returns: 'src/index.ts'
 *
 * @example
 * // JavaScript project (no tsconfig.json)
 * resolveSourceEntrypoint('/path/to/project', { main: 'index.js' })
 * // Returns: null
 *
 * @example
 * // TypeScript project with explicit source field
 * resolveSourceEntrypoint('/path/to/project', { main: 'dist/index.js', source: 'lib/entry.ts' })
 * // Returns: 'lib/entry.ts' (if file exists)
 */
export function resolveSourceEntrypoint(
  projectPath: string,
  packageJson: PackageJsonForResolution
): string | null {
  // Step 1: Check for TypeScript project indicator
  const tsconfigPath = join(projectPath, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return null; // Not a TypeScript project
  }

  // Step 2: Check package.json "source" field (explicit source declaration)
  if (packageJson.source) {
    const sourcePath = join(projectPath, packageJson.source);
    if (existsSync(sourcePath)) {
      return packageJson.source;
    }
  }

  // Step 3: Try standard TypeScript source candidates
  for (const candidate of TS_SOURCE_CANDIDATES) {
    const candidatePath = join(projectPath, candidate);
    if (existsSync(candidatePath)) {
      return candidate;
    }
  }

  // Step 4: Not found - caller should fallback to main
  return null;
}

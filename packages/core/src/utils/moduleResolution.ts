/**
 * Module Resolution Utilities (REG-320)
 *
 * Unified module path resolution logic extracted from:
 * - MountPointResolver.resolveImportSource()
 * - JSModuleIndexer.resolveModulePath()
 * - FunctionCallResolver._resolveImportPath()
 * - IncrementalModuleIndexer.tryResolve()
 *
 * Provides consistent module resolution across all plugins.
 */

import { existsSync, statSync } from 'fs';
import { dirname, resolve, join } from 'path';

/**
 * Default file extensions to try when resolving modules.
 * Order: exact match first, then JS variants, then TS variants.
 */
export const DEFAULT_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];

/**
 * Default index files to try when resolving directory imports.
 * Order: JS variants first (most common), then TS variants.
 */
export const DEFAULT_INDEX_FILES = [
  'index.js',
  'index.ts',
  'index.mjs',
  'index.cjs',
  'index.jsx',
  'index.tsx'
];

/**
 * Options for module path resolution.
 *
 * @example Filesystem mode (default)
 * ```ts
 * resolveModulePath('/app/utils')
 * // → '/app/utils.js' if exists
 * ```
 *
 * @example In-memory mode (for enrichment plugins)
 * ```ts
 * resolveModulePath('/app/utils', {
 *   useFilesystem: false,
 *   fileIndex: new Set(['/app/utils.ts'])
 * })
 * // → '/app/utils.ts'
 * ```
 */
export interface ModuleResolutionOptions {
  /**
   * Use filesystem for path verification.
   * Default: true
   *
   * When true: uses existsSync() to check if files exist
   * When false: uses fileIndex.has() for lookup
   *
   * Performance note: For high-frequency calls during enrichment,
   * use in-memory mode (useFilesystem: false) with a pre-built fileIndex.
   * For indexing phase, filesystem mode is acceptable.
   */
  useFilesystem?: boolean;

  /**
   * Pre-built set of known file paths.
   * Required when useFilesystem=false.
   *
   * Throws Error if useFilesystem=false and fileIndex is not provided.
   */
  fileIndex?: Set<string> | null;

  /**
   * Extensions to try (in order).
   * Default: ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']
   *
   * Empty string '' means try exact path first.
   */
  extensions?: string[];

  /**
   * Index files to try (in order).
   * Default: ['index.js', 'index.ts', 'index.mjs', 'index.cjs', 'index.jsx', 'index.tsx']
   */
  indexFiles?: string[];
}

/**
 * Check if path exists using the configured method.
 */
function pathExists(
  testPath: string,
  useFilesystem: boolean,
  fileIndex?: Set<string> | null
): boolean {
  if (useFilesystem) {
    return existsSync(testPath);
  }
  return fileIndex?.has(testPath) ?? false;
}

/**
 * Check if path is a directory (filesystem mode only).
 */
function isDirectory(path: string, useFilesystem: boolean): boolean {
  if (!useFilesystem) {
    // In in-memory mode, we can't check if it's a directory
    // The fileIndex should only contain file paths, not directories
    return false;
  }
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a base path to an actual file by trying extensions and index files.
 *
 * @param basePath - Absolute path (without extension) to resolve
 * @param options - Resolution options (filesystem vs in-memory, extensions, index files)
 * @returns Resolved file path or null if not found
 *
 * @example Filesystem mode (default)
 * ```ts
 * resolveModulePath('/app/utils')
 * // → '/app/utils.js' (if exists)
 * ```
 *
 * @example In-memory mode (for enrichment plugins)
 * ```ts
 * resolveModulePath('/app/utils', {
 *   useFilesystem: false,
 *   fileIndex: new Set(['/app/utils.ts'])
 * })
 * // → '/app/utils.ts'
 * ```
 *
 * Note: Symbolic links are followed by existsSync(). Assumes all paths
 * are within the project workspace as determined by discovery phase.
 */
export function resolveModulePath(
  basePath: string,
  options?: ModuleResolutionOptions
): string | null {
  const useFilesystem = options?.useFilesystem ?? true;
  const fileIndex = options?.fileIndex;
  const extensions = options?.extensions ?? DEFAULT_EXTENSIONS;
  const indexFiles = options?.indexFiles ?? DEFAULT_INDEX_FILES;

  // Validation: fail fast if misconfigured
  if (!useFilesystem && !fileIndex) {
    throw new Error('fileIndex is required when useFilesystem=false');
  }

  // Handle empty path gracefully
  if (!basePath) {
    return null;
  }

  // Normalize path (remove trailing slash)
  const normalizedPath = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;

  // Try extensions (including '' for exact match)
  for (const ext of extensions) {
    const testPath = normalizedPath + ext;
    if (pathExists(testPath, useFilesystem, fileIndex)) {
      // In filesystem mode, don't return directories
      if (useFilesystem && ext === '' && isDirectory(testPath, useFilesystem)) {
        // It's a directory, skip to index files
        continue;
      }
      return testPath;
    }
  }

  // Try index files in directory
  for (const indexFile of indexFiles) {
    const testPath = join(normalizedPath, indexFile);
    if (pathExists(testPath, useFilesystem, fileIndex)) {
      return testPath;
    }
  }

  return null;
}

/**
 * Check if import specifier is a relative import.
 *
 * @param specifier - The import specifier (e.g., './utils', 'lodash')
 * @returns true if relative import (./ or ../), false otherwise
 *
 * @example
 * ```ts
 * isRelativeImport('./utils')      // true
 * isRelativeImport('../shared')    // true
 * isRelativeImport('lodash')       // false
 * isRelativeImport('@scope/pkg')   // false
 * isRelativeImport('node:fs')      // false
 * ```
 */
export function isRelativeImport(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Resolve relative import specifier to actual file path.
 *
 * Combines relative path resolution with module path resolution.
 * Returns null for non-relative specifiers (bare modules, scoped packages).
 *
 * @param specifier - The import specifier (e.g., './utils', '../shared')
 * @param containingFile - The file containing the import
 * @param options - Resolution options
 * @returns Resolved file path or null if not found or not relative
 *
 * @example
 * ```ts
 * // From /project/src/main.js, import './utils'
 * resolveRelativeSpecifier('./utils', '/project/src/main.js')
 * // → '/project/src/utils.js' (if exists)
 * ```
 */
export function resolveRelativeSpecifier(
  specifier: string,
  containingFile: string,
  options?: ModuleResolutionOptions
): string | null {
  // Only handle relative imports
  if (!isRelativeImport(specifier)) {
    return null;
  }

  // Resolve relative path to absolute base path
  const dir = dirname(containingFile);
  const basePath = resolve(dir, specifier);

  // Use main resolution function
  return resolveModulePath(basePath, options);
}

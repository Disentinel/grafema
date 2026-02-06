/**
 * Glob Resolver for Workspace Packages
 *
 * Resolves workspace glob patterns to actual directories containing package.json.
 * Uses minimatch for pattern matching.
 */

import { readdirSync, existsSync, readFileSync, lstatSync } from 'fs';
import { join, relative } from 'path';
import { minimatch } from 'minimatch';
import type { WorkspaceConfig } from './parsers.js';

export interface WorkspacePackage {
  path: string;
  name: string;
  relativePath: string;
  packageJson: PackageJson;
}

interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  source?: string;
  description?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Resolve workspace glob patterns to actual packages.
 * Only directories with package.json are considered valid packages.
 *
 * @param projectPath - Root directory of the project
 * @param config - Parsed workspace config with patterns and negativePatterns
 * @returns Array of resolved workspace packages
 */
export function resolveWorkspacePackages(
  projectPath: string,
  config: WorkspaceConfig
): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  const seen = new Set<string>();

  // Expand all positive patterns
  for (const pattern of config.patterns) {
    const matches = expandGlob(projectPath, pattern);

    for (const dir of matches) {
      // Check for package.json
      const pkgJsonPath = join(dir, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;

      // Check negative patterns
      const relPath = relative(projectPath, dir);
      if (config.negativePatterns.some(neg => matchesPattern(relPath, neg))) continue;

      // Avoid duplicates
      if (seen.has(dir)) continue;
      seen.add(dir);

      // Parse package.json
      let pkgJson: PackageJson;
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      } catch {
        // Skip malformed package.json
        continue;
      }

      packages.push({
        path: dir,
        name: pkgJson.name || relPath.split('/').pop() || relPath,
        relativePath: relPath,
        packageJson: pkgJson
      });
    }
  }

  return packages;
}

/**
 * Check if path matches pattern using minimatch.
 * Normalizes path separators for cross-platform compatibility.
 */
function matchesPattern(path: string, pattern: string): boolean {
  // Normalize path separators
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');
  return minimatch(normalizedPath, normalizedPattern);
}

/**
 * Expand glob pattern to actual directories.
 */
function expandGlob(basePath: string, pattern: string): string[] {
  // Handle literal path (no wildcards)
  if (!pattern.includes('*')) {
    const fullPath = join(basePath, pattern);
    if (existsSync(fullPath) && isDirectory(fullPath)) {
      return [fullPath];
    }
    return [];
  }

  // Handle recursive glob (**)
  if (pattern.includes('**')) {
    return expandRecursiveGlob(basePath, pattern);
  }

  // Handle simple glob (packages/*)
  return expandSimpleGlob(basePath, pattern);
}

/**
 * Expand simple glob like "packages/*" or "apps/*".
 */
function expandSimpleGlob(basePath: string, pattern: string): string[] {
  const parts = pattern.split('/');
  const results: string[] = [];

  // Find the first part with a wildcard
  let currentPath = basePath;
  let patternIndex = 0;

  // Navigate to the parent directory of the glob
  while (patternIndex < parts.length - 1) {
    currentPath = join(currentPath, parts[patternIndex]);
    patternIndex++;
  }

  // The last part contains the wildcard
  const globPart = parts[patternIndex];

  if (!existsSync(currentPath)) {
    return [];
  }

  try {
    const entries = readdirSync(currentPath);
    for (const entry of entries) {
      if (minimatch(entry, globPart)) {
        const fullPath = join(currentPath, entry);
        if (isDirectory(fullPath)) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // Ignore permission errors
  }

  return results;
}

/**
 * Expand recursive glob like "apps/**" or "libs/**".
 * Recursively walks directories and matches against pattern.
 */
function expandRecursiveGlob(basePath: string, pattern: string): string[] {
  const results: string[] = [];
  const maxDepth = 10; // Safety limit

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        // Skip hidden directories and node_modules
        if (entry.startsWith('.') || entry === 'node_modules') continue;

        const fullPath = join(dir, entry);

        // Skip symlinks to avoid infinite loops
        if (!isDirectory(fullPath)) continue;

        const relPath = relative(basePath, fullPath);

        // Check if this directory matches the pattern
        if (minimatch(relPath, pattern, { dot: false })) {
          results.push(fullPath);
        }

        // Continue walking regardless of match (** can match at any depth)
        walk(fullPath, depth + 1);
      }
    } catch {
      // Ignore permission errors
    }
  }

  // Start walking from pattern prefix or base
  const parts = pattern.split('**');
  const prefix = parts[0].replace(/\/$/, ''); // Remove trailing slash

  if (prefix) {
    const startPath = join(basePath, prefix);
    if (existsSync(startPath) && isDirectory(startPath)) {
      // Check if the start path itself matches
      const relPath = relative(basePath, startPath);
      if (minimatch(relPath, pattern, { dot: false })) {
        results.push(startPath);
      }
      walk(startPath, 0);
    }
  } else {
    walk(basePath, 0);
  }

  return results;
}

/**
 * Check if path is a directory (not following symlinks).
 */
function isDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    // Return true for real directories, false for symlinks
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

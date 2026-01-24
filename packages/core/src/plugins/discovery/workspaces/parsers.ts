/**
 * Workspace Config Parsers
 *
 * Parse workspace configuration files and extract glob patterns.
 * Supports pnpm-workspace.yaml, package.json workspaces, and lerna.json.
 */

import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';

export interface WorkspaceConfig {
  patterns: string[];
  negativePatterns: string[];
}

/**
 * Parse pnpm-workspace.yaml
 *
 * Format:
 * packages:
 *   - 'packages/*'
 *   - 'apps/**'
 *   - '!packages/internal'
 */
export function parsePnpmWorkspace(configPath: string): WorkspaceConfig {
  const content = readFileSync(configPath, 'utf-8');
  const config = parseYaml(content) as { packages?: string[] };

  const patterns: string[] = [];
  const negativePatterns: string[] = [];

  for (const pattern of config.packages || []) {
    if (pattern.startsWith('!')) {
      negativePatterns.push(pattern.slice(1));
    } else {
      patterns.push(pattern);
    }
  }

  return { patterns, negativePatterns };
}

/**
 * Parse npm/yarn workspaces from package.json
 *
 * Formats:
 * - Array: { "workspaces": ["packages/*", "apps/**"] }
 * - Object (yarn): { "workspaces": { "packages": ["packages/*"], "nohoist": [...] } }
 */
export function parseNpmWorkspace(packageJsonPath: string): WorkspaceConfig {
  const content = readFileSync(packageJsonPath, 'utf-8');
  const pkg = JSON.parse(content) as {
    workspaces?: string[] | { packages?: string[] };
  };

  let workspaces: string[] = [];

  if (Array.isArray(pkg.workspaces)) {
    workspaces = pkg.workspaces;
  } else if (pkg.workspaces?.packages) {
    workspaces = pkg.workspaces.packages;
  }

  const patterns: string[] = [];
  const negativePatterns: string[] = [];

  for (const pattern of workspaces) {
    if (pattern.startsWith('!')) {
      negativePatterns.push(pattern.slice(1));
    } else {
      patterns.push(pattern);
    }
  }

  return { patterns, negativePatterns };
}

/**
 * Parse lerna.json
 *
 * Format:
 * { "packages": ["packages/*", "components/*"] }
 *
 * Default: ["packages/*"] if packages field is missing
 */
export function parseLernaConfig(lernaJsonPath: string): WorkspaceConfig {
  const content = readFileSync(lernaJsonPath, 'utf-8');
  const config = JSON.parse(content) as { packages?: string[] };

  // Lerna defaults to packages/* if not specified
  const packages = config.packages ?? ['packages/*'];

  // Return empty if explicitly set to empty array
  if (packages.length === 0) {
    return { patterns: [], negativePatterns: [] };
  }

  return { patterns: packages, negativePatterns: [] };
}

/**
 * Workspace Type Detector
 *
 * Detects which workspace system is used in a project by checking
 * for configuration files in priority order: pnpm > npm/yarn > lerna.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type WorkspaceType = 'pnpm' | 'npm' | 'yarn' | 'lerna' | null;

export interface WorkspaceDetectionResult {
  type: WorkspaceType;
  configPath: string | null;
  rootPath: string;
}

/**
 * Detect workspace type by checking for configuration files.
 * Priority: pnpm > npm/yarn > lerna (most specific first)
 *
 * @param projectPath - Root directory of the project
 * @returns Detection result with type, config path, and root path
 */
export function detectWorkspaceType(projectPath: string): WorkspaceDetectionResult {
  // 1. Check for pnpm-workspace.yaml (highest priority)
  const pnpmYaml = join(projectPath, 'pnpm-workspace.yaml');
  const pnpmYml = join(projectPath, 'pnpm-workspace.yml');

  if (existsSync(pnpmYaml)) {
    return { type: 'pnpm', configPath: pnpmYaml, rootPath: projectPath };
  }
  if (existsSync(pnpmYml)) {
    return { type: 'pnpm', configPath: pnpmYml, rootPath: projectPath };
  }

  // 2. Check for npm/yarn workspaces in package.json
  const packageJsonPath = join(projectPath, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);

      if (pkg.workspaces) {
        // Both npm and yarn use package.json workspaces - detect as 'npm'
        // The format is compatible for both
        return { type: 'npm', configPath: packageJsonPath, rootPath: projectPath };
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  // 3. Check for lerna.json
  const lernaJsonPath = join(projectPath, 'lerna.json');
  if (existsSync(lernaJsonPath)) {
    return { type: 'lerna', configPath: lernaJsonPath, rootPath: projectPath };
  }

  // No workspace configuration found
  return { type: null, configPath: null, rootPath: projectPath };
}

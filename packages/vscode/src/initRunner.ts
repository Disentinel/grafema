/**
 * Project initialization for Grafema.
 *
 * Detects project type, generates config.yaml, and updates .gitignore.
 * Ported from packages/cli/src/commands/init.ts — no dependencies on @grafema/util.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';
import { generateConfigYAML } from './initConfig';

/** Project marker files → language name. */
const PROJECT_MARKERS = [
  { file: 'package.json', lang: 'JavaScript/TypeScript' },
  { file: 'Cargo.toml', lang: 'Rust' },
  { file: 'go.mod', lang: 'Go' },
  { file: 'pom.xml', lang: 'Java' },
  { file: 'build.gradle', lang: 'Java/Kotlin' },
  { file: 'build.gradle.kts', lang: 'Kotlin' },
  { file: 'setup.py', lang: 'Python' },
  { file: 'pyproject.toml', lang: 'Python' },
  { file: 'mix.exs', lang: 'Elixir' },
  { file: 'rebar.config', lang: 'Erlang' },
  { file: 'stack.yaml', lang: 'Haskell' },
  { file: 'CMakeLists.txt', lang: 'C/C++' },
  { file: 'Package.swift', lang: 'Swift' },
];

/**
 * Detect project languages by checking for marker files.
 */
export function detectProjectType(root: string): string[] {
  const detected = PROJECT_MARKERS.filter(m => existsSync(join(root, m.file)));
  return [...new Set(detected.map(m => m.lang))];
}

export interface InitResult {
  created: boolean;
  configPath: string;
  detected: string[];
}

/**
 * Initialize Grafema in the given workspace root.
 *
 * Creates .grafema/config.yaml and updates .gitignore.
 * If config already exists and force is false, prompts the user.
 */
export async function runInit(workspaceRoot: string, force?: boolean): Promise<InitResult> {
  const grafemaDir = join(workspaceRoot, '.grafema');
  const configPath = join(grafemaDir, 'config.yaml');
  const detected = detectProjectType(workspaceRoot);

  // Check existing config
  if (existsSync(configPath) && !force) {
    const choice = await vscode.window.showWarningMessage(
      'Grafema config already exists. Overwrite?',
      'Overwrite', 'Cancel'
    );
    if (choice !== 'Overwrite') {
      return { created: false, configPath, detected };
    }
  }

  // Create .grafema directory
  if (!existsSync(grafemaDir)) {
    mkdirSync(grafemaDir, { recursive: true });
  }

  // Write config
  writeFileSync(configPath, generateConfigYAML());

  // Update .gitignore if present
  const gitignorePath = join(workspaceRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, 'utf-8');
    if (!gitignore.includes('.grafema/graph.rfdb')) {
      writeFileSync(
        gitignorePath,
        gitignore + '\n# Grafema\n.grafema/graph.rfdb\n.grafema/rfdb.sock\n'
      );
    }
  }

  return { created: true, configPath, detected };
}

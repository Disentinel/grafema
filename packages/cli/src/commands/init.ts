/**
 * Init command - Initialize Grafema in a project
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { stringify as stringifyYAML } from 'yaml';
import { GRAFEMA_VERSION, getSchemaVersion } from '@grafema/util';
import { installSkill } from './setup-skill.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** All file extensions supported by Grafema's analyzers. */
const SUPPORTED_EXTENSIONS = [
  // JavaScript / TypeScript
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  // Rust
  'rs',
  // Java / Kotlin
  'java', 'kt', 'kts',
  // Python
  'py', 'pyi',
  // Go
  'go',
  // Haskell
  'hs',
  // C / C++
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hxx', 'hh', 'inl', 'ipp', 'tpp', 'txx',
  // Swift / Objective-C
  'swift', 'm', 'mm',
  // BEAM (Elixir / Erlang)
  'ex', 'exs', 'erl', 'hrl',
];

/**
 * Generate config.yaml content.
 * Minimal config — the Rust orchestrator has its own built-in analysis pipeline.
 * Includes all supported extensions; orchestrator skips languages with no matching files.
 */
function generateConfigYAML(): string {
  const extensions = `*.{${SUPPORTED_EXTENSIONS.join(',')}}`;
  const config = {
    version: getSchemaVersion(GRAFEMA_VERSION),
    root: '..',
    include: [`**/${extensions}`],
    exclude: [
      '**/*.test.*',
      '**/__tests__/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/target/**',
      '**/vendor/**',
      '**/.git/**',
    ],
  };

  const yaml = stringifyYAML(config, {
    lineWidth: 0,
  });

  return `# Grafema Configuration
# Documentation: https://github.com/grafema/grafema#configuration
# Supported: JS/TS, Rust, Java, Kotlin, Python, Go, Haskell, C/C++, Swift, Elixir/Erlang

${yaml}
# services:  # Explicit service definitions (overrides auto-discovery)
#   - name: "api"
#     path: "."
#     entryPoint: "src/index.ts"
`;
}

/**
 * Ask user a yes/no question. Returns true for yes (default), false for no.
 */
function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      // Default yes (empty answer or 'y' or 'yes')
      const normalized = answer.toLowerCase().trim();
      resolve(normalized !== 'n' && normalized !== 'no');
    });
  });
}

/**
 * Run grafema analyze in the given project path.
 * Returns the exit code of the analyze process.
 */
function runAnalyze(projectPath: string): Promise<number> {
  return new Promise((resolve) => {
    const cliPath = join(__dirname, '..', 'cli.js');
    // Use process.execPath (absolute path to current Node binary) instead of
    // 'node' to avoid PATH lookup failures when nvm isn't loaded in the shell.
    const child = spawn(process.execPath, [cliPath, 'analyze', projectPath], {
      stdio: 'inherit', // Pass through all I/O for user to see progress
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/**
 * Print next steps after init.
 */
function printNextSteps(): void {
  console.log('');
  console.log('Next steps:');
  console.log('  1. Review config:  code .grafema/config.yaml');
  console.log('  2. Build graph:    grafema analyze');
  console.log('  3. Explore:        grafema overview');
  console.log('');
  console.log('For AI-assisted setup, use the Grafema MCP server');
  console.log('with the "onboard_project" prompt.');
}

/**
 * Check if running in interactive mode.
 * Interactive if stdin is TTY and --yes flag not provided.
 */
function isInteractive(options: InitOptions): boolean {
  return options.yes !== true && process.stdin.isTTY === true;
}

interface InitOptions {
  force?: boolean;
  yes?: boolean;
}

export const initCommand = new Command('init')
  .description('Initialize Grafema in current project')
  .argument('[path]', 'Project path', '.')
  .option('-f, --force', 'Overwrite existing config')
  .option('-y, --yes', 'Skip prompts (non-interactive mode)')
  .addHelpText('after', `
Examples:
  grafema init                   Initialize in current directory
  grafema init ./my-project      Initialize in specific directory
  grafema init --force           Overwrite existing configuration
  grafema init --yes             Skip prompts, auto-run analyze
`)
  .action(async (path: string, options: InitOptions) => {
    const projectPath = resolve(path);
    const grafemaDir = join(projectPath, '.grafema');
    const configPath = join(grafemaDir, 'config.yaml');
    // Detect project markers
    const markers = [
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
    const detected = markers.filter(m => existsSync(join(projectPath, m.file)));
    if (detected.length > 0) {
      const langs = [...new Set(detected.map(m => m.lang))].join(', ');
      console.log(`✓ Detected: ${langs}`);
    } else {
      console.log('✓ Initializing (no project markers found — will analyze all supported files)');
    }

    // Check existing config
    if (existsSync(configPath) && !options.force) {
      console.log('');
      console.log('✓ Grafema already initialized');
      console.log('  → Use --force to overwrite config');
      printNextSteps();
      return;
    }

    // Create .grafema directory
    if (!existsSync(grafemaDir)) {
      mkdirSync(grafemaDir, { recursive: true });
    }

    // Write config
    const configContent = generateConfigYAML();
    writeFileSync(configPath, configContent);
    console.log('✓ Created .grafema/config.yaml');

    // Add to .gitignore if exists
    const gitignorePath = join(projectPath, '.gitignore');
    if (existsSync(gitignorePath)) {
      const gitignore = readFileSync(gitignorePath, 'utf-8');
      if (!gitignore.includes('.grafema/graph.rfdb')) {
        writeFileSync(
          gitignorePath,
          gitignore + '\n# Grafema\n.grafema/graph.rfdb\n.grafema/rfdb.sock\n'
        );
        console.log('✓ Updated .gitignore');
      }
    }

    // Auto-install Agent Skill for AI-assisted development
    try {
      const installed = installSkill(projectPath);
      if (installed) {
        console.log('✓ Installed Agent Skill (.claude/skills/grafema-codebase-analysis/)');
      }
    } catch {
      // Non-critical — don't fail init if skill install fails
    }

    printNextSteps();

    // Prompt to run analyze in interactive mode
    if (isInteractive(options)) {
      console.log('');
      const runNow = await askYesNo('Run analysis now? [Y/n] ');
      if (runNow) {
        console.log('');
        console.log('Starting analysis...');
        console.log('');
        const exitCode = await runAnalyze(projectPath);
        if (exitCode !== 0) {
          process.exit(exitCode);
        }
      }
    }
  });

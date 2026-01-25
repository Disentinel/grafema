/**
 * Init command - Initialize Grafema in a project
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { exitWithError } from '../utils/errorFormatter.js';
import { stringify as stringifyYAML } from 'yaml';
import { DEFAULT_CONFIG } from '@grafema/core';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Generate config.yaml content with commented future features.
 * Only includes implemented features (plugins).
 */
function generateConfigYAML(): string {
  // Start with working default config
  const config = {
    // Plugin list (fully implemented)
    plugins: DEFAULT_CONFIG.plugins,
  };

  // Convert to YAML
  const yaml = stringifyYAML(config, {
    lineWidth: 0, // Don't wrap long lines
  });

  // Add header comment
  return `# Grafema Configuration
# Documentation: https://github.com/grafema/grafema#configuration

${yaml}
# Future: File discovery patterns (not yet implemented)
# Grafema currently uses entrypoint-based discovery (follows imports from package.json main field)
# Glob-based include/exclude patterns will be added in a future release
#
# include:
#   - "src/**/*.{ts,js,tsx,jsx}"
# exclude:
#   - "**/*.test.ts"
#   - "node_modules/**"
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
    const child = spawn('node', [cliPath, 'analyze', projectPath], {
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
    const packageJsonPath = join(projectPath, 'package.json');
    const tsconfigPath = join(projectPath, 'tsconfig.json');

    // Check package.json
    if (!existsSync(packageJsonPath)) {
      console.error('✗ Grafema currently supports JavaScript/TypeScript projects only.');
      console.error(`  No package.json found in ${projectPath}`);
      console.error('');
      console.error('  Supported: Node.js, React, Express, Next.js, Vue, Angular, etc.');
      console.error('  Coming soon: Python, Go, Rust');
      console.error('');
      console.error('  If this IS a JS/TS project, create package.json first:');
      console.error('    npm init -y');
      process.exit(1);
    }
    console.log('✓ Found package.json');

    // Detect TypeScript
    const isTypeScript = existsSync(tsconfigPath);
    if (isTypeScript) {
      console.log('✓ Detected TypeScript project');
    } else {
      console.log('✓ Detected JavaScript project');
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

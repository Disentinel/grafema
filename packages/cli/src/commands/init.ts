/**
 * Init command - Initialize Grafema in a project
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { exitWithError } from '../utils/errorFormatter.js';

const DEFAULT_CONFIG = `# Grafema configuration
include:
  - "src/**/*.{ts,js,tsx,jsx}"

exclude:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "**/__tests__/**"
  - "node_modules/**"
  - "dist/**"
  - "build/**"

analysis:
  maxFileSize: 1MB
  timeout: 30s
`;

interface InitOptions {
  force?: boolean;
}

export const initCommand = new Command('init')
  .description('Initialize Grafema in current project')
  .argument('[path]', 'Project path', '.')
  .option('-f, --force', 'Overwrite existing config')
  .action(async (path: string, options: InitOptions) => {
    const projectPath = resolve(path);
    const grafemaDir = join(projectPath, '.grafema');
    const configPath = join(grafemaDir, 'config.yaml');
    const packageJsonPath = join(projectPath, 'package.json');
    const tsconfigPath = join(projectPath, 'tsconfig.json');

    // Check package.json
    if (!existsSync(packageJsonPath)) {
      exitWithError('No package.json found', [
        'Initialize a project: npm init',
        'Or check you are in the right directory'
      ]);
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
      console.log('');
      console.log('Next: Run "grafema analyze" to build the code graph');
      return;
    }

    // Create .grafema directory
    if (!existsSync(grafemaDir)) {
      mkdirSync(grafemaDir, { recursive: true });
    }

    // Detect project structure and customize config
    let config = DEFAULT_CONFIG;

    // Check for common patterns
    const srcExists = existsSync(join(projectPath, 'src'));
    const libExists = existsSync(join(projectPath, 'lib'));
    const packagesExists = existsSync(join(projectPath, 'packages'));

    if (packagesExists) {
      // Monorepo
      config = config.replace(
        'src/**/*.{ts,js,tsx,jsx}',
        'packages/*/src/**/*.{ts,js,tsx,jsx}'
      );
      console.log('✓ Detected monorepo structure');
    } else if (!srcExists && libExists) {
      config = config.replace('src/**', 'lib/**');
    }

    // Write config
    writeFileSync(configPath, config);
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

    console.log('');
    console.log('Next: Run "grafema analyze" to build the code graph');
  });

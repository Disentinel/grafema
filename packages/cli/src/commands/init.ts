/**
 * Init command - Initialize Grafema in a project
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { stringify as stringifyYAML } from 'yaml';
import { DEFAULT_CONFIG } from '@grafema/core';

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

interface InitOptions {
  force?: boolean;
}

export const initCommand = new Command('init')
  .description('Initialize Grafema in current project')
  .argument('[path]', 'Project path', '.')
  .option('-f, --force', 'Overwrite existing config')
  .addHelpText('after', `
Examples:
  grafema init                   Initialize in current directory
  grafema init ./my-project      Initialize in specific directory
  grafema init --force           Overwrite existing configuration
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
      console.log('');
      console.log('Next: Run "grafema analyze" to build the code graph');
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

    console.log('');
    console.log('Next: Run "grafema analyze" to build the code graph');
  });

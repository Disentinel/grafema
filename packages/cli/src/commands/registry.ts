/**
 * Registry command — build and manage the local manifest registry.
 *
 * grafema registry build [--packages <names>] [--all] [--force] [--verbose]
 * grafema registry list
 * grafema registry status
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { RegistryBuilder } from '@grafema/util';
import type { RegistryIndex } from '@grafema/util';

function getRegistryDir(path: string): string {
  return join(resolve(path), 'registry');
}

const buildCommand = new Command('build')
  .description('Build manifest registry for npm dependencies')
  .argument('[path]', 'Project path', '.')
  .option('-p, --packages <names>', 'Comma-separated package names to build')
  .option('-a, --all', 'Build all discovered dependencies')
  .option('-f, --force', 'Rebuild even if manifest exists')
  .option('-v, --verbose', 'Show detailed output')
  .option('--skip <names>', 'Comma-separated package names to skip')
  .option('--timeout <ms>', 'Max per-package timeout in ms (adaptive by default)', '600000')
  .option('--max-files <count>', 'Skip packages exceeding this file count', '5000')
  .action(async (path: string, options: {
    packages?: string;
    all?: boolean;
    force?: boolean;
    verbose?: boolean;
    skip?: string;
    timeout?: string;
    maxFiles?: string;
  }) => {
    const projectPath = resolve(path);
    const registryDir = getRegistryDir(path);

    const builder = new RegistryBuilder({
      projectPath,
      registryDir,
      force: options.force,
      verbose: options.verbose,
      skip: options.skip?.split(',').map(s => s.trim()) ?? [],
      timeout: parseInt(options.timeout ?? '120000', 10),
      maxFiles: parseInt(options.maxFiles ?? '5000', 10),
    });

    if (options.packages) {
      const names = options.packages.split(',').map(s => s.trim());
      await builder.buildPackages(names);
    } else if (options.all) {
      await builder.buildAll();
    } else {
      console.error('Specify --packages <names> or --all');
      process.exit(1);
    }

    // Write index and print summary
    const indexPath = builder.writeIndex();
    builder.printSummary();
    console.log(`\nIndex: ${indexPath}`);
  });

const listCommand = new Command('list')
  .description('List packages in the local registry')
  .argument('[path]', 'Project path', '.')
  .action((path: string) => {
    const registryDir = getRegistryDir(path);
    const indexPath = join(registryDir, 'index.yaml');

    if (!existsSync(indexPath)) {
      console.log('No registry found. Run `grafema registry build --all` first.');
      return;
    }

    const index = parseYaml(readFileSync(indexPath, 'utf-8')) as RegistryIndex;
    if (!index?.entries?.length) {
      console.log('Registry is empty.');
      return;
    }

    console.log(`Registry: ${index.entries.length} packages (analyzer ${index.analyzer_version})\n`);

    const nameWidth = Math.max(...index.entries.map(e => e.name.length), 7);
    console.log(`${'Package'.padEnd(nameWidth)}  Version     Exports  Confidence  Source`);
    console.log(`${'─'.repeat(nameWidth)}  ──────────  ───────  ──────────  ──────`);

    for (const entry of index.entries) {
      console.log(
        `${entry.name.padEnd(nameWidth)}  ${entry.version.padEnd(10)}  ${String(entry.total_exports).padStart(7)}  ${entry.confidence.toFixed(2).padStart(10)}  ${entry.source_type}`,
      );
    }
  });

const statusCommand = new Command('status')
  .description('Show registry build status vs installed dependencies')
  .argument('[path]', 'Project path', '.')
  .action((path: string) => {
    const projectPath = resolve(path);
    const registryDir = getRegistryDir(path);

    const builder = new RegistryBuilder({ projectPath, registryDir });
    const deps = builder.discoverDependencies();

    const indexPath = join(registryDir, 'index.yaml');
    const builtNames = new Set<string>();
    if (existsSync(indexPath)) {
      const index = parseYaml(readFileSync(indexPath, 'utf-8')) as RegistryIndex;
      if (index?.entries) {
        for (const e of index.entries) builtNames.add(e.name);
      }
    }

    const built = deps.filter(d => builtNames.has(d));
    const missing = deps.filter(d => !builtNames.has(d));

    console.log(`Dependencies: ${deps.length} total, ${built.length} in registry, ${missing.length} missing\n`);

    if (missing.length > 0) {
      console.log('Missing from registry:');
      for (const name of missing) {
        console.log(`  ${name}`);
      }
      console.log(`\nRun: grafema registry build --packages ${missing.join(',')}`);
    } else {
      console.log('All dependencies have manifests in the registry.');
    }
  });

export const registryCommand = new Command('registry')
  .description('Manage local manifest registry for npm dependencies')
  .addCommand(buildCommand)
  .addCommand(listCommand)
  .addCommand(statusCommand);

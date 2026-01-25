/**
 * Coverage command - Show analysis coverage statistics
 *
 * Shows what percentage of the codebase has been analyzed:
 * - Analyzed: Files in the graph as MODULE nodes
 * - Unsupported: Files with extensions that no indexer handles
 * - Unreachable: Files with supported extensions but not imported from entrypoints
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend, CoverageAnalyzer, type CoverageResult } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';

export const coverageCommand = new Command('coverage')
  .description('Show analysis coverage statistics')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-v, --verbose', 'Show detailed file lists')
  .action(async (options: { project: string; json?: boolean; verbose?: boolean }) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      const analyzer = new CoverageAnalyzer(backend, projectPath);
      const result = await analyzer.analyze();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printCoverageReport(result, options.verbose ?? false);
      }
    } finally {
      await backend.close();
    }
  });

/**
 * Print human-readable coverage report
 */
function printCoverageReport(result: CoverageResult, verbose: boolean): void {
  console.log('');
  console.log('Analysis Coverage');
  console.log('=================');
  console.log('');

  // Summary
  console.log(`Project: ${result.projectPath}`);
  console.log('');

  // Main statistics
  console.log('File breakdown:');
  console.log(`  Total files:     ${result.total}`);
  console.log(`  Analyzed:        ${result.analyzed.count} (${result.percentages.analyzed}%) - in graph`);
  console.log(`  Unsupported:     ${result.unsupported.count} (${result.percentages.unsupported}%) - no indexer available`);
  console.log(`  Unreachable:     ${result.unreachable.count} (${result.percentages.unreachable}%) - not imported from entrypoints`);

  // Unsupported files breakdown
  if (result.unsupported.count > 0) {
    console.log('');
    console.log('Unsupported files by extension:');
    const sortedExtensions = Object.entries(result.unsupported.byExtension)
      .sort((a, b) => b[1].length - a[1].length);

    for (const [ext, files] of sortedExtensions) {
      console.log(`  ${ext}: ${files.length} files`);
      if (verbose) {
        for (const file of files.slice(0, 10)) {
          console.log(`    - ${file}`);
        }
        if (files.length > 10) {
          console.log(`    ... and ${files.length - 10} more`);
        }
      }
    }
  }

  // Unreachable files breakdown
  if (result.unreachable.count > 0) {
    console.log('');
    console.log('Unreachable source files:');
    const sortedExtensions = Object.entries(result.unreachable.byExtension)
      .sort((a, b) => b[1].length - a[1].length);

    for (const [ext, files] of sortedExtensions) {
      console.log(`  ${ext}: ${files.length} files - not imported from entrypoints`);
      if (verbose) {
        for (const file of files.slice(0, 10)) {
          console.log(`    - ${file}`);
        }
        if (files.length > 10) {
          console.log(`    ... and ${files.length - 10} more`);
        }
      }
    }
  }

  console.log('');
}

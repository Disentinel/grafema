/**
 * Types command - List all node types in the graph
 *
 * Shows all node types present in the analyzed codebase with counts.
 * Useful for:
 * - Discovering what types exist (standard and custom)
 * - Understanding graph composition
 * - Finding types to use with --type flag
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';

interface TypesOptions {
  project: string;
  json?: boolean;
  sort?: 'count' | 'name';
}

export const typesCommand = new Command('types')
  .description('List all node types in the graph')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-s, --sort <by>', 'Sort by: count (default) or name', 'count')
  .addHelpText('after', `
Examples:
  grafema types                  List all node types with counts
  grafema types --json           Output as JSON for scripting
  grafema types --sort name      Sort alphabetically by type name
  grafema types -s count         Sort by count (default, descending)

Use with query --type:
  grafema types                  # See available types
  grafema query --type jsx:component "Button"   # Query specific type
`)
  .action(async (options: TypesOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      const nodeCounts = await backend.countNodesByType();
      const entries = Object.entries(nodeCounts);

      if (entries.length === 0) {
        console.log('No nodes in graph. Run: grafema analyze');
        return;
      }

      // Sort entries
      const sortedEntries = options.sort === 'name'
        ? entries.sort((a, b) => a[0].localeCompare(b[0]))
        : entries.sort((a, b) => b[1] - a[1]); // count descending

      if (options.json) {
        const result = {
          types: sortedEntries.map(([type, count]) => ({ type, count })),
          totalTypes: sortedEntries.length,
          totalNodes: sortedEntries.reduce((sum, [, count]) => sum + count, 0),
        };
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('Node Types in Graph:');
        console.log('');

        // Calculate max type length for alignment
        const maxTypeLen = Math.max(...sortedEntries.map(([type]) => type.length));

        for (const [type, count] of sortedEntries) {
          const paddedType = type.padEnd(maxTypeLen);
          const formattedCount = count.toLocaleString();
          console.log(`  ${paddedType}  ${formattedCount}`);
        }

        console.log('');
        const totalNodes = sortedEntries.reduce((sum, [, count]) => sum + count, 0);
        console.log(`Total: ${sortedEntries.length} types, ${totalNodes.toLocaleString()} nodes`);
        console.log('');
        console.log('Tip: Use grafema query --type <type> "pattern" to search within a type');
      }
    } finally {
      await backend.close();
    }
  });

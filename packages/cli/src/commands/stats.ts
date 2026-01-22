/**
 * Stats command - Show project statistics
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/core';

export const statsCommand = new Command('stats')
  .description('Show project statistics')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-t, --types', 'Show breakdown by type')
  .action(async (options: { project: string; json?: boolean; types?: boolean }) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      console.error(`Error: No database found at ${dbPath}`);
      console.error('Run "grafema analyze" first to create the database.');
      process.exit(1);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      const stats = await backend.getStats();

      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log('Graph Statistics');
        console.log('================');
        console.log(`Total nodes: ${stats.nodeCount}`);
        console.log(`Total edges: ${stats.edgeCount}`);

        if (options.types) {
          console.log('');
          console.log('Nodes by type:');
          const sortedNodes = Object.entries(stats.nodesByType).sort((a, b) => b[1] - a[1]);
          for (const [type, count] of sortedNodes) {
            console.log(`  ${type}: ${count}`);
          }

          console.log('');
          console.log('Edges by type:');
          const sortedEdges = Object.entries(stats.edgesByType).sort((a, b) => b[1] - a[1]);
          for (const [type, count] of sortedEdges) {
            console.log(`  ${type}: ${count}`);
          }
        }
      }
    } finally {
      await backend.close();
    }
  });

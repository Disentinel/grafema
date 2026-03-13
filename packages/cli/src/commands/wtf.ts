/**
 * wtf command — "Where does this come from?"
 *
 * Backward dataflow trace with arrow-formatted output.
 *
 * Usage:
 *   grafema wtf req.user              # Backward trace
 *   grafema wtf config.apiKey         # Where does this value originate?
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import {
  RFDBServerBackend,
  traceDataflow,
  renderTraceNarrative,
} from '@grafema/util';
import type { DataflowBackend } from '@grafema/util';
import { exitWithError } from '../utils/errorFormatter.js';
import { Spinner } from '../utils/spinner.js';

interface WtfCommandOptions {
  project: string;
  depth: string;
  json?: boolean;
}

export const wtfCommand = new Command('wtf')
  .description('Where does this come from? — backward dataflow trace')
  .argument('<symbol>', 'Variable, constant, or parameter name to trace')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-d, --depth <n>', 'Max trace depth', '10')
  .option('-j, --json', 'Output as JSON')
  .addHelpText('after', `
Examples:
  grafema wtf req.user              Trace where req.user comes from
  grafema wtf config.apiKey         Where does this value originate?
  grafema wtf userId --depth 5      Limit trace depth
  grafema wtf token --json          Output as JSON
`)
  .action(async (symbol: string, options: WtfCommandOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const maxDepth = parseInt(options.depth, 10);
    if (isNaN(maxDepth) || maxDepth < 1) {
      exitWithError('Invalid depth', ['Provide a positive integer']);
    }

    const backend = new RFDBServerBackend({ dbPath, clientName: 'cli' });
    await backend.connect();

    const spinner = new Spinner('Searching for symbol...');
    spinner.start();

    try {
      // Find the node: search VARIABLE, CONSTANT, PARAMETER by name (case-insensitive)
      // Also try PROPERTY_ACCESS by matching method part after last dot
      const lowerSymbol = symbol.toLowerCase();
      // If symbol has a dot, extract the part after the last dot for method matching
      const dotIndex = symbol.lastIndexOf('.');
      const methodPart = dotIndex >= 0 ? symbol.substring(dotIndex + 1).toLowerCase() : null;

      type FoundNode = { id: string; type: string; name: string; file: string; line?: number };
      let found: FoundNode | null = null;

      for (const nodeType of ['VARIABLE', 'CONSTANT', 'PARAMETER'] as const) {
        for await (const n of backend.queryNodes({ type: nodeType })) {
          const name = (n.name || '').toLowerCase();
          if (name === lowerSymbol) {
            found = { id: n.id, type: n.type || nodeType, name: n.name || '', file: n.file || '', line: n.line };
            break;
          }
        }
        if (found) break;
      }

      // Try PROPERTY_ACCESS if not found and symbol has a dot
      if (!found && methodPart) {
        for await (const n of backend.queryNodes({ type: 'PROPERTY_ACCESS' as any })) {
          const name = (n.name || '').toLowerCase();
          // Match by full name or by the part after last dot
          const nameMethodPart = name.lastIndexOf('.') >= 0
            ? name.substring(name.lastIndexOf('.') + 1)
            : name;
          if (name === lowerSymbol || nameMethodPart === methodPart) {
            found = { id: n.id, type: n.type || 'PROPERTY_ACCESS', name: n.name || '', file: n.file || '', line: n.line };
            break;
          }
        }
      }

      if (!found) {
        spinner.stop();
        exitWithError(`Symbol not found: "${symbol}"`, [
          'Check the symbol name and try again',
          'Use: grafema query "<name>" to search available nodes',
        ]);
        return;
      }

      spinner.stop();

      // Cast backend to DataflowBackend
      const dfDb = backend as unknown as DataflowBackend;

      // Trace backward
      const results = await traceDataflow(dfDb, found.id, {
        direction: 'backward',
        maxDepth,
      });

      if (options.json) {
        console.log(JSON.stringify({
          symbol: found.name,
          node: found,
          results: results.map(r => ({
            direction: r.direction,
            startNode: r.startNode,
            reached: r.reached,
            totalReached: r.totalReached,
          })),
        }, null, 2));
      } else {
        console.log(`${found.name} (${found.type}) — ${found.file}${found.line ? ':' + found.line : ''}`);
        console.log('');
        const narrative = renderTraceNarrative(results, found.name, { detail: 'normal' });
        console.log(narrative);
      }
    } finally {
      spinner.stop();
      await backend.close();
    }
  });

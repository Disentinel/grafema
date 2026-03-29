/**
 * Describe command — Render compact DSL notation for a graph node
 *
 * Resolves target by: semantic ID → file path (MODULE) → node name.
 * Calls extractSubgraph() + renderNotation() from @grafema/util.
 *
 * Output is DSL notation using archetype-grouped operators:
 *   o- dependency, > call/flow, < read/input, => write,
 *   >x exception, ~>> event, ?| guard, |= governance
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import {
  RFDBServerBackend,
  renderNotation,
  extractSubgraph,
  PERSPECTIVES,
} from '@grafema/util';
import type { DescribeOptions } from '@grafema/util';
import { exitWithError } from '../utils/errorFormatter.js';
import { Spinner } from '../utils/spinner.js';

interface DescribeCommandOptions {
  project: string;
  depth: string;
  perspective?: string;
  budget?: string;
  json?: boolean;
  locations?: boolean;
}

export const describeCommand = new Command('describe')
  .description('Render compact DSL notation for a graph node')
  .argument('<target>', 'Semantic ID, file path, or node name')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-d, --depth <level>', 'LOD: 0=names, 1=edges, 2=nested+fold, 3=nested (exact)', '1')
  .option(
    '--perspective <name>',
    `Perspective preset: ${Object.keys(PERSPECTIVES).join(', ')}`,
  )
  .option('-b, --budget <n>', 'Max items before summarization (default 7)')
  .option('-j, --json', 'Output as JSON for scripting')
  .option('-l, --locations', 'Include file:line locations')
  .addHelpText('after', `
Perspectives:
  security   writes + exceptions
  data       flow out/in + writes
  errors     exceptions only
  api        flow out + publishes + depends
  events     publishes only

LOD levels:
  0  Node names only (minimal)
  1  Node + edges (default)
  2  Node + edges + nested children (folded)
  3  Node + edges + nested children (exact, no folding)

Examples:
  grafema describe "src/app.ts->FUNCTION->main"
  grafema describe src/app.ts
  grafema describe handleRequest
  grafema describe handleRequest --perspective security
  grafema describe MyClass -d 2 --locations
  grafema describe handleRequest --json
`)
  .action(async (target: string, options: DescribeCommandOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const depth = parseInt(options.depth, 10);
    if (isNaN(depth) || depth < 0 || depth > 3) {
      exitWithError('Invalid depth', ['Use 0, 1, 2, or 3']);
    }

    if (options.perspective && !PERSPECTIVES[options.perspective]) {
      exitWithError(`Unknown perspective: "${options.perspective}"`, [
        `Available: ${Object.keys(PERSPECTIVES).join(', ')}`,
      ]);
    }

    const backend = new RFDBServerBackend({ dbPath, clientName: 'cli' });
    await backend.connect();

    const spinner = new Spinner('Resolving target...');
    spinner.start();

    try {
      // Step 1: Resolve target → node
      let node = await backend.getNode(target);

      if (!node) {
        for await (const n of backend.queryNodes({ file: target, type: 'MODULE' })) {
          node = n;
          break;
        }
      }
      if (!node) {
        for await (const n of backend.queryNodes({ name: target })) {
          node = n;
          break;
        }
      }

      if (!node) {
        spinner.stop();
        exitWithError(`Target not found: "${target}"`, [
          'Use: grafema query "<name>" to find available nodes',
          'Try: semantic ID, file path, or node name',
        ]);
        return;
      }

      // Step 2: Extract subgraph
      const subgraph = await extractSubgraph(backend, node.id, depth);

      // Step 3: Build options
      const describeOptions: DescribeOptions = {
        depth,
        includeLocations: options.locations ?? depth >= 2,
      };
      if (options.perspective && PERSPECTIVES[options.perspective]) {
        describeOptions.archetypeFilter = PERSPECTIVES[options.perspective];
      }
      if (options.budget) {
        describeOptions.budget = parseInt(options.budget, 10);
      }

      // Step 4: Render
      const notation = renderNotation(subgraph, describeOptions);

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify({
          target: node.id,
          dsl: notation || `[${node.type}] ${node.name ?? node.id}\nNo relationships found at depth=${depth}.`,
          subgraph: {
            rootNodes: subgraph.rootNodes.length,
            edges: subgraph.edges.length,
            nodes: subgraph.nodeMap.size,
          },
        }, null, 2));
      } else if (notation.trim()) {
        console.log(notation);
      } else {
        console.log(`[${node.type}] ${node.name ?? node.id}`);
        console.log(`No relationships found at depth=${depth}.`);
      }
    } finally {
      spinner.stop();
      await backend.close();
    }
  });

/**
 * List command - List nodes by type
 *
 * Unix-style listing of nodes in the graph. Similar to `ls` for files,
 * but for code graph nodes.
 *
 * Use cases:
 * - "Show me all HTTP routes in this project"
 * - "List all functions" (with limit for large codebases)
 * - "What Socket.IO events are defined?"
 */

import { Command } from 'commander';
import { resolve, join, relative } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';

interface LsOptions {
  project: string;
  type: string;
  json?: boolean;
  limit: string;
}

interface NodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  method?: string;
  path?: string;
  url?: string;
  event?: string;
  [key: string]: unknown;
}

export const lsCommand = new Command('ls')
  .description('List nodes by type')
  .requiredOption('-t, --type <nodeType>', 'Node type to list (required)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-l, --limit <n>', 'Limit results (default: 50)', '50')
  .addHelpText('after', `
Examples:
  grafema ls --type FUNCTION              List functions (up to 50)
  grafema ls --type http:route            List all HTTP routes
  grafema ls --type http:request          List all HTTP requests (fetch/axios)
  grafema ls -t socketio:event            List Socket.IO events
  grafema ls --type CLASS -l 100          List up to 100 classes
  grafema ls --type jsx:component --json  Output as JSON

Discover available types:
  grafema types                           List all types with counts
`)
  .action(async (options: LsOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      const limit = parseInt(options.limit, 10);
      const nodeType = options.type;

      // Check if type exists in graph
      const typeCounts = await backend.countNodesByType();
      if (!typeCounts[nodeType]) {
        const availableTypes = Object.keys(typeCounts).sort();
        exitWithError(`No nodes of type "${nodeType}" found`, [
          'Available types:',
          ...availableTypes.slice(0, 10).map(t => `  ${t}`),
          availableTypes.length > 10 ? `  ... and ${availableTypes.length - 10} more` : '',
          '',
          'Run: grafema types    to see all types with counts',
        ].filter(Boolean));
      }

      // Collect nodes
      const nodes: NodeInfo[] = [];
      for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
        nodes.push({
          id: node.id,
          type: node.type || nodeType,
          name: node.name || '',
          file: node.file || '',
          line: node.line,
          method: node.method as string | undefined,
          path: node.path as string | undefined,
          url: node.url as string | undefined,
          event: node.event as string | undefined,
        });
        if (nodes.length >= limit) break;
      }

      const totalCount = typeCounts[nodeType];
      const showing = nodes.length;

      if (options.json) {
        console.log(JSON.stringify({
          type: nodeType,
          nodes,
          showing,
          total: totalCount,
        }, null, 2));
      } else {
        console.log(`[${nodeType}] (${showing}${showing < totalCount ? ` of ${totalCount}` : ''}):`);
        console.log('');

        for (const node of nodes) {
          const display = formatNodeForList(node, nodeType, projectPath);
          console.log(`  ${display}`);
        }

        if (showing < totalCount) {
          console.log('');
          console.log(`  ... ${totalCount - showing} more. Use --limit ${totalCount} to see all.`);
        }
      }
    } finally {
      await backend.close();
    }
  });

/**
 * Format a node for list display based on its type.
 * Different types show different fields.
 */
function formatNodeForList(node: NodeInfo, nodeType: string, projectPath: string): string {
  const relFile = node.file ? relative(projectPath, node.file) : '';
  const loc = node.line ? `${relFile}:${node.line}` : relFile;

  // HTTP routes: METHOD PATH (location)
  if (nodeType === 'http:route' && node.method && node.path) {
    return `${node.method.padEnd(6)} ${node.path}  (${loc})`;
  }

  // HTTP requests: METHOD URL (location)
  if (nodeType === 'http:request') {
    const method = (node.method || 'GET').padEnd(6);
    const url = node.url || 'dynamic';
    return `${method} ${url}  (${loc})`;
  }

  // Socket.IO events: event_name
  if (nodeType === 'socketio:event') {
    return node.name || node.id;
  }

  // Socket.IO emit/on: event (location)
  if (nodeType === 'socketio:emit' || nodeType === 'socketio:on') {
    const event = node.event || node.name || 'unknown';
    return `${event}  (${loc})`;
  }

  // Default: name (location)
  const name = node.name || node.id;
  return loc ? `${name}  (${loc})` : name;
}

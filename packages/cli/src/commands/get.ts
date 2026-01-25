/**
 * Get command - Retrieve node by semantic ID
 *
 * Usage:
 *   grafema get "file.js->scope->TYPE->name"
 *   grafema get "file.js->scope->TYPE->name" --json
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/core';
import { formatNodeDisplay } from '../utils/formatNode.js';
import { exitWithError } from '../utils/errorFormatter.js';

interface GetOptions {
  project: string;
  json?: boolean;
}

interface NodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  [key: string]: unknown;
}

interface Edge {
  src: string;
  dst: string;
  edgeType: string;
  type?: string;
}

interface EdgeWithName {
  edgeType: string;
  targetId: string;
  targetName: string;
}

export const getCommand = new Command('get')
  .description('Retrieve a node by its semantic ID')
  .argument('<semantic-id>', 'Semantic ID of the node (e.g., "file.js->scope->TYPE->name")')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .addHelpText('after', `
Examples:
  grafema get "src/auth.js->authenticate->FUNCTION"      Get function node
  grafema get "src/models/User.js->User->CLASS"          Get class node
  grafema get "src/api.js->config->VARIABLE"             Get variable node
  grafema get "src/auth.js->authenticate->FUNCTION" -j   Output as JSON with edges
`)
  .action(async (semanticId: string, options: GetOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      // Retrieve node by semantic ID
      const node = await backend.getNode(semanticId);

      if (!node) {
        exitWithError('Node not found', [
          `ID: ${semanticId}`,
          'Try: grafema query "<name>" to search for nodes',
        ]);
      }

      // Get incoming and outgoing edges
      const incomingEdges = await backend.getIncomingEdges(semanticId, null);
      const outgoingEdges = await backend.getOutgoingEdges(semanticId, null);

      if (options.json) {
        await outputJSON(backend, node, incomingEdges, outgoingEdges);
      } else {
        await outputText(backend, node, incomingEdges, outgoingEdges, projectPath);
      }

    } finally {
      await backend.close();
    }
  });

/**
 * Output node and edges as JSON
 */
async function outputJSON(
  backend: RFDBServerBackend,
  node: any,
  incomingEdges: Edge[],
  outgoingEdges: Edge[]
): Promise<void> {
  // Fetch target node names for all edges
  const incomingWithNames = await Promise.all(
    incomingEdges.map(async (edge) => ({
      edgeType: edge.edgeType || edge.type || 'UNKNOWN',
      targetId: edge.src,
      targetName: await getNodeName(backend, edge.src),
    }))
  );

  const outgoingWithNames = await Promise.all(
    outgoingEdges.map(async (edge) => ({
      edgeType: edge.edgeType || edge.type || 'UNKNOWN',
      targetId: edge.dst,
      targetName: await getNodeName(backend, edge.dst),
    }))
  );

  const result = {
    node: {
      id: node.id,
      type: node.type || 'UNKNOWN',
      name: node.name || '',
      file: node.file || '',
      line: node.line,
      ...getMetadataFields(node),
    },
    edges: {
      incoming: incomingWithNames,
      outgoing: outgoingWithNames,
    },
    stats: {
      incomingCount: incomingEdges.length,
      outgoingCount: outgoingEdges.length,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

/**
 * Output node and edges as formatted text
 */
async function outputText(
  backend: RFDBServerBackend,
  node: any,
  incomingEdges: Edge[],
  outgoingEdges: Edge[],
  projectPath: string
): Promise<void> {
  const nodeInfo: NodeInfo = {
    id: node.id,
    type: node.type || 'UNKNOWN',
    name: node.name || '',
    file: node.file || '',
    line: node.line,
  };

  // Display node details
  console.log(formatNodeDisplay(nodeInfo, { projectPath }));

  // Display metadata if present
  const metadata = getMetadataFields(node);
  if (Object.keys(metadata).length > 0) {
    console.log('');
    console.log('Metadata:');
    for (const [key, value] of Object.entries(metadata)) {
      console.log(`  ${key}: ${JSON.stringify(value)}`);
    }
  }

  // Display edges
  console.log('');
  await displayEdges(backend, 'Incoming', incomingEdges, (edge) => edge.src);
  console.log('');
  await displayEdges(backend, 'Outgoing', outgoingEdges, (edge) => edge.dst);
}

/**
 * Display edges grouped by type, limited to 20 in text mode
 */
async function displayEdges(
  backend: RFDBServerBackend,
  direction: string,
  edges: Edge[],
  getTargetId: (edge: Edge) => string
): Promise<void> {
  const totalCount = edges.length;

  if (totalCount === 0) {
    console.log(`${direction} edges (0):`);
    console.log('  (none)');
    return;
  }

  // Group edges by type
  const byType = new Map<string, EdgeWithName[]>();

  for (const edge of edges) {
    const edgeType = edge.edgeType || edge.type || 'UNKNOWN';
    const targetId = getTargetId(edge);
    const targetName = await getNodeName(backend, targetId);

    if (!byType.has(edgeType)) {
      byType.set(edgeType, []);
    }
    byType.get(edgeType)!.push({ edgeType, targetId, targetName });
  }

  // Display header with count
  const limitApplied = totalCount > 20;
  console.log(`${direction} edges (${totalCount}):`);

  // Display edges, limited to 20 total
  let displayed = 0;
  const limit = 20;

  for (const [edgeType, edgesOfType] of Array.from(byType.entries())) {
    console.log(`  ${edgeType}:`);

    for (const edge of edgesOfType) {
      if (displayed >= limit) break;

      // Format: TYPE#name
      const label = edge.targetName ? `${edge.edgeType}#${edge.targetName}` : edge.targetId;
      console.log(`    ${label}`);
      displayed++;
    }

    if (displayed >= limit) break;
  }

  // Show "and X more" if we hit the limit
  if (limitApplied) {
    const remaining = totalCount - displayed;
    console.log(`  ... and ${remaining} more (use --json to see all)`);
  }
}

/**
 * Get node name for display
 */
async function getNodeName(backend: RFDBServerBackend, nodeId: string): Promise<string> {
  try {
    const node = await backend.getNode(nodeId);
    if (node) {
      return node.name || '';
    }
  } catch {
    // Ignore errors
  }
  return '';
}

/**
 * Extract metadata fields (exclude standard fields)
 */
function getMetadataFields(node: any): Record<string, unknown> {
  const standardFields = new Set([
    'id', 'type', 'nodeType', 'name', 'file', 'line',
  ]);

  const metadata: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (!standardFields.has(key) && value !== undefined && value !== null) {
      metadata[key] = value;
    }
  }

  return metadata;
}

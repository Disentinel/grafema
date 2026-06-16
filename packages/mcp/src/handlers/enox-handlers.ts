/**
 * Enox Handlers — RFDB-backed knowledge graph for Grafema MCP server.
 *
 * Replaces the file-based knowledge-handlers.ts with a proper graph database.
 * All knowledge lives in a separate RFDB database called "knowledge",
 * sharing the same server socket as the code graph.
 */

import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { RFDBClient } from '@grafema/util';
import { textResult, errorResult, log } from '../utils.js';
import { getProjectPath, getSocketPathOverride } from '../state.js';
import { loadConfig } from '../config.js';
import type { MCPConfig } from '../config.js';
import type { ToolResult } from '../types.js';
import type { WireNode, WireEdge, EdgeType, AttrQuery } from '@grafema/types';

// ---------------------------------------------------------------------------
// Key normalization
// ---------------------------------------------------------------------------

function normalizeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Fact ID computation
// ---------------------------------------------------------------------------

function computeFactId(from: string, rel: string, to: string): string {
  return createHash('sha256').update(`${from}|${rel}|${to}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Knowledge client singleton
// ---------------------------------------------------------------------------

let knowledgeClient: RFDBClient | null = null;
let knowledgeDbReady = false;

/**
 * Derive the socket path using the same logic as RFDBServerBackend.
 * Priority: --socket CLI override > config rfdb_socket > auto-derive from dbPath.
 */
function deriveSocketPath(): string {
  const projectPath = getProjectPath();
  const config = loadConfig(projectPath) as MCPConfig;
  const override = getSocketPathOverride();

  if (override) return override;
  if (config.rfdb_socket) return config.rfdb_socket;

  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');
  const localSocket = join(dirname(dbPath), 'rfdb.sock');
  const SUN_LEN = process.platform === 'darwin' ? 104 : 108;

  if (Buffer.byteLength(localSocket) < SUN_LEN) {
    return localSocket;
  }

  const hash = createHash('md5').update(dirname(dbPath)).digest('hex').slice(0, 12);
  return join('/tmp', `grafema-${hash}.sock`);
}

/**
 * Get or create the knowledge RFDB client.
 * Connects to the same RFDB server socket as the code graph,
 * but opens/creates a separate "knowledge" database.
 */
async function getKnowledgeClient(): Promise<RFDBClient> {
  if (knowledgeClient?.connected && knowledgeDbReady) {
    return knowledgeClient;
  }

  // Connection died or never existed — (re)create
  if (knowledgeClient) {
    try { await knowledgeClient.close(); } catch { /* ignore */ }
  }

  const socketPath = deriveSocketPath();
  log(`[Enox] Connecting to RFDB at ${socketPath}`);

  knowledgeClient = new RFDBClient(socketPath, 'enox-knowledge');
  await knowledgeClient.connect();
  await knowledgeClient.hello();

  // Create or open the "knowledge" database
  try {
    await knowledgeClient.createDatabase('knowledge');
    log('[Enox] Created "knowledge" database');
  } catch {
    // Already exists — that's fine
  }
  await knowledgeClient.openDatabase('knowledge', 'rw');
  knowledgeDbReady = true;
  log('[Enox] Opened "knowledge" database');

  return knowledgeClient;
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

function parseMeta(node: WireNode): Record<string, unknown> {
  try {
    return node.metadata ? JSON.parse(node.metadata) : {};
  } catch {
    return {};
  }
}

function parseEdgeMeta(edge: WireEdge): Record<string, unknown> {
  try {
    return edge.metadata ? JSON.parse(edge.metadata) : {};
  } catch {
    return {};
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Node/edge collection helpers
// ---------------------------------------------------------------------------

async function collectNodes(client: RFDBClient, query: AttrQuery): Promise<WireNode[]> {
  const nodes: WireNode[] = [];
  for await (const node of client.queryNodes(query)) {
    nodes.push(node);
  }
  return nodes;
}

async function findNodeByName(client: RFDBClient, name: string): Promise<WireNode | null> {
  const key = normalizeKey(name);

  // Try exact match on normalized key
  const exact = await collectNodes(client, { name: key });
  if (exact.length > 0) return exact[0];

  // Try original name (might have dashes/underscores)
  if (name !== key) {
    const orig = await collectNodes(client, { name: name.toLowerCase() });
    if (orig.length > 0) return orig[0];
  }

  // Substring fallback — try each word
  const words = key.split(' ').filter(w => w.length > 2);
  for (const word of words) {
    const matches = await collectNodes(client, { name: word, substringMatch: true });
    if (matches.length > 0) {
      // Pick the best match (shortest name = most specific)
      matches.sort((a, b) => a.name.length - b.name.length);
      return matches[0];
    }
  }

  return null;
}

/**
 * Ensure a node exists for the given entity name.
 * Returns the node ID (normalized key).
 */
async function ensureEntity(
  client: RFDBClient,
  name: string,
  nodeType: string = 'ENTITY',
  domain: string = 'general',
): Promise<string> {
  const id = normalizeKey(name);
  const existing = await client.getNode(id);
  if (existing) return id;

  await client.addNodes([{
    id,
    nodeType: nodeType as WireNode['nodeType'],
    name: id,
    file: domain,
    exported: false,
    metadata: JSON.stringify({ created_at: nowISO(), domain }),
  }]);

  return id;
}

// ---------------------------------------------------------------------------
// 1. handleRemember
// ---------------------------------------------------------------------------

export interface RememberArgs {
  subject: string;
  fact: string;
  domain?: string;
  confidence?: number;
  relation?: string;
}

export async function handleRemember(args: RememberArgs): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();
    const domain = args.domain || 'general';
    const relation = args.relation || 'HAS_FACT';

    // Ensure subject node
    const subjectId = await ensureEntity(client, args.subject, 'ENTITY', domain);

    // Create fact node
    const factId = createHash('sha256')
      .update(`${subjectId}|${args.fact}|${Date.now()}`)
      .digest('hex')
      .slice(0, 16);
    const factNodeId = `fact:${factId}`;

    await client.addNodes([{
      id: factNodeId,
      nodeType: 'FACT' as WireNode['nodeType'],
      name: args.fact.slice(0, 120),
      file: domain,
      exported: false,
      metadata: JSON.stringify({
        content: args.fact,
        domain,
        created_at: nowISO(),
      }),
    }]);

    // Create edge from subject to fact
    await client.addEdges([{
      src: subjectId,
      dst: factNodeId,
      edgeType: relation as EdgeType,
      metadata: JSON.stringify({ created_at: nowISO() }),
    }]);

    await client.flush();

    return textResult(
      `Remembered:\n` +
      `  Subject: ${subjectId}\n` +
      `  Fact: ${factNodeId}\n` +
      `  Relation: ${relation}\n` +
      `  Domain: ${domain}`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to remember: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 2. handleRecall
// ---------------------------------------------------------------------------

export interface RecallArgs {
  query: string;
  depth?: number;
}

export async function handleRecall(args: RecallArgs): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();
    const depth = args.depth ?? 2;

    // Find entities: try full query first, then individual words
    let nodes = await collectNodes(client, {
      name: args.query.toLowerCase(),
      substringMatch: true,
    });

    if (nodes.length === 0) {
      const words = args.query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const seen = new Set<string>();
      for (const word of words.sort((a, b) => b.length - a.length)) {
        const matches = await collectNodes(client, { name: word, substringMatch: true });
        for (const m of matches) {
          if (!seen.has(m.id) && m.nodeType !== 'NPM_SYMBOL' && m.nodeType !== 'NPM_PACKAGE') {
            seen.add(m.id);
            nodes.push(m);
          }
        }
        if (nodes.length >= 10) break;
      }
    }

    if (nodes.length === 0) {
      return textResult(`No knowledge found for "${args.query}".`);
    }

    const lines: string[] = [];

    for (const node of nodes.slice(0, 10)) {
      const meta = parseMeta(node);
      lines.push(`## ${node.name} [${node.nodeType}]`);
      if (meta.domain) lines.push(`Domain: ${meta.domain}`);
      if (meta.content) lines.push(`Content: ${String(meta.content)}`);
      if (meta.description) lines.push(`Description: ${String(meta.description)}`);
      lines.push('');

      // Traverse neighborhood
      if (depth > 0) {
        const outgoing = await client.getOutgoingEdges(node.id);
        const incoming = await client.getIncomingEdges(node.id);

        if (outgoing.length > 0) {
          lines.push('### Outgoing:');
          for (const edge of outgoing.slice(0, 20)) {
            const target = await client.getNode(edge.dst);
            const eMeta = parseEdgeMeta(edge);
            const targetName = target?.name || edge.dst;
            lines.push(`  -[${edge.edgeType}]-> ${targetName}${eMeta.confidence ? ` (confidence: ${eMeta.confidence})` : ''}`);
          }
          lines.push('');
        }

        if (incoming.length > 0) {
          lines.push('### Incoming:');
          for (const edge of incoming.slice(0, 20)) {
            const source = await client.getNode(edge.src);
            const eMeta = parseEdgeMeta(edge);
            const sourceName = source?.name || edge.src;
            lines.push(`  ${sourceName} -[${edge.edgeType}]->  this${eMeta.confidence ? ` (confidence: ${eMeta.confidence})` : ''}`);
          }
          lines.push('');
        }
      }
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to recall: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 3. handleSemanticSearch
// ---------------------------------------------------------------------------

export interface SemanticSearchArgs {
  query: string;
  top_k?: number;
  domain?: string;
}

/**
 * Handle the `semantic_search` MCP tool.
 *
 * @param args - tool input. `top_k` (matching the published schema) caps the
 *   number of results; defaults to 10 per the schema's documented default.
 * @param clientOverride - optional RFDB client, injected by tests; production
 *   callers omit it and the shared knowledge client is used.
 */
export async function handleSemanticSearch(
  args: SemanticSearchArgs,
  clientOverride?: RFDBClient,
): Promise<ToolResult> {
  try {
    const client = clientOverride ?? await getKnowledgeClient();
    const limit = args.top_k ?? 10;

    // TODO: Wire to RFDB embedding engine when enabled.
    // For now, fall back to substring search via queryNodes.
    const querySpec: AttrQuery = {
      name: args.query.toLowerCase(),
      substringMatch: true,
    };
    if (args.domain) {
      querySpec.file = args.domain; // domain stored in file field
    }

    const nodes = await collectNodes(client, querySpec);
    const results = nodes.slice(0, limit);

    if (results.length === 0) {
      return textResult(`No results for semantic search: "${args.query}".`);
    }

    const lines: string[] = [`Found ${results.length} result(s) for "${args.query}":\n`];
    for (let i = 0; i < results.length; i++) {
      const node = results[i];
      const meta = parseMeta(node);
      // NOTE: this is substring matching, not embeddings — do not fabricate a
      // similarity score (it would read to an agent as a real metric). Just rank.
      lines.push(`${i + 1}. ${node.name} (${node.nodeType})`);
      if (meta.domain) lines.push(`   Domain: ${meta.domain}`);
      if (meta.content) lines.push(`   ${String(meta.content).slice(0, 200)}`);
      lines.push('');
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to search: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 4. handleExploreEntity
// ---------------------------------------------------------------------------

export interface ExploreEntityArgs {
  name: string;
  depth?: number;
}

export async function handleExploreEntity(args: ExploreEntityArgs): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();

    const node = await findNodeByName(client, args.name);
    if (!node) {
      return errorResult(`Entity "${args.name}" not found. Use semantic_search to find similar entities.`);
    }

    const meta = parseMeta(node);
    const lines: string[] = [
      `# ${node.name}`,
      `Type: ${node.nodeType}`,
      `ID: ${node.id}`,
    ];
    if (meta.domain) lines.push(`Domain: ${meta.domain}`);
    if (meta.description) lines.push(`Description: ${meta.description}`);
    if (meta.content) lines.push(`Content: ${String(meta.content).slice(0, 500)}`);
    if (meta.created_at) lines.push(`Created: ${meta.created_at}`);
    lines.push('');

    // Outgoing edges
    const outgoing = await client.getOutgoingEdges(node.id);
    if (outgoing.length > 0) {
      lines.push(`## Outgoing (${outgoing.length}):`);
      for (const edge of outgoing) {
        const target = await client.getNode(edge.dst);
        const eMeta = parseEdgeMeta(edge);
        const targetName = target?.name || edge.dst;
        let detail = `  -[${edge.edgeType}]-> ${targetName}`;
        if (eMeta.confidence) detail += ` | confidence: ${eMeta.confidence}`;
        if (eMeta.condition) detail += ` | condition: ${eMeta.condition}`;
        if (eMeta.note) detail += ` | note: ${eMeta.note}`;
        lines.push(detail);
      }
      lines.push('');
    }

    // Incoming edges
    const incoming = await client.getIncomingEdges(node.id);
    if (incoming.length > 0) {
      lines.push(`## Incoming (${incoming.length}):`);
      for (const edge of incoming) {
        const source = await client.getNode(edge.src);
        const eMeta = parseEdgeMeta(edge);
        const sourceName = source?.name || edge.src;
        let detail = `  ${sourceName} -[${edge.edgeType}]->`;
        if (eMeta.confidence) detail += ` | confidence: ${eMeta.confidence}`;
        if (eMeta.condition) detail += ` | condition: ${eMeta.condition}`;
        if (eMeta.note) detail += ` | note: ${eMeta.note}`;
        lines.push(detail);
      }
      lines.push('');
    }

    if (outgoing.length === 0 && incoming.length === 0) {
      lines.push('No edges found (isolated node).');
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to explore: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 5. handleAddAssertion
// ---------------------------------------------------------------------------

export interface AddAssertionArgs {
  from: string;
  relation: string;
  to: string;
  context?: string;
  confidence?: number;
  domain?: string;
  note?: string;
  condition?: string;
}

export async function handleAddAssertion(args: AddAssertionArgs): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();
    const domain = args.domain || 'general';

    // Ensure from and to nodes exist
    const fromId = await ensureEntity(client, args.from, 'ENTITY', domain);
    const toId = await ensureEntity(client, args.to, 'ENTITY', domain);

    const factId = computeFactId(fromId, args.relation, toId);

    const edgeMeta: Record<string, unknown> = {
      fact_id: factId,
      domain,
      created_at: nowISO(),
    };
    if (args.context) edgeMeta.context = args.context;
    if (args.confidence !== undefined) edgeMeta.confidence = args.confidence;
    if (args.note) edgeMeta.note = args.note;
    if (args.condition) edgeMeta.condition = args.condition;

    await client.addEdges([{
      src: fromId,
      dst: toId,
      edgeType: args.relation as EdgeType,
      metadata: JSON.stringify(edgeMeta),
    }]);

    await client.flush();

    return textResult(
      `Assertion added:\n` +
      `  ${fromId} -[${args.relation}]-> ${toId}\n` +
      `  fact_id: ${factId}\n` +
      `  domain: ${domain}` +
      (args.confidence !== undefined ? `\n  confidence: ${args.confidence}` : '')
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to add assertion: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 6. handleUpdateAssertion
// ---------------------------------------------------------------------------

export interface UpdateAssertionArgs {
  fact_id: string;
  confidence?: number;
  context?: string;
  note?: string;
  condition?: string;
  domain?: string;
}

export async function handleUpdateAssertion(args: UpdateAssertionArgs): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();

    // Scan all edges to find the one with matching fact_id.
    // This is expensive but necessary because RFDB doesn't index edge metadata.
    const allEdges = await client.getAllEdges();
    let found: (WireEdge & Record<string, unknown>) | null = null;

    for (const edge of allEdges) {
      const meta = parseEdgeMeta(edge);
      if (meta.fact_id === args.fact_id) {
        found = edge;
        break;
      }
    }

    if (!found) {
      return errorResult(`Assertion with fact_id "${args.fact_id}" not found.`);
    }

    // Delete old edge, create new one with updated metadata
    const oldMeta = parseEdgeMeta(found);
    const newMeta: Record<string, unknown> = { ...oldMeta, updated_at: nowISO() };
    if (args.confidence !== undefined) newMeta.confidence = args.confidence;
    if (args.context !== undefined) newMeta.context = args.context;
    if (args.note !== undefined) newMeta.note = args.note;
    if (args.condition !== undefined) newMeta.condition = args.condition;
    if (args.domain !== undefined) newMeta.domain = args.domain;

    await client.deleteEdge(found.src, found.dst, found.edgeType as EdgeType);
    await client.addEdges([{
      src: found.src,
      dst: found.dst,
      edgeType: found.edgeType as EdgeType,
      metadata: JSON.stringify(newMeta),
    }]);

    await client.flush();

    return textResult(
      `Assertion updated:\n` +
      `  fact_id: ${args.fact_id}\n` +
      `  ${found.src} -[${found.edgeType}]-> ${found.dst}`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to update assertion: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 7. handleDeleteAssertion
// ---------------------------------------------------------------------------

export interface DeleteAssertionArgs {
  fact_id: string;
}

export async function handleDeleteAssertion(args: DeleteAssertionArgs): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();

    const allEdges = await client.getAllEdges();
    let found: (WireEdge & Record<string, unknown>) | null = null;

    for (const edge of allEdges) {
      const meta = parseEdgeMeta(edge);
      if (meta.fact_id === args.fact_id) {
        found = edge;
        break;
      }
    }

    if (!found) {
      return errorResult(`Assertion with fact_id "${args.fact_id}" not found.`);
    }

    await client.deleteEdge(found.src, found.dst, found.edgeType as EdgeType);
    await client.flush();

    return textResult(
      `Assertion deleted:\n` +
      `  fact_id: ${args.fact_id}\n` +
      `  ${found.src} -[${found.edgeType}]-> ${found.dst}`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to delete assertion: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 8. handleEnoxQuery
// ---------------------------------------------------------------------------

export interface QueryGraphKnowledgeArgs {
  type?: string;
  domain?: string;
  name?: string;
  limit?: number;
}

export async function handleEnoxQuery(args: QueryGraphKnowledgeArgs): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();
    const limit = args.limit ?? 50;

    const querySpec: AttrQuery = {};
    if (args.type) querySpec.nodeType = args.type;
    if (args.name) {
      querySpec.name = args.name.toLowerCase();
      querySpec.substringMatch = true;
    }
    if (args.domain) {
      querySpec.file = args.domain; // domain stored in file field
    }

    const nodes = await collectNodes(client, querySpec);
    const results = nodes.slice(0, limit);

    if (results.length === 0) {
      return textResult('No matching nodes in knowledge graph.');
    }

    const lines: string[] = [`Found ${results.length} node(s):\n`];
    for (const node of results) {
      const meta = parseMeta(node);
      lines.push(`- ${node.id} | ${node.nodeType} | ${node.name}`);
      if (meta.domain) lines.push(`  domain: ${meta.domain}`);
      if (meta.created_at) lines.push(`  created: ${meta.created_at}`);
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to query knowledge graph: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 9. handleEnoxTraverse
// ---------------------------------------------------------------------------

export interface TraverseArgs {
  entity: string;
  direction?: 'outgoing' | 'incoming' | 'both';
  max_depth?: number;
  edge_types?: string[];
}

export async function handleEnoxTraverse(args: TraverseArgs): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();
    const direction = args.direction ?? 'outgoing';
    const maxDepth = args.max_depth ?? 3;

    // Resolve entity to node ID
    const node = await findNodeByName(client, args.entity);
    if (!node) {
      return errorResult(`Entity "${args.entity}" not found.`);
    }

    const edgeFilter = args.edge_types?.length
      ? args.edge_types as EdgeType[]
      : undefined;

    // BFS traversal
    const visited = new Map<string, number>(); // id -> depth
    const queue: Array<{ id: string; depth: number }> = [{ id: node.id, depth: 0 }];
    visited.set(node.id, 0);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const edges: (WireEdge & Record<string, unknown>)[] = [];

      if (direction === 'outgoing' || direction === 'both') {
        const out = await client.getOutgoingEdges(current.id, edgeFilter ?? null);
        edges.push(...out);
      }
      if (direction === 'incoming' || direction === 'both') {
        const inc = await client.getIncomingEdges(current.id, edgeFilter ?? null);
        edges.push(...inc);
      }

      for (const edge of edges) {
        const neighborId = direction === 'incoming' ? edge.src : edge.dst;
        // For 'both', pick the other end
        const otherId = edge.src === current.id ? edge.dst : edge.src;
        const nextId = direction === 'both' ? otherId : neighborId;

        if (!visited.has(nextId)) {
          visited.set(nextId, current.depth + 1);
          queue.push({ id: nextId, depth: current.depth + 1 });
        }
      }
    }

    // Format results
    const lines: string[] = [`Traversal from "${node.name}" (${direction}, max_depth=${maxDepth}):\n`];
    lines.push(`Visited ${visited.size} node(s):\n`);

    for (const [id, depth] of Array.from(visited.entries())) {
      const n = await client.getNode(id);
      const name = n?.name || id;
      const type = n?.nodeType || 'UNKNOWN';
      const indent = '  '.repeat(depth);
      lines.push(`${indent}[depth=${depth}] ${name} (${type})`);
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to traverse: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 10. handleEnoxStats
// ---------------------------------------------------------------------------

export async function handleEnoxStats(): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();

    const [stats, nodesByType, edgesByType] = await Promise.all([
      client.getStats(),
      client.countNodesByType(),
      client.countEdgesByType(),
    ]);

    const lines: string[] = [
      '## Knowledge Graph Stats\n',
      `Node count: ${stats.nodeCount}`,
      `Edge count: ${stats.edgeCount}`,
    ];

    const nodeTypeEntries = Object.entries(nodesByType);
    if (nodeTypeEntries.length > 0) {
      lines.push('\n### Nodes by Type');
      for (const [type, count] of nodeTypeEntries) {
        lines.push(`  ${type}: ${count}`);
      }
    }

    const edgeTypeEntries = Object.entries(edgesByType);
    if (edgeTypeEntries.length > 0) {
      lines.push('\n### Edges by Type');
      for (const [type, count] of edgeTypeEntries) {
        lines.push(`  ${type}: ${count}`);
      }
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to get graph stats: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 11. handleRecentActivity
// ---------------------------------------------------------------------------

export interface RecentActivityArgs {
  since?: string;  // ISO date string
  limit?: number;
}

export async function handleRecentActivity(args: RecentActivityArgs): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();
    const limit = args.limit ?? 30;

    // Get all nodes and sort by created_at from metadata
    const allNodes = await client.getAllNodes();

    // Parse created_at from metadata and sort descending
    const withDates = allNodes
      .map(node => {
        const meta = parseMeta(node);
        const createdAt = meta.created_at as string | undefined;
        return { node, createdAt, meta };
      })
      .filter(item => item.createdAt !== undefined);

    withDates.sort((a, b) => {
      const da = new Date(a.createdAt!).getTime();
      const db = new Date(b.createdAt!).getTime();
      return db - da; // newest first
    });

    // Filter by since date if provided
    let results = withDates;
    if (args.since) {
      const sinceTime = new Date(args.since).getTime();
      results = withDates.filter(item => new Date(item.createdAt!).getTime() >= sinceTime);
    }

    results = results.slice(0, limit);

    if (results.length === 0) {
      return textResult('No recent activity found.');
    }

    const lines: string[] = [`Recent activity (${results.length} entries):\n`];
    for (const { node, createdAt, meta } of results) {
      lines.push(`- [${createdAt}] ${node.nodeType}: ${node.name}`);
      if (meta.domain) lines.push(`  domain: ${meta.domain}`);
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to get recent activity: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 12. handleUpdateNode
// ---------------------------------------------------------------------------

export interface UpdateNodeArgs {
  id: string;
  name?: string;
  domain?: string;
  description?: string;
  nodeType?: string;
}

export async function handleUpdateNode(args: UpdateNodeArgs): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();

    const existing = await client.getNode(args.id);
    if (!existing) {
      return errorResult(`Node "${args.id}" not found.`);
    }

    const meta = parseMeta(existing);
    meta.updated_at = nowISO();
    if (args.description !== undefined) meta.description = args.description;
    if (args.domain !== undefined) meta.domain = args.domain;

    const updatedNode: WireNode = {
      id: existing.id,
      nodeType: (args.nodeType as WireNode['nodeType']) || existing.nodeType,
      name: args.name ?? existing.name,
      file: args.domain ?? existing.file,
      exported: existing.exported,
      metadata: JSON.stringify(meta),
    };

    // Re-add node (addNodes upserts in RFDB)
    await client.addNodes([updatedNode]);
    await client.flush();

    return textResult(
      `Node updated:\n` +
      `  ID: ${updatedNode.id}\n` +
      `  Name: ${updatedNode.name}\n` +
      `  Type: ${updatedNode.nodeType}\n` +
      `  Domain: ${meta.domain || existing.file}`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to update node: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 13. handleCrawlEntity
// ---------------------------------------------------------------------------

export interface CrawlEntityArgs {
  entity: string;
  context?: string;
  depth?: number;
}

/**
 * Lightweight ontological crawl: query the code graph for an entity,
 * generate graph-derived facts, and record them in the knowledge DB.
 *
 * No LLM, no child processes — pure graph introspection.
 */
export async function handleCrawlEntity(args: CrawlEntityArgs): Promise<ToolResult> {
  try {
    const knowledgeClient = await getKnowledgeClient();
    const depth = args.depth ?? 3;

    // 1. Recall: check knowledge DB for existing facts
    const existingNodes = await collectNodes(knowledgeClient, {
      name: args.entity.toLowerCase(),
      substringMatch: true,
    });

    const existingFacts: string[] = [];
    for (const node of existingNodes.slice(0, 10)) {
      const meta = parseMeta(node);
      if (meta.content) existingFacts.push(String(meta.content));
    }

    // 2. Code graph scan: connect to default DB and find the entity
    const socketPath = deriveSocketPath();
    const codeClient = new RFDBClient(socketPath, 'crawl-entity');
    await codeClient.connect();
    await codeClient.hello();

    const codeNodes = await collectNodes(codeClient, { name: args.entity, substringMatch: true });

    if (codeNodes.length === 0) {
      await codeClient.close();
      return textResult(
        `No code entity found matching "${args.entity}".\n` +
        (existingFacts.length > 0
          ? `\nExisting knowledge (${existingFacts.length} facts):\n${existingFacts.map(f => `  - ${f}`).join('\n')}`
          : 'No existing knowledge either.')
      );
    }

    // 3. Generate graph-derived facts for each matched node
    const facts: string[] = [];
    const processedNodes = codeNodes.slice(0, depth);

    for (const node of processedNodes) {
      const outgoing = await codeClient.getOutgoingEdges(node.id);
      const incoming = await codeClient.getIncomingEdges(node.id);

      facts.push(`${node.name} is a ${node.nodeType} in file ${node.file}`);

      if (outgoing.length > 0 || incoming.length > 0) {
        facts.push(`${node.name} has ${outgoing.length} outgoing and ${incoming.length} incoming edges`);
      }

      // Callers (incoming CALLS edges)
      const callers: string[] = [];
      for (const edge of incoming) {
        if (edge.edgeType === 'CALLS' || edge.edgeType === 'INVOKES') {
          const src = await codeClient.getNode(edge.src);
          if (src) callers.push(src.name);
        }
      }
      if (callers.length > 0) {
        facts.push(`${node.name} is called by: ${callers.slice(0, 10).join(', ')}${callers.length > 10 ? ` (+${callers.length - 10} more)` : ''}`);
      }

      // Children (outgoing CONTAINS edges)
      const children: string[] = [];
      for (const edge of outgoing) {
        if (edge.edgeType === 'CONTAINS' || edge.edgeType === 'HAS_MEMBER') {
          const dst = await codeClient.getNode(edge.dst);
          if (dst) children.push(`${dst.name} (${dst.nodeType})`);
        }
      }
      if (children.length > 0) {
        facts.push(`${node.name} contains ${children.length} members: ${children.slice(0, 10).join(', ')}${children.length > 10 ? ` (+${children.length - 10} more)` : ''}`);
      }

      // Callees (outgoing CALLS edges)
      const callees: string[] = [];
      for (const edge of outgoing) {
        if (edge.edgeType === 'CALLS' || edge.edgeType === 'INVOKES') {
          const dst = await codeClient.getNode(edge.dst);
          if (dst) callees.push(dst.name);
        }
      }
      if (callees.length > 0) {
        facts.push(`${node.name} calls: ${callees.slice(0, 10).join(', ')}${callees.length > 10 ? ` (+${callees.length - 10} more)` : ''}`);
      }
    }

    await codeClient.close();

    // 4. Return facts as context (NOT recorded — graph-derived data
    //    is already in code graph, recording duplicates it)
    //    Use remember() or add_assertion() to record interpretations.
    const lines: string[] = [
      `## Crawl: ${args.entity}`,
      `Code graph matches: ${codeNodes.length}`,
      `Facts generated: ${facts.length}`,
      `Existing knowledge: ${existingFacts.length} fact(s)`,
      '',
      '### Graph-derived facts:',
      ...facts.map(f => `  - ${f}`),
    ];

    if (existingFacts.length > 0) {
      lines.push('', '### Prior knowledge:');
      for (const f of existingFacts.slice(0, 10)) {
        lines.push(`  - ${f}`);
      }
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to crawl entity: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 14. handleSaveDocument
// ---------------------------------------------------------------------------

export interface SaveDocumentArgs {
  title: string;
  content: string;
  domain?: string;
  /**
   * Document classification (e.g. "adr", "postmortem", "spec", "note",
   * "artifact"). Persisted on the DOCUMENT node metadata so saved documents
   * are queryable by type. Defaults to "note" when omitted.
   */
  doc_type?: string;
  relates_to?: string[];
}

export async function handleSaveDocument(args: SaveDocumentArgs): Promise<ToolResult> {
  try {
    const client = await getKnowledgeClient();
    const domain = args.domain || 'general';
    const docType = args.doc_type || 'note';

    const docId = `doc:${createHash('sha256')
      .update(`${args.title}|${Date.now()}`)
      .digest('hex')
      .slice(0, 16)}`;

    await client.addNodes([{
      id: docId,
      nodeType: 'DOCUMENT' as WireNode['nodeType'],
      name: args.title,
      file: domain,
      exported: false,
      metadata: JSON.stringify({
        content: args.content,
        domain,
        doc_type: docType,
        created_at: nowISO(),
      }),
    }]);

    // Create REFERENCES edges if relates_to is provided
    const relatedEdges: WireEdge[] = [];
    if (args.relates_to?.length) {
      for (const targetName of args.relates_to) {
        const targetId = await ensureEntity(client, targetName, 'ENTITY', domain);
        relatedEdges.push({
          src: docId,
          dst: targetId,
          edgeType: 'REFERENCES' as EdgeType,
          metadata: JSON.stringify({ created_at: nowISO() }),
        });
      }
      if (relatedEdges.length > 0) {
        await client.addEdges(relatedEdges);
      }
    }

    await client.flush();

    const lines: string[] = [
      `Document saved:`,
      `  ID: ${docId}`,
      `  Title: ${args.title}`,
      `  Type: ${docType}`,
      `  Domain: ${domain}`,
      `  Content: ${args.content.length} chars`,
    ];
    if (relatedEdges.length > 0) {
      lines.push(`  References: ${relatedEdges.map(e => e.dst).join(', ')}`);
    }

    return textResult(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to save document: ${msg}`);
  }
}

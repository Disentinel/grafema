/**
 * Merged tool routers — thin adapters that delegate to the existing handler
 * internals based on a mode/graph parameter. These back the consolidated tool
 * surface (get_node, trace, explain_datalog, get_stats, and the graph="knowledge"
 * routing for query_graph / find_nodes).
 *
 * Param canon is snake_case (max_depth, node_id, edge_types, graph). Where a
 * downstream handler still uses camelCase (semanticId, edgeTypes, maxDepth,
 * nodeId), these adapters accept BOTH spellings during the compat window and
 * translate to the downstream shape.
 */

import { ensureAnalyzed } from '../analysis.js';
import { textResult, errorResult } from '../utils.js';
import type { GraphNode, ToolResult } from '../types.js';

import {
  handleQueryGraph,
  handleFindNodes,
  handleExplainFact,
  handleExplainGap,
  handleSimDatalog,
} from './query-handlers.js';
import {
  handleTraceAlias,
  handleTraceDataflow,
  handleTraceCalls,
  handleTraceEffects,
} from './dataflow-handlers.js';
import { handleGetStats, handleGetSchema } from './analysis-handlers.js';
import {
  handleGetFunctionDetails,
  handleGetContext,
  handleGetFileOverview,
  handleGetShape,
} from './context-handlers.js';
import { handleGetNode, handleGetNeighbors, handleTraverseGraph } from './graph-handlers.js';
import { handleDescribe } from './notation-handlers.js';
import {
  handleEnoxQuery,
  handleEnoxStats,
  handleEnoxTraverse,
  handleExploreEntity,
} from './enox-handlers.js';

import type {
  QueryGraphArgs,
  FindNodesArgs,
} from '../types.js';

type GraphSel = 'code' | 'knowledge';

function pick<T>(...vals: (T | undefined)[]): T | undefined {
  for (const v of vals) if (v !== undefined) return v;
  return undefined;
}

// ===========================================================================
// query_graph — adds language="graphql" and graph="knowledge"
// ===========================================================================

export async function handleQueryGraphRouted(
  args: QueryGraphArgs & { graph?: GraphSel } & Record<string, unknown>,
): Promise<ToolResult> {
  const graph = (args.graph ?? 'code') as GraphSel;
  if (graph === 'knowledge') {
    // Knowledge graph: field-filter form (type/domain/name). GraphQL/Cypher/Datalog
    // are code-graph engines; on the knowledge graph we expose exact filtering.
    return handleEnoxQuery({
      type: args.type as string | undefined,
      domain: (args.domain as string | undefined) ?? (args.file as string | undefined),
      name: args.name as string | undefined ?? (typeof args.query === 'string' ? args.query : undefined),
      limit: args.limit,
    });
  }

  if (args.language === 'graphql') {
    const { handleQueryGraphql } = await import('./graphql-handlers.js');
    return handleQueryGraphql({
      query: args.query,
      variables: args.variables as Record<string, unknown> | undefined,
      operationName: args.operationName as string | undefined,
    });
  }

  return handleQueryGraph(args);
}

// ===========================================================================
// find_nodes — adds graph="knowledge"
// ===========================================================================

export async function handleFindNodesRouted(
  args: FindNodesArgs & { graph?: GraphSel } & Record<string, unknown>,
): Promise<ToolResult> {
  const graph = (args.graph ?? 'code') as GraphSel;
  if (graph === 'knowledge') {
    return handleEnoxQuery({
      type: args.type,
      domain: (args.domain as string | undefined) ?? args.file,
      name: args.name,
      limit: args.limit,
    });
  }
  return handleFindNodes(args);
}

// ===========================================================================
// get_stats — graph + include (counts/schema), absorbs get_schema + enox_stats
// ===========================================================================

export interface GetStatsRoutedArgs {
  graph?: GraphSel;
  include?: string[];
}

export async function handleGetStatsRouted(args: GetStatsRoutedArgs): Promise<ToolResult> {
  const graph = (args.graph ?? 'code') as GraphSel;
  if (graph === 'knowledge') {
    // enox_stats already returns counts + per-type schema together.
    return handleEnoxStats();
  }

  const include = Array.isArray(args.include) && args.include.length > 0
    ? args.include
    : ['counts', 'schema'];
  const wantCounts = include.includes('counts');
  const wantSchema = include.includes('schema');

  if (wantCounts && !wantSchema) {
    return handleGetStats();
  }
  if (wantSchema && !wantCounts) {
    return handleGetSchema({ type: 'all' });
  }

  // Both — combine counts (with diagnostics) and the schema vocabulary.
  const counts = await handleGetStats();
  const schema = await handleGetSchema({ type: 'all' });
  const countsText = counts.content?.[0]?.text ?? '';
  const schemaText = schema.content?.[0]?.text ?? '';
  return textResult(`${countsText}\n\n=== Schema ===\n${schemaText}`);
}

// ===========================================================================
// trace — along: data | calls | effects | alias | edges (+ graph=knowledge)
// ===========================================================================

export interface TraceRoutedArgs {
  source: string;
  file?: string;
  along?: 'data' | 'calls' | 'effects' | 'alias' | 'edges';
  direction?: 'forward' | 'backward' | 'both';
  edge_types?: string[];
  edgeTypes?: string[];
  max_depth?: number;
  maxDepth?: number;
  detail?: 'summary' | 'normal' | 'full';
  graph?: GraphSel;
  limit?: number;
}

export async function handleTrace(args: TraceRoutedArgs): Promise<ToolResult> {
  const along = args.along ?? 'calls';
  const direction = args.direction;
  const maxDepth = pick(args.max_depth, args.maxDepth);
  const edgeTypes = pick(args.edge_types, args.edgeTypes);
  const graph = (args.graph ?? 'code') as GraphSel;

  // Knowledge-graph traversal — generic relation BFS via enox_traverse.
  if (graph === 'knowledge') {
    return handleEnoxTraverse({
      entity: args.source,
      direction: direction as 'outgoing' | 'incoming' | 'both' | undefined,
      edge_types: edgeTypes,
      max_depth: maxDepth,
    });
  }

  switch (along) {
    case 'data':
      return handleTraceDataflow({
        source: args.source,
        file: args.file,
        direction: direction as 'forward' | 'backward' | 'both' | undefined,
        max_depth: maxDepth,
        limit: args.limit,
        detail: args.detail,
      });

    case 'calls':
      return handleTraceCalls({
        source: args.source,
        file: args.file,
        direction: direction as string | undefined,
        max_depth: maxDepth,
      });

    case 'effects':
      return handleTraceEffects({
        node: args.source,
        file: args.file,
        max_depth: maxDepth,
      });

    case 'alias':
      if (!args.file) {
        return errorResult('trace(along="alias") requires `file` (the file where the variable is defined).');
      }
      return handleTraceAlias({
        variableName: args.source,
        file: args.file,
      });

    case 'edges': {
      if (!edgeTypes || edgeTypes.length === 0) {
        return errorResult('trace(along="edges") requires `edge_types` (e.g. ["CALLS","DEPENDS_ON"]). Use get_stats(include=["schema"]) to see edge types.');
      }
      // traverse_graph is BFS over specific edge types from start node IDs.
      // Resolve a name/id source to a concrete node id when needed.
      const startId = await resolveNodeId(args.source, args.file);
      if (!startId) {
        return errorResult(`Source "${args.source}" not found. Provide a semantic ID or a resolvable name.`);
      }
      const dir = direction === 'backward' ? 'incoming' : 'outgoing';
      return handleTraverseGraph({
        startNodeIds: [startId],
        edgeTypes,
        maxDepth,
        direction: dir,
      });
    }

    default:
      return errorResult(`Unknown trace.along="${along}". Use one of: data, calls, effects, alias, edges.`);
  }
}

async function resolveNodeId(source: string, file?: string): Promise<string | null> {
  const db = await ensureAnalyzed();
  // Already a node id?
  const direct = await db.getNode(source);
  if (direct) return direct.id;
  // Resolve by name (optionally constrained by file).
  let fallback: GraphNode | null = null;
  for await (const node of db.queryNodes({ name: source })) {
    if (file && !node.file?.includes(file)) {
      if (!fallback) fallback = node;
      continue;
    }
    return node.id;
  }
  return fallback?.id ?? null;
}

// ===========================================================================
// explain_datalog — mode: fact | gap | sim
// ===========================================================================

export interface ExplainDatalogArgs {
  mode: 'fact' | 'gap' | 'sim';
  predicate: string;
  key?: string[];
  nodes?: Array<{ id: string; nodeType: string; name?: string; file?: string }>;
  edges?: Array<{ src: string; dst: string; edgeType: string }>;
  source?: string;
}

export async function handleExplainDatalog(args: ExplainDatalogArgs): Promise<ToolResult> {
  switch (args.mode) {
    case 'fact':
      return handleExplainFact({ predicate: args.predicate, key: args.key ?? [], source: args.source });
    case 'gap':
      return handleExplainGap({ predicate: args.predicate, key: args.key ?? [], source: args.source });
    case 'sim':
      return handleSimDatalog({ predicate: args.predicate, nodes: args.nodes, edges: args.edges, source: args.source });
    default:
      return errorResult(`Unknown explain_datalog.mode="${(args as { mode?: string }).mode}". Use one of: fact, gap, sim.`);
  }
}

// ===========================================================================
// get_node — detail (record|neighbors|context|full) + format (json|dsl)
//            + smart defaults by node kind + graph=knowledge
// ===========================================================================

export interface GetNodeRoutedArgs {
  target?: string;
  // legacy single-purpose spellings accepted during compat window
  semanticId?: string;
  detail?: 'record' | 'neighbors' | 'context' | 'full';
  format?: 'json' | 'dsl';
  graph?: GraphSel;
  edge_types?: string[];
  edgeTypes?: string[];
  perspective?: string;
  context_lines?: number;
  contextLines?: number;
  file?: string;
  // get_function_details compat
  name?: string;
  transitive?: boolean;
  // get_neighbors compat
  direction?: 'outgoing' | 'incoming' | 'both';
}

export async function handleGetNodeRouted(args: GetNodeRoutedArgs): Promise<ToolResult> {
  const target = pick(args.target, args.semanticId, args.name);
  if (!target) {
    return errorResult('get_node requires `target` (a semantic ID, node name, or file path).');
  }

  const graph = (args.graph ?? 'code') as GraphSel;
  if (graph === 'knowledge') {
    // Knowledge-graph entity inspection — explore its edges + metadata.
    return handleExploreEntity({ name: target });
  }

  const edgeTypes = pick(args.edge_types, args.edgeTypes);
  const ctxLines = pick(args.context_lines, args.contextLines);
  const format = args.format ?? 'json';

  // DSL format → describe (compact notation). perspective + context_lines(=depth) apply.
  if (format === 'dsl') {
    return handleDescribe({
      target,
      depth: ctxLines,
      perspective: args.perspective,
    });
  }

  const detail = args.detail ?? 'context';

  // Resolve node kind for smart defaults (only when not an explicit non-context detail).
  const db = await ensureAnalyzed();
  const node = await resolveNode(db, target, args.file);

  if (detail === 'record') {
    return handleGetNode({ semanticId: node?.id ?? target });
  }

  if (detail === 'neighbors') {
    return handleGetNeighbors({
      semanticId: node?.id ?? target,
      direction: args.direction ?? 'both',
      edgeTypes,
    });
  }

  if (detail === 'full') {
    // Comprehensive function/method details (callers + callees + transitive).
    return handleGetFunctionDetails({
      name: node?.name ?? target,
      file: args.file,
      transitive: args.transitive ?? true,
    });
  }

  // detail === 'context' → smart defaults by node kind.
  const kind = (node?.type as string | undefined)?.toUpperCase();
  const looksLikeFile = /[./]/.test(target) && /\.[a-z]+$/i.test(target);

  if (kind === 'MODULE' || (!node && looksLikeFile)) {
    return handleGetFileOverview({ file: node?.file ?? target, include_edges: true });
  }
  if (kind === 'CLASS' || kind === 'INTERFACE') {
    return handleGetShape({ target: node?.id ?? target, file: args.file });
  }

  // Default: source + full neighborhood context.
  return handleGetContext({
    semanticId: node?.id ?? target,
    contextLines: ctxLines,
    edgeType: edgeTypes && edgeTypes.length > 0 ? edgeTypes.join(',') : undefined,
  });
}

async function resolveNode(
  db: { getNode(id: string): Promise<GraphNode | null>; queryNodes(filter: Record<string, unknown>): AsyncIterable<GraphNode> },
  target: string,
  file?: string,
): Promise<GraphNode | null> {
  const direct = await db.getNode(target);
  if (direct) return direct;
  // Try as a MODULE by file path first (so a file path resolves to its module node).
  for await (const n of db.queryNodes({ file: target, type: 'MODULE' })) {
    return n;
  }
  let fallback: GraphNode | null = null;
  for await (const n of db.queryNodes({ name: target })) {
    if (file && !n.file?.includes(file)) {
      if (!fallback) fallback = n;
      continue;
    }
    return n;
  }
  return fallback;
}

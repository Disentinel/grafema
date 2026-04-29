#!/usr/bin/env node
/**
 * Compaction enricher — synthesizes shortcut edges between placed nodes
 * connected through hidden pass-through nodes (e.g. WRITES_TO+READS_FROM
 * pivoting on a hidden VARIABLE → STATE_FLOW edge from writer to reader).
 *
 * Wire-up: registered as a batch-mode plugin in the orchestrator config.
 * Receives `RFDB_SOCKET` and `RFDB_DATABASE` env vars; queries RFDB
 * directly via `@grafema/rfdb-client` and writes new edges back.
 *
 * Idempotency: each rule emits edges tagged with
 * `metadata._source = "compaction:<rule-name>"`. Before writing the rule
 * deletes all edges matching `(emit_type, source_tag)` via the server's
 * `DeleteEdgesByTypeAndSource` RPC, so re-runs reset state cleanly with
 * no accumulating array metadata across analyses (REG-1126 design lock).
 *
 * Confidence: V1 emits `confidence: "may"` only. The ranking that would
 * upgrade pairs to `must` requires control-flow reachability analysis
 * (REG-1125 — blocked).
 */

import { RFDBClient } from '@grafema/rfdb-client';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One compaction rule loaded from `compaction-rules.yaml`. The shape
 * mirrors the YAML structure 1:1; future rule types may extend with
 * additional pivot.* fields, but V1 supports only the symmetric
 * "incoming on hidden + incoming on hidden → emit between sources" form.
 */
interface DegreeFilter {
  edgeType: string;
  value: number;
}

interface Rule {
  name: string;
  description?: string;
  dependsOn: string[];
  hidden: {
    types: string[];
    /**
     * `module` keeps only hidden nodes whose nearest non-transparent
     * container is a MODULE / CLASS / IMPL_BLOCK / NAMESPACE — i.e. the
     * state crosses procedure boundaries. `all` skips the filter (used
     * for rules where intra-procedure pass-throughs still matter).
     */
    scope: 'module' | 'all';
    /**
     * Optional degree-based predicates. Evaluated AND-wise; a hidden
     * node passes only if every set predicate matches. Used by rules
     * like `trivial-wrappers` where the pivot is a FUNCTION with exactly
     * one outgoing CALLS edge — pure type-based filtering can't express
     * that. All counts are computed via `getOutgoingEdges` /
     * `getIncomingEdges` filtered by `edgeType` (one round-trip per
     * predicate per node).
     */
    filter?: {
      outDegreeEq?: DegreeFilter;
      outDegreeMax?: DegreeFilter;
      outDegreeMin?: DegreeFilter;
      inDegreeEq?: DegreeFilter;
      inDegreeMax?: DegreeFilter;
      inDegreeMin?: DegreeFilter;
    };
  };
  pivot: {
    in: { types: string[]; side: 'src' | 'dst' };
    out: { types: string[]; side: 'src' | 'dst' };
  };
  emit: {
    type: string;
    /** Free-form annotation. */
    direction: string;
  };
  fanoutCap: {
    perHidden: number;
    perRule: number;
  };
}

interface RulesFile {
  rules: Rule[];
}

interface PendingEdge {
  src: string;
  dst: string;
  primaryVia: string;
  viaCount: number;
}

// ---------------------------------------------------------------------------
// Container-type sets used by module-scope detection
// ---------------------------------------------------------------------------

/**
 * Containers that we walk THROUGH when looking for the "real" parent
 * — they're transparent because they don't define a unit of design,
 * just lexical or control-flow nesting.
 */
const TRANSPARENT_CONTAINERS = new Set([
  'SCOPE',
  'BLOCK',
  'LET_BLOCK',
  'DO_BLOCK',
  'LOOP',
  'BRANCH',
  'CASE',
  'TRY_BLOCK',
  'CATCH_BLOCK',
  'FINALLY_BLOCK',
  'EXPRESSION',
  'PATTERN',
]);

/**
 * The container types we accept as "module-scope" anchors. Anything
 * else (FUNCTION / METHOD / CLOSURE / LAMBDA / CONSTRUCTOR) means the
 * hidden node lives inside a single procedure — drop it.
 */
const MODULE_CONTAINERS = new Set([
  'MODULE',
  'CLASS',
  'IMPL_BLOCK',
  'NAMESPACE',
  'TRAIT',
  'INTERFACE',
]);

// ---------------------------------------------------------------------------
// Enricher entry point
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dirname, 'compaction-rules.yaml');

async function main(): Promise<void> {
  const socketPath = process.env.RFDB_SOCKET;
  const database = process.env.RFDB_DATABASE ?? 'default';
  if (!socketPath) {
    console.error('[compactionEnricher] RFDB_SOCKET not set; this plugin is meant to run via grafema-orchestrator (batch mode).');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(RULES_PATH, 'utf-8')) as RulesFile;
  const ordered = topoSort(config.rules ?? []);
  console.error(`[compactionEnricher] loaded ${ordered.length} rule(s) from ${RULES_PATH}`);

  const client = new RFDBClient(socketPath, 'compaction-enricher');
  await client.connect();
  await client.ping();
  // Concurrency 32 in applyRule means up to ~32 in-flight error
  // listeners on the socket per pending RPC. Default Node EventEmitter
  // cap is 10 → spurious "MaxListenersExceededWarning" floods stderr.
  // Lift it once at startup.
  const sock = (client as unknown as { socket?: { setMaxListeners?: (n: number) => void } }).socket;
  sock?.setMaxListeners?.(0);
  // Switch into the analyzed database — the server's default-database
  // selection mirrors `RFDB_DATABASE` so non-default analyses still
  // enrich the right graph.
  if (database !== 'default') {
    await sendRaw(client, 'openDatabase', { database });
  }

  for (const rule of ordered) {
    const t0 = Date.now();
    const stats = await applyRule(client, rule);
    const elapsed = Date.now() - t0;
    console.error(
      `[compactionEnricher] rule "${rule.name}": ${stats.deleted} stale removed, ` +
      `${stats.hiddenNodesScanned} hidden scanned (${stats.accepted} accepted), ` +
      `${stats.pairsEmitted} edges emitted in ${elapsed}ms`,
    );
  }

  await client.close();
}

// ---------------------------------------------------------------------------
// Topological sort over rule dependsOn DAG
// ---------------------------------------------------------------------------

function topoSort(rules: Rule[]): Rule[] {
  const byName = new Map(rules.map((r) => [r.name, r]));
  const visited = new Set<string>();
  const inProgress = new Set<string>();
  const out: Rule[] = [];

  function visit(rule: Rule): void {
    if (visited.has(rule.name)) return;
    if (inProgress.has(rule.name)) {
      throw new Error(`Cycle detected in compaction rule deps at "${rule.name}"`);
    }
    inProgress.add(rule.name);
    for (const dep of rule.dependsOn ?? []) {
      const target = byName.get(dep);
      if (!target) {
        throw new Error(`Rule "${rule.name}" depends on unknown rule "${dep}"`);
      }
      visit(target);
    }
    inProgress.delete(rule.name);
    visited.add(rule.name);
    out.push(rule);
  }

  for (const r of rules) visit(r);
  return out;
}

// ---------------------------------------------------------------------------
// Rule application
// ---------------------------------------------------------------------------

interface RuleStats {
  deleted: number;
  hiddenNodesScanned: number;
  /** Hidden nodes that passed scope + filter predicates. */
  accepted: number;
  pairsEmitted: number;
}

/**
 * Run a rule's degree-based filter against a single hidden node. Each
 * predicate is one network call (filtered getOutgoing/getIncomingEdges)
 * — short-circuit on the first failure to avoid extra work.
 */
async function passesDegreeFilter(
  client: RFDBClient,
  hiddenId: string,
  filter: NonNullable<Rule['hidden']['filter']>,
): Promise<boolean> {
  type Side = 'out' | 'in';
  type Op = 'eq' | 'max' | 'min';
  const checks: Array<{ key: keyof typeof filter; side: Side; op: Op }> = [
    { key: 'outDegreeEq',  side: 'out', op: 'eq'  },
    { key: 'outDegreeMax', side: 'out', op: 'max' },
    { key: 'outDegreeMin', side: 'out', op: 'min' },
    { key: 'inDegreeEq',   side: 'in',  op: 'eq'  },
    { key: 'inDegreeMax',  side: 'in',  op: 'max' },
    { key: 'inDegreeMin',  side: 'in',  op: 'min' },
  ];
  for (const { key, side, op } of checks) {
    const cfg = filter[key];
    if (!cfg) continue;
    const edges =
      side === 'out'
        ? await client.getOutgoingEdges(hiddenId, [cfg.edgeType])
        : await client.getIncomingEdges(hiddenId, [cfg.edgeType]);
    const count = edges.length;
    if (op === 'eq' && count !== cfg.value) return false;
    if (op === 'max' && count > cfg.value) return false;
    if (op === 'min' && count < cfg.value) return false;
  }
  return true;
}

async function applyRule(client: RFDBClient, rule: Rule): Promise<RuleStats> {
  const sourceTag = `compaction:${rule.name}`;

  // 1. Cleanup previous emits — stateless idempotency. Server refuses
  //    if a different writer's edges of `rule.emit.type` exist with a
  //    conflicting `_source`, so the rule's emit type is effectively
  //    reserved (e.g. STATE_FLOW belongs to compaction:state-flow).
  const cleanup = await sendRaw<{ deleted?: number }>(client, 'deleteEdgesByTypeAndSource', {
    edgeType: rule.emit.type,
    sourceTag,
  });
  const deleted = cleanup?.deleted ?? 0;

  // 2. Find hidden candidate nodes by type. findByType returns IDs only,
  //    so we don't pay for full node hydration. The typed client wrapper
  //    unwraps the `{ids}` envelope — we'd lose that going through
  //    sendRaw.
  const hiddenIds: string[] = [];
  for (const t of rule.hidden.types) {
    const ids = await client.findByType(t);
    hiddenIds.push(...ids);
  }

  // 3. Aggregate pairs across all hidden nodes. Map key is `${src}|${dst}`,
  //    value is `{primaryVia, viaCount}` — primaryVia is the first hidden
  //    ID we observed for the pair (deterministic because hiddenIds order
  //    is stable across runs given the same engine state).
  const pairs = new Map<string, PendingEdge>();
  let acceptedCount = 0;
  let perRuleCount = 0;

  // Process hidden ids in concurrent chunks. The unix socket multiplexes
  // requests via `requestId`, so pipelining ~32 in-flight RPCs hides
  // per-request overhead even though the server processes them serially
  // under the engine lock. Chunk size tuned for ~10x speedup over
  // sequential without pushing the server into request-queue contention.
  const CONCURRENCY = 32;
  for (let chunkStart = 0; chunkStart < hiddenIds.length; chunkStart += CONCURRENCY) {
    if (perRuleCount >= rule.fanoutCap.perRule) break;
    const chunk = hiddenIds.slice(chunkStart, chunkStart + CONCURRENCY);
    // Per chunk: gather (writers, readers, hid) tuples for ids that
    // pass scope+filter+empty-pivot checks. Resolves in parallel; the
    // sequential aggregation step below preserves cap semantics.
    const resolved = await Promise.all(chunk.map(async (hid) => {
      if (rule.hidden.scope === 'module') {
        if (!(await isModuleScope(client, hid))) return null;
      }
      if (rule.hidden.filter) {
        if (!(await passesDegreeFilter(client, hid, rule.hidden.filter))) return null;
      }
      // pivot.out first — short-circuits high-volume rules (most CALLs
      // lack a resolved CALLS edge, etc.).
      const outSources = await collectOppositeEndpoints(client, hid, rule.pivot.out);
      if (outSources.size === 0) return { accepted: true, pair: null };
      const inSources = await collectOppositeEndpoints(client, hid, rule.pivot.in);
      if (inSources.size === 0) return { accepted: true, pair: null };
      const writers = await resolveAllToPlaced(client, [...inSources]);
      const readers = await resolveAllToPlaced(client, [...outSources]);
      if (writers.size === 0 || readers.size === 0) return { accepted: true, pair: null };
      return { accepted: true, pair: { hid, writers, readers } };
    }));

    for (const r of resolved) {
      if (!r) continue;
      acceptedCount++;
      if (!r.pair) continue;
      const { hid, writers, readers } = r.pair;
      let perHiddenCount = 0;
      outer: for (const w of writers) {
        for (const rr of readers) {
          if (w === rr) continue;
          if (perHiddenCount >= rule.fanoutCap.perHidden) break outer;
          const key = `${w}|${rr}`;
          const existing = pairs.get(key);
          if (existing) {
            existing.viaCount++;
          } else {
            pairs.set(key, { src: w, dst: rr, primaryVia: hid, viaCount: 1 });
            perRuleCount++;
          }
          perHiddenCount++;
          if (perRuleCount >= rule.fanoutCap.perRule) break outer;
        }
      }
    }
  }

  // 4. Insert in one batched call. Edge metadata carries the source tag
  //    (so the next run can clean it up) plus the primary via + count
  //    so subview UX (REG-1126) can display "shared via X (and N more)".
  const edges = [...pairs.values()].map((p) => ({
    src: p.src,
    dst: p.dst,
    edgeType: rule.emit.type,
    metadata: {
      _source: sourceTag,
      confidence: 'may' as const,
      primaryVia: p.primaryVia,
      viaCount: p.viaCount,
    },
  }));
  if (edges.length > 0) {
    await sendRaw(client, 'addEdges', {
      edges: edges.map((e) => ({
        src: e.src,
        dst: e.dst,
        edgeType: e.edgeType,
        metadata: JSON.stringify(e.metadata),
      })),
      skipValidation: false,
    });
    // Flush + rebuildIndexes so OTHER processes see the writes after
    // this enricher exits. CAVEAT: this writer's own session does NOT
    // see its writes via subsequent getOutgoingEdges/countEdgesByType
    // calls — engine has session-level snapshot semantics. Rules that
    // depend on a previous rule's emits via RFDB read won't work; for
    // those, use in-memory chaining (TODO).
    await sendRaw(client, 'flush', {});
    await sendRaw(client, 'rebuildIndexes', {});
  }

  return {
    deleted,
    hiddenNodesScanned: hiddenIds.length,
    accepted: acceptedCount,
    pairsEmitted: edges.length,
  };
}

/**
 * Get the opposite-side endpoint IDs for every edge of `pivot.types`
 * touching the hidden node on `pivot.side`. For `side: dst` we list
 * incoming edges and return their `src`; symmetric for `side: src`.
 */
async function collectOppositeEndpoints(
  client: RFDBClient,
  hiddenId: string,
  pivot: { types: string[]; side: 'src' | 'dst' },
): Promise<Set<string>> {
  const out = new Set<string>();
  if (pivot.side === 'dst') {
    const edges = await client.getIncomingEdges(hiddenId, pivot.types);
    for (const e of edges) out.add(e.src);
  } else {
    const edges = await client.getOutgoingEdges(hiddenId, pivot.types);
    for (const e of edges) out.add(e.dst);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CONTAINS-walk helpers
// ---------------------------------------------------------------------------

/** Cache of node-id → resolved placed ancestor (or null if none). */
const placedAncestorCache = new Map<string, string | null>();
/** Cache of node-id → its (typed) parent via analyzer-CONTAINS. */
const parentCache = new Map<string, { id: string; type: string } | null>();

/**
 * Walk analyzer-CONTAINS upward from `nodeId` until the first placeable
 * ancestor (FUNCTION / METHOD / CLASS / etc — anything in PLACEABLE_TYPES
 * minus the ones we treat as transparent). Returns null if no such
 * ancestor exists within the depth cap.
 *
 * Layout-pack CONTAINS is filtered out — we only follow the AST graph.
 * Cap of 32 protects against malformed cycles.
 */
async function resolveToPlaced(client: RFDBClient, startId: string): Promise<string | null> {
  if (placedAncestorCache.has(startId)) return placedAncestorCache.get(startId)!;
  // Self-check first: if startId is itself a placeable node (e.g. a
  // FUNCTION that's the dst of a CALLS edge — already terminal), return
  // its own id without walking. Walking up from a placeable node would
  // jump past it to whatever contains it, which mis-attributes edges.
  const startType = await getNodeType(client, startId);
  if (startType && isPlaceable(startType)) {
    placedAncestorCache.set(startId, startId);
    return startId;
  }
  let cur = startId;
  for (let i = 0; i < 32; i++) {
    const parent = await getAnalyzerParent(client, cur);
    if (!parent) {
      placedAncestorCache.set(startId, null);
      return null;
    }
    if (isPlaceable(parent.type)) {
      placedAncestorCache.set(startId, parent.id);
      return parent.id;
    }
    cur = parent.id;
  }
  placedAncestorCache.set(startId, null);
  return null;
}

async function resolveAllToPlaced(client: RFDBClient, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  // Sequential walk — pipelining via Promise.all is tempting but the
  // RFDB socket is a single-multiplexed channel; concurrent _send calls
  // serialize internally and the cache hits dominate after the first
  // few hundred lookups anyway.
  for (const id of ids) {
    const placed = await resolveToPlaced(client, id);
    if (placed) out.add(placed);
  }
  return out;
}

async function getAnalyzerParent(
  client: RFDBClient,
  nodeId: string,
): Promise<{ id: string; type: string } | null> {
  if (parentCache.has(nodeId)) return parentCache.get(nodeId)!;
  // The graph uses two parent-edge models depending on node type:
  //   - VARIABLE / CONSTANT / CALL ← CONTAINS ← (SCOPE | FUNCTION | MODULE)
  //   - SCOPE ← HAS_SCOPE ← (SCOPE | FUNCTION | MODULE)
  // SCOPE itself has no incoming CONTAINS — only HAS_SCOPE — so walking
  // up from a CALL through its SCOPE parent dead-ends unless we follow
  // HAS_SCOPE too. Try CONTAINS first (the AST containment), then fall
  // back to HAS_SCOPE if no CONTAINS parent surfaced. layout-pack
  // CONTAINS is filtered out — we only follow analyzer edges.
  const tryEdges = async (edgeType: string) => {
    const incoming = await client.getIncomingEdges(nodeId, [edgeType]);
    for (const e of incoming) {
      const meta = (e as Record<string, unknown>)._source ?? (e as Record<string, unknown>).source;
      if (typeof meta === 'string' && meta.includes('layout-pack')) continue;
      const parentType = await getNodeType(client, e.src);
      if (parentType) {
        const v = { id: e.src, type: parentType };
        return v;
      }
    }
    return null;
  };
  const viaContains = await tryEdges('CONTAINS');
  if (viaContains) {
    parentCache.set(nodeId, viaContains);
    return viaContains;
  }
  const viaHasScope = await tryEdges('HAS_SCOPE');
  if (viaHasScope) {
    parentCache.set(nodeId, viaHasScope);
    return viaHasScope;
  }
  parentCache.set(nodeId, null);
  return null;
}

const nodeTypeCache = new Map<string, string | null>();

async function getNodeType(client: RFDBClient, id: string): Promise<string | null> {
  if (nodeTypeCache.has(id)) return nodeTypeCache.get(id)!;
  // RPC returns `{requestId, node: { nodeType, ... }}` — sendRaw bypasses
  // the typed wrapper that would unwrap the envelope, so we drill in
  // here.
  const resp = await sendRaw<{
    node?: { nodeType?: string; type?: string };
    nodeType?: string;
    type?: string;
  }>(client, 'getNode', { id });
  const t =
    resp?.node?.nodeType ??
    resp?.node?.type ??
    resp?.nodeType ??
    resp?.type ??
    null;
  nodeTypeCache.set(id, t);
  return t;
}

/**
 * Module-scope check — walks transparent containers up the CONTAINS chain
 * until the first non-transparent ancestor and asserts it's in
 * MODULE_CONTAINERS. A `LOCAL_VAR` inside a FUNCTION would walk
 * through SCOPE/BLOCK and stop at FUNCTION → returns false.
 */
async function isModuleScope(client: RFDBClient, hiddenId: string): Promise<boolean> {
  let cur = hiddenId;
  for (let i = 0; i < 32; i++) {
    const parent = await getAnalyzerParent(client, cur);
    if (!parent) return false;
    if (TRANSPARENT_CONTAINERS.has(parent.type)) {
      cur = parent.id;
      continue;
    }
    return MODULE_CONTAINERS.has(parent.type);
  }
  return false;
}

/**
 * Subset of orchestrator's PLACEABLE_TYPES (kept in sync manually for
 * now — see `packages/rfdb-server/src/layout_types.rs`). Used to decide
 * whether a CONTAINS-walked ancestor is a valid placed redirect target.
 *
 * If this drifts from the server-side list, the enricher emits edges
 * to nodes the GUI doesn't display. Drift will surface as edges with
 * unresolvable endpoints in the viz; that's the canary.
 */
const PLACEABLE_TYPES = new Set([
  'FUNCTION',
  'METHOD',
  'CLASS',
  'TYPE_ALIAS',
  'TYPE_SYNONYM',
  'TYPE_CLASS',
  'DATA_TYPE',
  'ENUM',
  'STRUCT',
  'TRAIT',
  'IMPL_BLOCK',
  'INSTANCE',
  'NAMESPACE',
  'MACRO',
  'PROCESS',
  'MESSAGE_TYPE',
  'ASYNC_FUNCTION',
  'GLOBAL_DEFINITION',
  'EXTERNAL_FUNCTION',
  'EXTERNAL_MODULE',
  'CLOSURE',
  'LAMBDA',
  'CONSTRUCTOR',
]);

function isPlaceable(nodeType: string): boolean {
  return PLACEABLE_TYPES.has(nodeType);
}

// ---------------------------------------------------------------------------
// Low-level RPC dispatch (the rfdb-client class doesn't expose every
// JSON-RPC method as a typed wrapper; for these we go through `_send`).
// ---------------------------------------------------------------------------

async function sendRaw<T>(client: RFDBClient, method: string, params: unknown): Promise<T> {
  // The base client's `_send` is private but used widely across the
  // codebase. We treat it as the de-facto RPC dispatch surface; any
  // future typed wrapper can replace these calls without changing
  // semantics.
  return (client as unknown as {
    _send: (m: string, p?: unknown) => Promise<T>;
  })._send(method, params);
}

// ---------------------------------------------------------------------------

void main().catch((err) => {
  console.error('[compactionEnricher] fatal:', err);
  process.exit(1);
});

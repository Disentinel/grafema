/**
 * behaviorEnricher — L3 BEHAVIOR extraction.
 *
 * For every FEATURE-class node (cli:command, mcp:tool, vscode:command), walk
 * the HANDLES edge to the entry function, run a forward-slice dataflow trace
 * to collect the reachable subgraph, classify each reached node as core or
 * periphery using per-file coupling/density heuristics, and capture the
 * transitive effects. Each FEATURE then gets:
 *
 *   FEATURE -IMPLEMENTED_BY-> BEHAVIOR
 *   BEHAVIOR -COMPRISES-> coreNode      (metadata: {"role":"core"})
 *   BEHAVIOR -COMPRISES-> peripheryNode (metadata: {"role":"periphery"})
 *   BEHAVIOR -PRODUCES_EFFECT-> __effects/IO  (metadata: {"effect":"IO"})
 *
 * Pass 2 deduplicates: BEHAVIORs whose core-set hash matches get linked via
 * SHARES_BEHAVIOR_WITH edges between their FEATUREs (bidirectional).
 *
 * Idempotent: BEHAVIOR id is `${feature.id}::behavior`, COMPRISES/PRODUCES_EFFECT
 * targets and edges form deterministic (src,dst,edgeType) tuples that RFDB
 * dedupes.
 *
 * Like sibling enrichers, this uses direct addNodes/addEdges (not BatchHandle
 * .commit) — see skill `rfdb-batchhandle-deletes-existing-nodes`.
 */

import { createHash } from 'crypto';
import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireEdge, WireNode } from '@grafema/types';
import type { EffectsLookup } from '../manifest/effects-lookup.js';
import type { DataflowBackend, DataflowNode, DataflowEdge } from '../queries/traceDataflow.js';
import { traceDataflow } from '../queries/traceDataflow.js';
import { traceEffects } from '../queries/traceEffects.js';
import type { EffectType } from '../manifest/types.js';

/** Bound on per-file metrics cache. At 149-feature scale Grafema has <1k unique
 *  files but on huge polyrepos this can grow. LRU eviction keeps memory flat. */
const FILE_METRICS_CACHE_MAX = 200;

/** ---------------------------------------------------------------------------
 *  Public types
 *  ------------------------------------------------------------------------ */

export interface BehaviorEnrichResult {
  /** Number of BEHAVIOR nodes created (one per FEATURE that had an entry). */
  behaviorsCreated: number;
  /** Total core COMPRISES edges across all behaviors. */
  totalCoreNodes: number;
  /** Total periphery COMPRISES edges across all behaviors (capped per-behavior). */
  totalPeripheryNodes: number;
  /** Total PRODUCES_EFFECT edges emitted. */
  effectEdgesEmitted: number;
  /** Total SHARES_BEHAVIOR_WITH edges emitted (bidirectional, so always even). */
  sharesBehaviorEdges: number;
  /** Diagnostic: features whose HANDLES edge was missing or pointed at a
   *  non-existent target. */
  featuresWithoutEntry: number;
}

export interface BehaviorEnrichOptions {
  /** Forward-slice depth limit. Default 10. */
  maxDepth?: number;
  /** Cap on COMPRISES edges to periphery nodes per behavior. Default 50. */
  peripheryEdgeCap?: number;
  /**
   * Flush accumulated nodes/edges to RFDB after every N processed features.
   * Default 10. Lower values reduce peak memory at the cost of more round-trips
   * to the server. At Grafema scale (~150 features × hundreds of subgraph
   * nodes/edges each), batching all writes until the end exhausts Node.js
   * heap — chunked flushing keeps memory bounded.
   */
  flushBatchSize?: number;
}

/** ---------------------------------------------------------------------------
 *  Internal types
 *  ------------------------------------------------------------------------ */

interface FileMetrics {
  coupling: number;
  density: number;
  isLibrary: boolean;
}

interface BehaviorRecord {
  featureId: string;
  hash: string;
}

/** FEATURE-class node types we extract behaviors for. */
const FEATURE_TYPES: readonly string[] = ['cli:command', 'mcp:tool', 'vscode:command'];

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_PERIPHERY_CAP = 50;
const DEFAULT_FLUSH_BATCH_SIZE = 10;
const SHARES_EDGE_FLUSH_SIZE = 200;
const LIBRARY_DENSITY_THRESHOLD = 0.3;

/** ---------------------------------------------------------------------------
 *  Public entry point
 *  ------------------------------------------------------------------------ */

export async function enrichBehaviors(
  client: RFDBClient,
  effectsLookup: EffectsLookup,
  options?: BehaviorEnrichOptions,
): Promise<BehaviorEnrichResult> {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const peripheryCap = options?.peripheryEdgeCap ?? DEFAULT_PERIPHERY_CAP;
  const flushBatchSize = Math.max(1, options?.flushBatchSize ?? DEFAULT_FLUSH_BATCH_SIZE);

  const result: BehaviorEnrichResult = {
    behaviorsCreated: 0,
    totalCoreNodes: 0,
    totalPeripheryNodes: 0,
    effectEdgesEmitted: 0,
    sharesBehaviorEdges: 0,
    featuresWithoutEntry: 0,
  };

  // Wrap RFDBClient as a DataflowBackend for traceDataflow / traceEffects.
  const dfDb = makeDataflowBackend(client);

  // Per-batch accumulators. Reset to fresh arrays after each flush so the
  // previous batch's WireNode/WireEdge objects become unreachable and
  // available for GC. (Avoids holding ~150 features' worth of subgraph
  // metadata in memory simultaneously.)
  let batchNodes: WireNode[] = [];
  let batchEdges: WireEdge[] = [];
  const seenBehaviorIds = new Set<string>();
  const fileMetricsCache = new Map<string, FileMetrics>();
  // Small index — only featureId + 64-char hash per behavior, kept across
  // the whole run to compute SHARES_BEHAVIOR_WITH in Pass 2.
  const behaviorRecords: BehaviorRecord[] = [];
  let processedSinceFlush = 0;

  // ── Pass 1: per-feature forward-slice + classify + emit ──
  for (const featureType of FEATURE_TYPES) {
    const features: WireNode[] = [];
    for await (const f of client.queryNodes({ type: featureType })) features.push(f);

    for (const feature of features) {
      const behaviorId = `${feature.id}::behavior`;
      if (seenBehaviorIds.has(behaviorId)) continue;
      seenBehaviorIds.add(behaviorId);

      // 1. Locate entry function via HANDLES.
      const handlesEdges = await client.getOutgoingEdges(feature.id, ['HANDLES'] as never);
      if (handlesEdges.length === 0) {
        result.featuresWithoutEntry++;
        continue;
      }
      const entryId = String(handlesEdges[0].dst);
      const entry = await client.getNode(entryId);
      if (!entry) {
        result.featuresWithoutEntry++;
        continue;
      }

      // 2. Forward-slice the entry. We combine two reachabilities:
      //    a) traceDataflow forward — captures consumers of the entry's
      //       return value, return-flow boundaries, etc.
      //    b) call-graph BFS — captures everything the entry CALLS (transitive
      //       callees + their bodies). traceDataflow forward from a FUNCTION
      //       walks callers (not callees), so we add the call-graph leg
      //       separately to honour the "forward slice = what this code
      //       reaches" semantic.
      //
      // Memory note: at 149-FEATURE scale, traceDataflow's `reached` array holds
      // thousands of full DataflowNode objects per feature. We only need
      // `{id, file, type}` per node for classification — extract immediately and
      // drop the heavy result so it becomes GC-eligible before the next call.
      const subgraphMin: { id: string; file?: string; type: string }[] = [];
      const subgraphIds = new Set<string>();
      const entryDf = await dfDb.getNode(entryId);
      if (entryDf) {
        subgraphMin.push({ id: entryDf.id, file: entryDf.file, type: entryDf.type });
        subgraphIds.add(entryDf.id);
      }

      {
        // Run traceDataflow inside a block so its result is unreferenced after
        // we exit the block (no lingering closure binding).
        const traces = await traceDataflow(dfDb, entryId, {
          direction: 'forward',
          maxDepth,
        });
        for (const t of traces) {
          for (const n of t.reached) {
            if (!subgraphIds.has(n.id)) {
              subgraphMin.push({ id: n.id, file: n.file, type: n.type });
              subgraphIds.add(n.id);
            }
          }
        }
        // Explicit clear of the per-result `reached` arrays helps V8 release
        // memory under tight heap budgets even if the outer ref is still live
        // for one more tick.
        for (const t of traces) (t as { reached: DataflowNode[] }).reached = [];
      }

      // Call-graph forward BFS from entry (CALLS / CALL→CALLS chain).
      // We also extract minimal records here, never retaining full nodes.
      const cgQueue: string[] = [entryId];
      const cgVisited = new Set<string>([entryId]);
      let cgIters = 0;
      const cgIterCap = (maxDepth + 1) * 200;
      while (cgQueue.length > 0 && cgIters < cgIterCap) {
        cgIters++;
        const cur = cgQueue.shift() as string;
        const outs = await dfDb.getOutgoingEdges(cur, ['CALLS', 'HAS_SCOPE', 'CONTAINS']);
        for (const e of outs) {
          if (cgVisited.has(e.dst)) continue;
          cgVisited.add(e.dst);
          const nx = await dfDb.getNode(e.dst);
          if (!nx) continue;
          // Skip pure scope nodes from being COMPRISES targets — they're
          // structural, not behavioural.
          if (nx.type !== 'SCOPE' && !subgraphIds.has(nx.id)) {
            subgraphMin.push({ id: nx.id, file: nx.file, type: nx.type });
            subgraphIds.add(nx.id);
          }
          cgQueue.push(nx.id);
        }
      }

      // 3. Effects via traceEffects.
      // Same pattern: capture only the EffectType set and drop the heavy result
      // (LeafSource[] + BoundaryCrossing[] arrays can hold hundreds of records
      // each per feature on real codebases).
      const effectSet = new Set<EffectType>();
      {
        const eff = await traceEffects(dfDb, entryId, effectsLookup, { maxDepth });
        if (eff) {
          for (const e of eff.transitive) effectSet.add(e);
          // Free the heavy arrays before exiting the block.
          eff.leaf_sources.length = 0;
          eff.boundary_crossings.length = 0;
        }
      }

      // 4. Classify each subgraph node by file metrics (lazy per-file compute).
      const coreIds: string[] = [];
      const peripheryIds: string[] = [];
      for (const n of subgraphMin) {
        const file = n.file;
        if (!file) {
          // No file → treat as core (synthetic node, can't classify as library).
          coreIds.push(n.id);
          continue;
        }
        const metrics = await getFileMetrics(client, dfDb, file, fileMetricsCache);
        if (metrics.isLibrary) {
          peripheryIds.push(n.id);
        } else {
          coreIds.push(n.id);
        }
      }
      // subgraphMin / subgraphIds / cgVisited are loop-locals — GC reclaims them
      // when the iteration ends. Explicitly truncate the largest one to make
      // the release deterministic under heap pressure.
      subgraphMin.length = 0;
      subgraphIds.clear();
      cgVisited.clear();

      // 5. Behavior identity hash from sorted core IDs.
      const sortedCore = [...coreIds].sort();
      const hash = createHash('sha256')
        .update(sortedCore.join(','))
        .digest('hex');

      // 6. Emit BEHAVIOR node.
      const effectsArr = [...effectSet].sort();
      batchNodes.push({
        id: behaviorId,
        nodeType: 'BEHAVIOR' as never,
        name: feature.name,
        file: feature.file,
        exported: false,
        metadata: JSON.stringify({
          coreNodeCount: coreIds.length,
          peripheryNodeCount: peripheryIds.length,
          depth: maxDepth,
          hash,
          effects: effectsArr,
          featureId: feature.id,
        }),
      });

      // 7. FEATURE -IMPLEMENTED_BY-> BEHAVIOR
      batchEdges.push({
        src: feature.id,
        dst: behaviorId,
        edgeType: 'IMPLEMENTED_BY' as never,
        metadata: JSON.stringify({}),
      });

      // 8. BEHAVIOR -COMPRISES-> core nodes
      for (const id of coreIds) {
        batchEdges.push({
          src: behaviorId,
          dst: id,
          edgeType: 'COMPRISES' as never,
          metadata: JSON.stringify({ role: 'core' }),
        });
      }
      result.totalCoreNodes += coreIds.length;

      // 9. BEHAVIOR -COMPRISES-> periphery (capped)
      const peripherySliced = peripheryIds.slice(0, peripheryCap);
      for (const id of peripherySliced) {
        batchEdges.push({
          src: behaviorId,
          dst: id,
          edgeType: 'COMPRISES' as never,
          metadata: JSON.stringify({ role: 'periphery' }),
        });
      }
      result.totalPeripheryNodes += peripherySliced.length;

      // 10. BEHAVIOR -PRODUCES_EFFECT-> synthetic effect target
      for (const e of effectsArr) {
        batchEdges.push({
          src: behaviorId,
          dst: `__effects/${e}`,
          edgeType: 'PRODUCES_EFFECT' as never,
          metadata: JSON.stringify({ effect: e }),
        });
        result.effectEdgesEmitted++;
      }

      result.behaviorsCreated++;
      behaviorRecords.push({ featureId: feature.id, hash });
      processedSinceFlush++;

      // Chunked flush — every flushBatchSize features, ship the accumulated
      // nodes/edges and reset. Re-assigning to fresh arrays (instead of
      // .splice / .length=0) guarantees the previous arrays' contents are
      // GC-eligible immediately.
      if (processedSinceFlush >= flushBatchSize) {
        if (batchNodes.length > 0) {
          await client.addNodes(batchNodes);
          batchNodes = [];
        }
        if (batchEdges.length > 0) {
          await client.addEdges(batchEdges);
          batchEdges = [];
        }
        processedSinceFlush = 0;
        // Yield to event loop so V8 has an opportunity to run incremental GC
        // between batches. Without this yield, a long synchronous chain of
        // awaited RFDB roundtrips can keep the heap growing past the limit
        // before any GC pass runs.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  // Final flush of any leftover Pass-1 nodes/edges before we move to Pass 2.
  if (batchNodes.length > 0) {
    await client.addNodes(batchNodes);
    batchNodes = [];
  }
  if (batchEdges.length > 0) {
    await client.addEdges(batchEdges);
    batchEdges = [];
  }

  // ── Pass 2: link FEATUREs that share a behavior hash ──
  // Pure in-memory bucketing: behaviorRecords is small (one record per
  // feature, ~64 bytes hash + featureId).
  const byHash = new Map<string, string[]>();
  for (const b of behaviorRecords) {
    let arr = byHash.get(b.hash);
    if (!arr) {
      arr = [];
      byHash.set(b.hash, arr);
    }
    arr.push(b.featureId);
  }

  // Flush SHARES_BEHAVIOR_WITH edges in chunks of SHARES_EDGE_FLUSH_SIZE.
  // For N features sharing a hash there are N*(N-1) directed edges, which
  // can spike for large clusters — chunked emission keeps the buffer bounded.
  let edgeBatch: WireEdge[] = [];
  for (const featureIds of byHash.values()) {
    if (featureIds.length < 2) continue;
    for (let i = 0; i < featureIds.length; i++) {
      for (let j = i + 1; j < featureIds.length; j++) {
        edgeBatch.push({
          src: featureIds[i],
          dst: featureIds[j],
          edgeType: 'SHARES_BEHAVIOR_WITH' as never,
          metadata: JSON.stringify({}),
        });
        edgeBatch.push({
          src: featureIds[j],
          dst: featureIds[i],
          edgeType: 'SHARES_BEHAVIOR_WITH' as never,
          metadata: JSON.stringify({}),
        });
        result.sharesBehaviorEdges += 2;
        if (edgeBatch.length >= SHARES_EDGE_FLUSH_SIZE) {
          await client.addEdges(edgeBatch);
          edgeBatch = [];
        }
      }
    }
  }
  if (edgeBatch.length > 0) {
    await client.addEdges(edgeBatch);
    edgeBatch = [];
  }

  return result;
}

/** ---------------------------------------------------------------------------
 *  File metrics (core/periphery classification)
 *  ------------------------------------------------------------------------ */

async function getFileMetrics(
  client: RFDBClient,
  dfDb: DataflowBackend,
  file: string,
  cache: Map<string, FileMetrics>,
): Promise<FileMetrics> {
  const cached = cache.get(file);
  if (cached) return cached;

  const fnIds: string[] = [];
  const fnAsyncFlags = new Map<string, boolean>();
  for await (const fn of client.queryNodes({ type: 'FUNCTION', file })) {
    fnIds.push(fn.id);
    const meta = parseMeta(fn);
    fnAsyncFlags.set(fn.id, meta?.async === true);
  }

  const nFunctions = fnIds.length;

  // Coupling = intra-file (CALLS|READS_FROM) edges between functions / total possible.
  let intraEdges = 0;
  for (const id of fnIds) {
    const outs = await client.getOutgoingEdges(id, ['CALLS', 'READS_FROM'] as never);
    for (const e of outs) {
      const dstId = String(e.dst);
      // Same-file targets only — fast path: check the in-memory fn list.
      if (fnIds.includes(dstId) && dstId !== id) intraEdges++;
    }
  }
  const coupling = nFunctions > 1 ? intraEdges / (nFunctions * (nFunctions - 1)) : 0;

  // Effect density = fraction of fns with async:true OR any THROWS edge.
  let withEffect = 0;
  for (const id of fnIds) {
    if (fnAsyncFlags.get(id)) {
      withEffect++;
      continue;
    }
    const throwsEdges = await dfDb.getOutgoingEdges(id, ['THROWS']);
    if (throwsEdges.length > 0) withEffect++;
  }
  const density = nFunctions > 0 ? withEffect / nFunctions : 0;

  const isLibrary = coupling === 0 && density < LIBRARY_DENSITY_THRESHOLD;

  const metrics: FileMetrics = { coupling, density, isLibrary };
  // LRU eviction — Map preserves insertion order, so deleting + re-inserting
  // moves an entry to "most recent" and the oldest entry sits at the head.
  if (cache.size >= FILE_METRICS_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(file, metrics);
  return metrics;
}

/** ---------------------------------------------------------------------------
 *  RFDBClient → DataflowBackend adapter
 *  ------------------------------------------------------------------------ */

/**
 * Wrap an RFDBClient as a DataflowBackend by parsing each WireNode's JSON
 * metadata and projecting it onto the DataflowNode shape (type from nodeType,
 * spread metadata fields). Edges already arrive flattened from the base client.
 */
function makeDataflowBackend(client: RFDBClient): DataflowBackend {
  function parseNode(wn: WireNode | null): DataflowNode | null {
    if (!wn) return null;
    let meta: Record<string, unknown> = {};
    if (wn.metadata) {
      try {
        meta = JSON.parse(wn.metadata) as Record<string, unknown>;
      } catch {
        meta = {};
      }
    }
    // Strip wire-level fields from the metadata spread to avoid clobbering.
    const {
      id: _id,
      type: _type,
      name: _name,
      file: _file,
      exported: _exported,
      nodeType: _nodeType,
      ...rest
    } = meta;
    void _id; void _type; void _name; void _file; void _exported; void _nodeType;
    return {
      id: wn.id,
      type: wn.nodeType,
      name: wn.name,
      file: wn.file,
      ...rest,
    };
  }

  function parseEdge(e: WireEdge & Record<string, unknown>): DataflowEdge {
    // base-client.getOutgoingEdges already spreads metadata onto the edge and
    // sets `type`; we just re-shape into DataflowEdge.
    const top = e as unknown as Record<string, unknown>;
    const idx = typeof top.index === 'number' ? top.index : undefined;
    return {
      src: e.src,
      dst: e.dst,
      type: (top.type as string) ?? e.edgeType,
      ...(idx !== undefined ? { index: idx } : {}),
      metadata: top,
    };
  }

  return {
    async getNode(id: string): Promise<DataflowNode | null> {
      return parseNode(await client.getNode(id));
    },
    async *queryNodes(filter: Record<string, unknown>): AsyncIterable<DataflowNode> {
      for await (const wn of client.queryNodes(filter as never)) {
        const parsed = parseNode(wn);
        if (parsed) yield parsed;
      }
    },
    async getOutgoingEdges(id: string, types?: string[] | null): Promise<DataflowEdge[]> {
      const edges = await client.getOutgoingEdges(id, (types ?? null) as never);
      return edges.map(parseEdge);
    },
    async getIncomingEdges(id: string, types?: string[] | null): Promise<DataflowEdge[]> {
      const edges = await client.getIncomingEdges(id, (types ?? null) as never);
      return edges.map(parseEdge);
    },
  };
}

/** ---------------------------------------------------------------------------
 *  Helpers
 *  ------------------------------------------------------------------------ */

function parseMeta(node: WireNode): Record<string, unknown> | null {
  if (!node.metadata) return null;
  try {
    return JSON.parse(node.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * behaviorEnricher — L3 BEHAVIOR extraction (post-premise-reset).
 *
 * For every FEATURE-class node (cli:command, mcp:tool, vscode:command), walk
 * the HANDLES edge to the entry function, walk the CALLS forward subgraph
 * depth-bounded, hash the sorted reachable id set, and capture the transitive
 * effects. Each FEATURE then gets:
 *
 *   FEATURE -IMPLEMENTED_BY-> BEHAVIOR
 *
 * BEHAVIOR.metadata holds:
 *   { hash, effects: ['IO', ...], coreNodeCount, depth, effectCount }
 *
 * Pass 2 deduplicates: BEHAVIORs whose hash matches get linked via
 * SHARES_BEHAVIOR_WITH edges between their FEATUREs (bidirectional).
 *
 * No COMPRISES edges are emitted. No PRODUCES_EFFECT edges are emitted.
 * The materialized membership/effect edges that previous versions wrote
 * (research doc §4.2) cost millions of edges + per-feature subgraph held
 * in memory at real-codebase scale. None of the documented user queries
 * actually need them — see skill `materialize-only-what-queries-need`:
 *
 *   - "What does feature X do?" → CONTRACT + BEHAVIOR.effects + size summary
 *   - "Are these duplicates?"   → hash equality (Datalog rule)
 *   - "What features serve fn Y?" → backward callers walk at runtime
 *   - "Cognitive metrics for X" → counts + depth (aggregate, not membership)
 *
 * Idempotent: BEHAVIOR id is `${feature.id}::behavior`, IMPLEMENTED_BY edges
 * are deterministic (src, dst, edgeType) tuples that RFDB dedupes.
 *
 * Like sibling enrichers, this uses direct addNodes/addEdges (not BatchHandle
 * .commit) — see skill `rfdb-batchhandle-deletes-existing-nodes`.
 */

import { createHash } from 'crypto';
import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireEdge, WireNode } from '@grafema/types';
import type { EffectsLookup } from '../manifest/effects-lookup.js';
import type { DataflowBackend, DataflowNode, DataflowEdge } from '../queries/traceDataflow.js';
import { traceEffects } from '../queries/traceEffects.js';
import type { EffectType } from '../manifest/types.js';

/** ---------------------------------------------------------------------------
 *  Public types
 *  ------------------------------------------------------------------------ */

export interface BehaviorEnrichResult {
  /** Number of BEHAVIOR nodes created (one per FEATURE that had an entry). */
  behaviorsCreated: number;
  /** Total core node count across all behaviors (summary only — not edges). */
  totalCoreNodes: number;
  /** Total SHARES_BEHAVIOR_WITH edges emitted (bidirectional, so always even). */
  sharesBehaviorEdges: number;
  /** Diagnostic: features whose HANDLES edge was missing or pointed at a
   *  non-existent target. */
  featuresWithoutEntry: number;
}

export interface BehaviorEnrichOptions {
  /** Forward-slice depth limit. Default 10. */
  maxDepth?: number;
  /**
   * Flush accumulated nodes/edges to RFDB after every N processed features.
   * Default 10. Lower values reduce peak memory at the cost of more round-trips
   * to the server.
   */
  flushBatchSize?: number;
}

/** ---------------------------------------------------------------------------
 *  Internal types
 *  ------------------------------------------------------------------------ */

interface BehaviorRecord {
  featureId: string;
  hash: string;
}

/** FEATURE-class node types we extract behaviors for. */
const FEATURE_TYPES: readonly string[] = ['cli:command', 'mcp:tool', 'vscode:command'];

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_FLUSH_BATCH_SIZE = 10;
const SHARES_EDGE_FLUSH_SIZE = 200;

/** ---------------------------------------------------------------------------
 *  Public entry point
 *  ------------------------------------------------------------------------ */

export async function enrichBehaviors(
  client: RFDBClient,
  effectsLookup: EffectsLookup,
  options?: BehaviorEnrichOptions,
): Promise<BehaviorEnrichResult> {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const flushBatchSize = Math.max(1, options?.flushBatchSize ?? DEFAULT_FLUSH_BATCH_SIZE);

  const result: BehaviorEnrichResult = {
    behaviorsCreated: 0,
    totalCoreNodes: 0,
    sharesBehaviorEdges: 0,
    featuresWithoutEntry: 0,
  };

  // Wrap RFDBClient as a DataflowBackend for traceEffects (still needs the
  // adapter shape). collectTransitiveCallTargets bypasses this entirely and
  // uses the raw client to avoid hydrating heavy DataflowNode objects.
  const dfDb = makeDataflowBackend(client);

  // Per-batch accumulators. Reset to fresh arrays after each flush so the
  // previous batch's WireNode/WireEdge objects become unreachable and
  // available for GC.
  let batchNodes: WireNode[] = [];
  let batchEdges: WireEdge[] = [];
  const seenBehaviorIds = new Set<string>();
  // Small index — only featureId + 64-char hash per behavior, kept across
  // the whole run to compute SHARES_BEHAVIOR_WITH in Pass 2.
  const behaviorRecords: BehaviorRecord[] = [];
  let processedSinceFlush = 0;

  // ── Pass 1: per-feature forward-slice + hash + emit BEHAVIOR ──
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

      // 2. Streaming hash: collect transitive call-target IDs into a Set,
      //    sort + sha256 + drop the Set immediately. Direct CALLS-only BFS
      //    over the raw client — no DataflowNode hydration, no PA/READS_FROM
      //    indexes, no traceDataflow.
      const callTargets = await collectTransitiveCallTargets(
        client,
        entryId,
        maxDepth,
      );
      const sortedIds = Array.from(callTargets).sort();
      const hash = createHash('sha256').update(sortedIds.join(',')).digest('hex');
      const coreCount = callTargets.size;
      callTargets.clear();
      sortedIds.length = 0;

      // 3. Effects via traceEffects. We only retain the small Set<EffectType>
      //    (≤7 distinct values); release the heavy leaf_sources /
      //    boundary_crossings arrays before the next iteration.
      const effectSet = new Set<EffectType>();
      {
        const eff = await traceEffects(dfDb, entryId, effectsLookup, { maxDepth });
        if (eff) {
          for (const e of eff.transitive) effectSet.add(e);
          eff.leaf_sources.length = 0;
          eff.boundary_crossings.length = 0;
        }
      }
      const effects = Array.from(effectSet).sort();

      // 4. Emit BEHAVIOR node. Metadata carries everything queries need.
      batchNodes.push({
        id: behaviorId,
        nodeType: 'BEHAVIOR' as never,
        name: feature.name,
        file: feature.file,
        exported: false,
        metadata: JSON.stringify({
          hash,
          effects,
          coreNodeCount: coreCount,
          depth: maxDepth,
          effectCount: effects.length,
          featureId: feature.id,
        }),
      });

      // 5. FEATURE -IMPLEMENTED_BY-> BEHAVIOR
      batchEdges.push({
        src: feature.id,
        dst: behaviorId,
        edgeType: 'IMPLEMENTED_BY' as never,
        metadata: JSON.stringify({}),
      });

      result.behaviorsCreated++;
      result.totalCoreNodes += coreCount;
      behaviorRecords.push({ featureId: feature.id, hash });
      processedSinceFlush++;

      // Chunked flush — every flushBatchSize features, ship the accumulated
      // nodes/edges and reset.
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
        // Yield to event loop so V8 has an opportunity to run incremental GC.
        await new Promise<void>((resolve) => setImmediate(resolve));
        // Force a major GC at every flush boundary when --expose-gc is on.
        const gc = (globalThis as { gc?: () => void }).gc;
        if (typeof gc === 'function') gc();
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
 *  Transitive call-target collection
 *  ------------------------------------------------------------------------ */

/**
 * Direct CALLS-only forward BFS from `startId`. Returns the set of reached
 * node IDs (strings only — no DataflowNode hydration, no metadata parsing).
 *
 * This deliberately avoids `traceDataflow`: at scale (149 features × ~tens of
 * thousands of nodes per slice) traceDataflow's lazy paReadByName / callsByReceiver
 * indexes plus full DataflowNode arrays in `result.reached[]` blew the 2GB
 * heap. We don't need any of that for behavior hashing — we only need stable
 * IDs of transitive callees.
 */
async function collectTransitiveCallTargets(
  client: RFDBClient,
  startId: string,
  maxDepth: number,
): Promise<Set<string>> {
  const visited = new Set<string>();
  visited.add(startId);
  let frontier: string[] = [startId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const edges = await client.getOutgoingEdges(id, ['CALLS'] as never);
      for (const e of edges) {
        const dst = e.dst as unknown as string;
        if (typeof dst === 'string' && !visited.has(dst)) {
          visited.add(dst);
          next.push(dst);
        }
      }
    }
    frontier = next;
  }
  return visited;
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

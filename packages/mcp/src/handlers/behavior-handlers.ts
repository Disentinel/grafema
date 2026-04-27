/**
 * Behavior handlers — surface cross-modality FEATURE duplication.
 *
 * `find_shared_behaviors` lists clusters of FEATUREs (cli:command, mcp:tool,
 * vscode:command, …) whose entry-point forward-slice hashes match. Mirrors the
 * `grafema features --duplicates` CLI subcommand — same algorithm, same
 * cluster shape — so the two channels return symmetric data.
 *
 * REG-1119.
 */

import { ensureAnalyzed } from '../analysis.js';
import { textResult, errorResult } from '../utils.js';
import type { ToolResult, FindSharedBehaviorsArgs } from '../types.js';
import type { EdgeType, EdgeRecord } from '@grafema/types';

/**
 * Minimal backend interface used by the logic function. Allows testing with
 * a simple mock without importing the full GraphBackend. Matches the subset
 * of RFDBServerBackend that we need.
 */
interface BehaviorBackendLike {
  getNode(id: string): Promise<Record<string, unknown> | null>;
  queryNodes(query: { type?: string; nodeType?: string }): AsyncIterable<Record<string, unknown>>;
  getIncomingEdges(nodeId: string, edgeTypes?: EdgeType[] | null): Promise<EdgeRecord[]>;
}

interface SharedFeatureRef {
  id: string;
  type: string;
  name: string;
  file: string;
}

interface SharedBehaviorCluster {
  hash: string;
  effects: string[];
  coreNodeCount: number;
  features: SharedFeatureRef[];
}

const DEFAULT_MIN_CLUSTER_SIZE = 2;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;

// === Logic function (testable, accepts backend directly) ===

export async function findSharedBehaviorsLogic(
  db: BehaviorBackendLike,
  args: FindSharedBehaviorsArgs,
): Promise<ToolResult> {
  const { minClusterSize: rawMin, limit: rawLimit } = args ?? {};

  if (rawMin !== undefined && (!Number.isFinite(rawMin) || rawMin < 0)) {
    return errorResult('minClusterSize must be a non-negative number');
  }
  if (rawLimit !== undefined && (!Number.isFinite(rawLimit) || rawLimit <= 0)) {
    return errorResult('limit must be a positive number');
  }
  if (rawLimit !== undefined && rawLimit > MAX_LIMIT) {
    return errorResult(`limit must be <= ${MAX_LIMIT}`);
  }

  const minClusterSize = Math.max(2, rawMin ?? DEFAULT_MIN_CLUSTER_SIZE);
  const limit = rawLimit ?? DEFAULT_LIMIT;

  // 1. Collect all BEHAVIOR nodes.
  interface BehaviorRow {
    id: string;
    hash: string;
    effects: string[];
    coreNodeCount: number;
  }
  const behaviors: BehaviorRow[] = [];
  for await (const node of db.queryNodes({ type: 'BEHAVIOR' })) {
    const id = String(node.id ?? '');
    if (!id) continue;
    const hash = readString(node.hash);
    if (!hash) continue;
    behaviors.push({
      id,
      hash,
      effects: readStringArray(node.effects),
      coreNodeCount: readNumber(node.coreNodeCount) ?? 0,
    });
  }

  // 2. Bucket by hash.
  const byHash = new Map<string, BehaviorRow[]>();
  for (const b of behaviors) {
    let bucket = byHash.get(b.hash);
    if (!bucket) {
      bucket = [];
      byHash.set(b.hash, bucket);
    }
    bucket.push(b);
  }

  // 3. Resolve features (incoming IMPLEMENTED_BY) for clusters.
  const clusters: SharedBehaviorCluster[] = [];
  for (const [hash, bucket] of byHash) {
    if (bucket.length < minClusterSize) continue;

    const features: SharedFeatureRef[] = [];
    const seen = new Set<string>();
    for (const beh of bucket) {
      const edges = await db.getIncomingEdges(beh.id, ['IMPLEMENTED_BY'] as EdgeType[]);
      for (const edge of edges) {
        const featureId = String(edge.src);
        if (!featureId || seen.has(featureId)) continue;
        seen.add(featureId);
        const node = await db.getNode(featureId);
        if (!node) continue;
        features.push({
          id: featureId,
          type: readString(node.type) ?? 'UNKNOWN',
          name: readString(node.name) ?? '',
          file: readString(node.file) ?? '',
        });
      }
    }

    if (features.length < minClusterSize) continue;

    features.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type)));
    clusters.push({
      hash,
      effects: bucket[0].effects,
      coreNodeCount: bucket[0].coreNodeCount,
      features,
    });
  }

  clusters.sort((a, b) => (b.features.length - a.features.length) || a.hash.localeCompare(b.hash));
  const truncated = clusters.length > limit;
  const limited = clusters.slice(0, limit);

  return textResult(JSON.stringify({
    count: limited.length,
    truncated,
    minClusterSize,
    clusters: limited,
  }, null, 2));
}

// === Public handler (calls ensureAnalyzed, used by MCP routing) ===

export async function handleFindSharedBehaviors(args: FindSharedBehaviorsArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  return findSharedBehaviorsLogic(db as unknown as BehaviorBackendLike, args);
}

// === Internal helpers ===

function readString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function readNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function readStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      // not JSON
    }
  }
  return [];
}

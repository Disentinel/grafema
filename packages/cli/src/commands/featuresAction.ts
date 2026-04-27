/**
 * Features command action — surface FEATURE-level cross-modality insights.
 *
 * Currently implements --duplicates: groups BEHAVIOR nodes by their
 * `metadata.hash` and lists every cluster of size >= 2. Each cluster shows the
 * feature ENTRY_POINTs (incoming `IMPLEMENTED_BY` edges) that share the
 * implementation.
 *
 * Surfaces the data emitted by `behaviorEnricher` Pass 2: SHARES_BEHAVIOR_WITH
 * edges already exist, but they're not user-facing. This subcommand makes the
 * insight visible from the CLI ("this CLI command and that MCP tool are thin
 * wrappers around the same library function").
 *
 * REG-1119.
 */
import type { EdgeType } from '@grafema/types';

/**
 * Minimal backend interface — matches the subset of RFDBServerBackend
 * (and the graph-handlers' GraphBackendLike) that we need. Lets us test with
 * a simple in-memory mock without requiring a live RFDB server.
 */
export interface FeaturesBackendLike {
  queryNodes(query: { type?: string; nodeType?: string }): AsyncIterable<Record<string, unknown>>;
  getNode(id: string): Promise<Record<string, unknown> | null>;
  getIncomingEdges(
    nodeId: string,
    edgeTypes?: EdgeType[] | null,
  ): Promise<Array<{ src: string; dst: string; type: string; metadata?: Record<string, unknown> | undefined }>>;
}

/** A FEATURE participating in a shared-behavior cluster. */
export interface SharedFeatureRef {
  /** Feature semantic id. */
  id: string;
  /** Feature node type — e.g. `cli:command`, `mcp:tool`, `vscode:command`. */
  type: string;
  /** Feature name (e.g. `analyze`). */
  name: string;
  /** Source file (may be empty for synthetic features). */
  file: string;
}

/** A group of FEATUREs whose behavior hashes are identical. */
export interface SharedBehaviorCluster {
  /** sha256 hash from BEHAVIOR.metadata.hash — the cluster key. */
  hash: string;
  /** Effects array carried on the shared BEHAVIOR. */
  effects: string[];
  /** Forward-slice size of the shared behavior. */
  coreNodeCount: number;
  /** Features that implement the same behavior. */
  features: SharedFeatureRef[];
}

export interface FindSharedBehaviorOptions {
  /** Minimum cluster size to include. Default 2. */
  minClusterSize?: number;
  /** Maximum number of clusters to return. Default 100. */
  limit?: number;
}

const DEFAULT_MIN_CLUSTER_SIZE = 2;
const DEFAULT_LIMIT = 100;

/**
 * Core algorithm — testable, accepts any backend implementing
 * `FeaturesBackendLike`.
 *
 * Steps:
 * 1. Iterate every BEHAVIOR node, read its `hash` + `effects` + `coreNodeCount`.
 * 2. Bucket behaviors by hash.
 * 3. For each bucket of size >= minClusterSize, walk incoming `IMPLEMENTED_BY`
 *    edges to enumerate the FEATUREs.
 *
 * Returns clusters sorted by size (desc), then by hash (asc, deterministic).
 */
export async function findSharedBehaviorClusters(
  backend: FeaturesBackendLike,
  options: FindSharedBehaviorOptions = {},
): Promise<SharedBehaviorCluster[]> {
  const minClusterSize = Math.max(2, options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE);
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);

  // 1. Collect all BEHAVIOR nodes.
  interface BehaviorRow {
    id: string;
    hash: string;
    effects: string[];
    coreNodeCount: number;
  }
  const behaviors: BehaviorRow[] = [];
  for await (const node of backend.queryNodes({ type: 'BEHAVIOR' })) {
    const id = String(node.id ?? '');
    if (!id) continue;
    const hash = readString(node.hash);
    if (!hash) continue;
    const effects = readStringArray(node.effects);
    const coreNodeCount = readNumber(node.coreNodeCount) ?? 0;
    behaviors.push({ id, hash, effects, coreNodeCount });
  }

  // 2. Group by hash.
  const byHash = new Map<string, BehaviorRow[]>();
  for (const b of behaviors) {
    let bucket = byHash.get(b.hash);
    if (!bucket) {
      bucket = [];
      byHash.set(b.hash, bucket);
    }
    bucket.push(b);
  }

  // 3. For each multi-behavior bucket, expand incoming IMPLEMENTED_BY edges
  //    into FEATURE refs.
  const clusters: SharedBehaviorCluster[] = [];
  for (const [hash, bucket] of byHash) {
    if (bucket.length < minClusterSize) continue;

    const features: SharedFeatureRef[] = [];
    const seenFeatureIds = new Set<string>();

    for (const beh of bucket) {
      const edges = await backend.getIncomingEdges(beh.id, ['IMPLEMENTED_BY'] as EdgeType[]);
      for (const edge of edges) {
        const featureId = String(edge.src);
        if (!featureId || seenFeatureIds.has(featureId)) continue;
        seenFeatureIds.add(featureId);
        const node = await backend.getNode(featureId);
        if (!node) continue;
        features.push({
          id: featureId,
          type: readString(node.type) ?? 'UNKNOWN',
          name: readString(node.name) ?? '',
          file: readString(node.file) ?? '',
        });
      }
    }

    // De-dup may have dropped behaviors back below threshold (e.g. multiple
    // BEHAVIOR rows from the same FEATURE). Re-check on the resolved feature
    // count.
    if (features.length < minClusterSize) continue;

    // Stable order of features within a cluster: by type then name.
    features.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type)));

    // Take effects + coreNodeCount from the first behavior — they're identical
    // for behaviors with the same hash by construction.
    clusters.push({
      hash,
      effects: bucket[0].effects,
      coreNodeCount: bucket[0].coreNodeCount,
      features,
    });
  }

  // Sort clusters: largest first, hash ascending for tie-break (deterministic).
  clusters.sort((a, b) => (b.features.length - a.features.length) || a.hash.localeCompare(b.hash));

  return clusters.slice(0, limit);
}

/**
 * Format clusters as a human-readable text report. Mirrors the symmetric MCP
 * handler output: same field ordering, same labels. JSON output is the same
 * structured array.
 */
export function formatSharedBehaviorClusters(clusters: SharedBehaviorCluster[]): string {
  if (clusters.length === 0) {
    return 'No FEATUREs share a BEHAVIOR (each entry-point has a unique implementation).';
  }

  const lines: string[] = [];
  lines.push(`Shared-behavior clusters: ${clusters.length}`);
  lines.push('='.repeat(40));
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    lines.push('');
    lines.push(`Cluster ${i + 1} — ${c.features.length} feature(s) share behavior`);
    lines.push(`  hash:          ${c.hash.slice(0, 16)}…`);
    lines.push(`  coreNodeCount: ${c.coreNodeCount}`);
    lines.push(`  effects:       ${c.effects.length === 0 ? '(none)' : c.effects.join(', ')}`);
    lines.push('  features:');
    for (const f of c.features) {
      const file = f.file ? ` [${f.file}]` : '';
      lines.push(`    - ${f.type}  ${f.name}${file}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers — defensive parsers tolerating both string-encoded JSON
// metadata (from raw client) and already-parsed values (from RFDBServerBackend
// _parseNode).
// ---------------------------------------------------------------------------

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

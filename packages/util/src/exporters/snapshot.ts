/**
 * Snapshot collection — query helpers for `grafema export`.
 *
 * Walks the feature taxonomy graph (REG-1110 family) to assemble
 * FeatureExportSnapshot[] from a glob pattern. The output is
 * format-independent — both `openapi-3.1` and `docs-md` consume the same
 * shape.
 *
 * Pattern syntax (`--feature <pattern>`):
 *   - 'cli:*'                    — every cli:command FEATURE
 *   - 'http:*'                   — every http:route FEATURE
 *   - 'mcp:tool:find_*'          — mcp:tool with name matching find_*
 *   - "cli:command:'analyze'"    — exact id (quotes optional around name)
 *   - "cli:command:analyze"      — same, no quotes
 *
 * The pattern's prefix-before-name is matched against the FEATURE node's
 * `type` (with `:*` collapsing to "any subtype starts with this prefix");
 * the suffix is matched against the node's `name` via shell-style globbing.
 */
import type { EdgeType } from '@grafema/types';
import { minimatch } from 'minimatch';
import type {
  SpecedContractData,
} from '../enrichers/specedContractEnricher.js';
import type {
  FeatureBehaviorSummary,
  FeatureExportSnapshot,
  SharedFeatureRef,
} from './types.js';
import { findIntentsRoot, loadIntent } from './intentLoader.js';

/** All known FEATURE categories — matches specedContractEnricher.FEATURE_TYPES. */
export const FEATURE_CATEGORIES: readonly string[] = [
  'cli:command',
  'mcp:tool',
  'vscode:command',
  'package:export',
  'http:route',
];

/**
 * Minimal backend interface — the subset of RFDBServerBackend exporters need.
 * Mirrors the shape used by featuresAction.ts so a single in-memory mock can
 * back multiple test suites.
 */
export interface ExportBackendLike {
  queryNodes(query: { type?: string; nodeType?: string }): AsyncIterable<Record<string, unknown>>;
  getNode(id: string): Promise<Record<string, unknown> | null>;
  getOutgoingEdges(
    nodeId: string,
    edgeTypes?: EdgeType[] | null,
  ): Promise<Array<{ src: string; dst: string; type: string; metadata?: Record<string, unknown> | undefined }>>;
  getIncomingEdges(
    nodeId: string,
    edgeTypes?: EdgeType[] | null,
  ): Promise<Array<{ src: string; dst: string; type: string; metadata?: Record<string, unknown> | undefined }>>;
}

/**
 * Parse a `--feature` pattern into (categoryGlob, nameGlob). Returns null when
 * the pattern is empty.
 *
 * Heuristics:
 *   - 'cli:*'                  → category='cli:*', name='*'    (broad)
 *   - 'cli:command'            → category='cli:command', name='*'
 *   - 'cli:command:foo'        → category='cli:command', name='foo'
 *   - "cli:command:'foo'"      → category='cli:command', name='foo'
 *   - 'cli:command:find_*'     → category='cli:command', name='find_*'
 *
 * The category portion is the head; the name portion is whatever follows the
 * SECOND ':' separator. This matches the printable forms used in
 * AI-AGENT-STORIES and CLAUDE.md.
 */
export function parseFeaturePattern(pattern: string): { categoryGlob: string; nameGlob: string } | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return null;

  // Split on ':' — but a category can itself contain ':' (e.g. 'cli:command'),
  // so we always treat the first two segments as the category and anything
  // beyond as the name.
  const parts = trimmed.split(':');
  if (parts.length === 1) {
    return { categoryGlob: parts[0], nameGlob: '*' };
  }
  if (parts.length === 2) {
    // Either 'cli:command' (category, all names) or 'cli:*' (also broad).
    return { categoryGlob: `${parts[0]}:${parts[1]}`, nameGlob: '*' };
  }
  // 3+ segments: first two = category, rest re-joined = name (preserves any
  // ':' embedded in odd names).
  const categoryGlob = `${parts[0]}:${parts[1]}`;
  const rawName = parts.slice(2).join(':');
  return { categoryGlob, nameGlob: stripQuotes(rawName) };
}

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const a = s.charCodeAt(0);
  const b = s.charCodeAt(s.length - 1);
  if ((a === 0x27 || a === 0x22) && a === b) return s.slice(1, -1);
  return s;
}

/**
 * Resolve a pattern's categoryGlob to the set of FEATURE node types to scan.
 * Uses minimatch so 'cli:*', '*:tool', '*' etc. all work.
 */
export function resolveCategories(categoryGlob: string): string[] {
  return FEATURE_CATEGORIES.filter(c => minimatch(c, categoryGlob));
}

/**
 * Collect FeatureExportSnapshot[] from the graph for a given `--feature`
 * pattern. The traversal:
 *
 *  1. Resolve categories matching `categoryGlob`.
 *  2. For each category, queryNodes(type=...), filter by `nameGlob`.
 *  3. For each matching FEATURE:
 *     a. Walk HAS_SPECED_CONTRACT → SPECED_CONTRACT(s), parse metadata.
 *     b. Walk IMPLEMENTED_BY → BEHAVIOR (one), read summary fields.
 *     c. Walk BEHAVIOR.SHARES_BEHAVIOR_WITH → siblings → backward
 *        IMPLEMENTED_BY → other FEATUREs.
 *
 * Order of results: snapshots sorted by category ascending, then name
 * ascending — deterministic for tests and stable diffs.
 */
export async function collectFeatureSnapshots(
  backend: ExportBackendLike,
  pattern: string,
  options?: { intentsRoot?: string | null; projectRoot?: string },
): Promise<FeatureExportSnapshot[]> {
  const parsed = parseFeaturePattern(pattern);
  if (!parsed) return [];
  const { categoryGlob, nameGlob } = parsed;

  const categories = resolveCategories(categoryGlob);
  if (categories.length === 0) return [];

  // Resolve intents directory once for the run. Caller can override (tests
  // pass a temp dir); explicit `null` disables intent loading entirely; if
  // unset we walk up from projectRoot (or cwd) looking for `_ai/intents/`.
  let intentsRoot: string | null;
  if (options?.intentsRoot === null) {
    intentsRoot = null;
  } else if (typeof options?.intentsRoot === 'string') {
    intentsRoot = options.intentsRoot;
  } else {
    intentsRoot = findIntentsRoot(options?.projectRoot ?? process.cwd());
  }

  const snapshots: FeatureExportSnapshot[] = [];

  for (const category of categories) {
    const features: Array<Record<string, unknown>> = [];
    for await (const node of backend.queryNodes({ type: category })) {
      const name = readString(node.name) ?? '';
      if (!minimatch(name, nameGlob)) continue;
      features.push(node);
    }

    for (const feature of features) {
      const id = readString(feature.id);
      if (!id) continue;
      const name = readString(feature.name) ?? '';
      const file = readString(feature.file) ?? '';

      const contracts = await collectContracts(backend, id);
      const behavior = await collectBehavior(backend, id);
      const sharedBehaviorWith = behavior
        ? await collectSharedFeatures(backend, id, behavior.hash)
        : [];
      const intent = intentsRoot ? loadIntent(intentsRoot, category, name) : undefined;

      snapshots.push({
        id,
        category,
        name,
        file,
        contracts,
        behavior,
        sharedBehaviorWith,
        ...(intent ? { intent } : {}),
      });
    }
  }

  snapshots.sort((a, b) =>
    a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category),
  );

  return snapshots;
}

async function collectContracts(
  backend: ExportBackendLike,
  featureId: string,
): Promise<SpecedContractData[]> {
  const edges = await backend.getOutgoingEdges(featureId, ['HAS_SPECED_CONTRACT'] as EdgeType[]);
  const contracts: SpecedContractData[] = [];
  for (const edge of edges) {
    const node = await backend.getNode(String(edge.dst));
    if (!node) continue;
    const data = readContractData(node);
    if (data) contracts.push(data);
  }
  return contracts;
}

/**
 * Read SpecedContractData out of a SPECED_CONTRACT node. RFDBServerBackend
 * spreads metadata fields onto the node object; the raw RFDBClient leaves
 * `metadata` as a JSON string. Tolerate both.
 */
function readContractData(node: Record<string, unknown>): SpecedContractData | null {
  // Path A: fields already spread on the node by RFDBServerBackend._parseNode.
  const inputs = node.inputs;
  if (Array.isArray(inputs)) {
    return {
      source: (readString(node.source) ?? 'function-signature') as SpecedContractData['source'],
      inputs: inputs as SpecedContractData['inputs'],
      outputs: Array.isArray(node.outputs) ? (node.outputs as SpecedContractData['outputs']) : [],
      errors: Array.isArray(node.errors) ? (node.errors as SpecedContractData['errors']) : [],
    };
  }
  // Path B: raw metadata is a JSON string.
  if (typeof node.metadata === 'string') {
    try {
      const parsed = JSON.parse(node.metadata) as SpecedContractData;
      if (parsed && Array.isArray(parsed.inputs)) return parsed;
    } catch {
      // not JSON
    }
  }
  return null;
}

async function collectBehavior(
  backend: ExportBackendLike,
  featureId: string,
): Promise<FeatureBehaviorSummary | undefined> {
  const edges = await backend.getOutgoingEdges(featureId, ['IMPLEMENTED_BY'] as EdgeType[]);
  for (const edge of edges) {
    const node = await backend.getNode(String(edge.dst));
    if (!node) continue;
    // Path A: RFDBServerBackend._parseNode spreads metadata onto the node.
    let hash = readString(node.hash);
    let effects = readStringArray(node.effects);
    let coreNodeCount = readNumber(node.coreNodeCount);
    let depth = readNumber(node.depth);
    // Path B: raw RFDBClient leaves metadata as a JSON string. Parse it.
    if (!hash && typeof node.metadata === 'string') {
      try {
        const parsed = JSON.parse(node.metadata) as Record<string, unknown>;
        hash = readString(parsed.hash);
        if (effects.length === 0) effects = readStringArray(parsed.effects);
        if (coreNodeCount === undefined) coreNodeCount = readNumber(parsed.coreNodeCount);
        if (depth === undefined) depth = readNumber(parsed.depth);
      } catch {
        // not JSON
      }
    }
    if (!hash) continue;
    return {
      hash,
      effects,
      coreNodeCount: coreNodeCount ?? 0,
      depth: depth ?? 0,
    };
  }
  return undefined;
}

/**
 * For a feature whose BEHAVIOR has hash `h`, find every sibling FEATURE in
 * the SHARES_BEHAVIOR_WITH cluster.
 *
 * The graph stores the cluster as edges between BEHAVIOR nodes (per
 * behaviorEnricher Pass 2). We:
 *   1. List all BEHAVIORs reachable from this feature's BEHAVIOR via
 *      SHARES_BEHAVIOR_WITH.
 *   2. For each, walk backward IMPLEMENTED_BY to its FEATURE.
 *   3. Skip our own feature id.
 */
async function collectSharedFeatures(
  backend: ExportBackendLike,
  selfFeatureId: string,
  hash: string,
): Promise<SharedFeatureRef[]> {
  void hash; // Reserved for future direct-by-hash lookup.

  // Find this feature's own BEHAVIOR id.
  const ownBehaviorEdges = await backend.getOutgoingEdges(selfFeatureId, ['IMPLEMENTED_BY'] as EdgeType[]);
  if (ownBehaviorEdges.length === 0) return [];
  const ownBehaviorId = String(ownBehaviorEdges[0].dst);

  // Collect sibling BEHAVIOR ids via SHARES_BEHAVIOR_WITH (outgoing AND
  // incoming — the relation is symmetric but enricher may write only one
  // direction depending on hash sort order).
  const out = await backend.getOutgoingEdges(ownBehaviorId, ['SHARES_BEHAVIOR_WITH'] as EdgeType[]);
  const inn = await backend.getIncomingEdges(ownBehaviorId, ['SHARES_BEHAVIOR_WITH'] as EdgeType[]);
  const siblingBehaviorIds = new Set<string>();
  for (const e of out) siblingBehaviorIds.add(String(e.dst));
  for (const e of inn) siblingBehaviorIds.add(String(e.src));
  if (siblingBehaviorIds.size === 0) return [];

  // For each sibling BEHAVIOR, walk back to its FEATURE(s).
  const features: SharedFeatureRef[] = [];
  const seen = new Set<string>();
  for (const sibBehId of siblingBehaviorIds) {
    const featureEdges = await backend.getIncomingEdges(sibBehId, ['IMPLEMENTED_BY'] as EdgeType[]);
    for (const fe of featureEdges) {
      const featureId = String(fe.src);
      if (featureId === selfFeatureId || seen.has(featureId)) continue;
      seen.add(featureId);
      const node = await backend.getNode(featureId);
      if (!node) continue;
      features.push({
        id: featureId,
        category: readString(node.type) ?? 'UNKNOWN',
        name: readString(node.name) ?? '',
        file: readString(node.file) ?? '',
      });
    }
  }

  // Deterministic order: category asc, then name asc.
  features.sort((a, b) =>
    a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category),
  );
  return features;
}

// ---------------------------------------------------------------------------
// Internal value parsers (tolerate raw string-encoded vs already-parsed forms)
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

/**
 * Vocabulary operations — synonym clustering, domain classification, baseline diffing.
 *
 * Pure functions for organizing and analyzing graph vocabulary types
 * discovered during corpus annotation.
 *
 * Provides:
 * - `classifyDomain()` — classify a type into its semantic domain
 * - `levenshteinDistance()` — edit distance between two strings
 * - `findSynonymClusters()` — find groups of similar type names
 * - `diffAgainstBaseline()` — compare annotations against known vocabulary
 * - `isPluginTerritory()` — check if a type belongs in a plugin namespace
 */

import type { VocabularyAnalysis, BaselineVocabulary } from '../types.js';

// === Domain Classification ===

const NODE_TYPE_DOMAINS: Record<string, string> = {
  MODULE: 'structure',
  FILE: 'structure',
  SERVICE: 'structure',
  PROJECT: 'structure',
  SCOPE: 'structure',
  FUNCTION: 'declarations',
  CLASS: 'declarations',
  METHOD: 'declarations',
  VARIABLE: 'declarations',
  PARAMETER: 'declarations',
  CONSTANT: 'declarations',
  LITERAL: 'values',
  EXPRESSION: 'values',
  CALL: 'callGraph',
  PROPERTY_ACCESS: 'callGraph',
  BRANCH: 'controlFlow',
  CASE: 'controlFlow',
  LOOP: 'controlFlow',
  TRY_BLOCK: 'controlFlow',
  CATCH_BLOCK: 'controlFlow',
  FINALLY_BLOCK: 'controlFlow',
  IMPORT: 'moduleSystem',
  EXPORT: 'moduleSystem',
  EXTERNAL: 'external',
  EXTERNAL_MODULE: 'external',
};

const EDGE_TYPE_DOMAINS: Record<string, string> = {
  // containment
  CONTAINS: 'containment',
  HAS_SCOPE: 'containment',
  HAS_BODY: 'containment',
  // declaration
  DECLARES: 'declaration',
  DEFINES: 'declaration',
  // dataFlow
  ASSIGNED_FROM: 'dataFlow',
  READS_FROM: 'dataFlow',
  WRITES_TO: 'dataFlow',
  FLOWS_INTO: 'dataFlow',
  PASSES_ARGUMENT: 'dataFlow',
  RECEIVES_ARGUMENT: 'dataFlow',
  DERIVES_FROM: 'dataFlow',
  // callGraph
  CALLS: 'callGraph',
  HAS_CALLBACK: 'callGraph',
  DELEGATES_TO: 'callGraph',
  RETURNS: 'callGraph',
  YIELDS: 'callGraph',
  // typeSystem
  EXTENDS: 'typeSystem',
  IMPLEMENTS: 'typeSystem',
  INSTANCE_OF: 'typeSystem',
  // moduleSystem
  IMPORTS: 'moduleSystem',
  EXPORTS: 'moduleSystem',
  IMPORTS_FROM: 'moduleSystem',
  EXPORTS_TO: 'moduleSystem',
  DEPENDS_ON: 'moduleSystem',
  // objectStructure
  HAS_PROPERTY: 'objectStructure',
  HAS_ELEMENT: 'objectStructure',
  // controlFlow
  HAS_CONDITION: 'controlFlow',
  HAS_CASE: 'controlFlow',
  HAS_DEFAULT: 'controlFlow',
  HAS_CONSEQUENT: 'controlFlow',
  HAS_ALTERNATE: 'controlFlow',
  HAS_INIT: 'controlFlow',
  HAS_UPDATE: 'controlFlow',
  ITERATES_OVER: 'controlFlow',
  // errorHandling
  THROWS: 'errorHandling',
  REJECTS: 'errorHandling',
  CATCHES_FROM: 'errorHandling',
  HAS_CATCH: 'errorHandling',
  HAS_FINALLY: 'errorHandling',
  // mutation
  MODIFIES: 'mutation',
  CAPTURES: 'mutation',
};

/**
 * Classify a node or edge type into its semantic domain.
 *
 * Checks against known node type mappings, then edge type mappings.
 * Types containing ":" are classified as "plugin".
 * Unknown types return "uncategorized".
 *
 * @param type - The node or edge type string (e.g., "VARIABLE", "CALLS")
 * @returns The semantic domain name (e.g., "declarations", "callGraph")
 */
export function classifyDomain(type: string): string {
  if (type.includes(':')) {
    return 'plugin';
  }

  const nodeDomain = NODE_TYPE_DOMAINS[type];
  if (nodeDomain) return nodeDomain;

  const edgeDomain = EDGE_TYPE_DOMAINS[type];
  if (edgeDomain) return edgeDomain;

  return 'uncategorized';
}

// === Levenshtein Distance ===

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Uses the standard dynamic programming algorithm with O(min(m,n)) space.
 *
 * @param a - First string
 * @param b - Second string
 * @returns The minimum number of single-character edits (insert, delete, substitute)
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const aLen = a.length;
  const bLen = b.length;

  // Use two rows instead of full matrix
  let prev = new Array<number>(aLen + 1);
  let curr = new Array<number>(aLen + 1);

  for (let i = 0; i <= aLen; i++) {
    prev[i] = i;
  }

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,      // deletion
        curr[i - 1] + 1,  // insertion
        prev[i - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[aLen];
}

// === Synonym Clustering ===

/** Known semantic synonym groups — types that mean similar things */
const KNOWN_SYNONYM_GROUPS: string[][] = [
  ['DEFINES', 'DECLARES'],
  ['USES', 'READS_FROM'],
  ['MODIFIES', 'WRITES_TO'],
];

/**
 * Find groups of similar type names using Levenshtein distance and known synonyms.
 *
 * Two types are considered similar if their edit distance is at or below the threshold.
 * Known semantic synonym pairs are always grouped together regardless of distance.
 * Only returns clusters with 2 or more members.
 *
 * @param types - Array of type strings to cluster
 * @param threshold - Maximum Levenshtein distance to consider as similar (default: 3)
 * @returns Array of clusters, each cluster being an array of similar type strings
 */
export function findSynonymClusters(
  types: string[],
  threshold: number = 3,
): string[][] {
  if (types.length === 0) return [];

  const typeSet = new Set(types);

  // Union-Find for clustering
  const parent = new Map<string, string>();

  function find(x: string): string {
    if (!parent.has(x)) {
      parent.set(x, x);
    }
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let current = x;
    while (current !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootA, rootB);
    }
  }

  // Initialize all types
  for (const t of types) {
    find(t);
  }

  // Group by known synonym pairs
  for (const group of KNOWN_SYNONYM_GROUPS) {
    const present = group.filter((t) => typeSet.has(t));
    for (let i = 1; i < present.length; i++) {
      union(present[0], present[i]);
    }
  }

  // Group by Levenshtein distance
  for (let i = 0; i < types.length; i++) {
    for (let j = i + 1; j < types.length; j++) {
      if (levenshteinDistance(types[i], types[j]) <= threshold) {
        union(types[i], types[j]);
      }
    }
  }

  // Collect clusters
  const clusters = new Map<string, string[]>();
  for (const t of types) {
    const root = find(t);
    if (!clusters.has(root)) {
      clusters.set(root, []);
    }
    clusters.get(root)!.push(t);
  }

  // Return only clusters with 2+ members
  return Array.from(clusters.values()).filter((cluster) => cluster.length >= 2);
}

// === Plugin Territory Detection ===

/** Patterns indicating a type belongs in a plugin namespace */
const PLUGIN_TERRITORY_PATTERNS = [
  'ROUTES_TO',
  'HANDLED_BY',
  'MOUNTS',
  'EXPOSES',
  'RESPONDS_WITH',
  'LISTENS_TO',
  'EMITS_EVENT',
  'JOINS_ROOM',
  'CALLS_API',
  'MAKES_REQUEST',
  'HTTP_RECEIVES',
  'REGISTERS_VIEW',
];

const PLUGIN_TERRITORY_PREFIXES = [
  'DEPLOYED',
  'SCHEDULED',
  'MONITORED',
];

/**
 * Check if a type belongs in a plugin namespace rather than the base vocabulary.
 *
 * Returns true for:
 * - Types containing ":" (namespaced)
 * - Known plugin-territory patterns (HTTP, events, DB, FS, routing)
 *
 * @param type - The type string to check
 * @returns True if the type should be handled by a plugin
 */
export function isPluginTerritory(type: string): boolean {
  if (type.includes(':')) {
    return true;
  }

  if (PLUGIN_TERRITORY_PATTERNS.includes(type)) {
    return true;
  }

  for (const prefix of PLUGIN_TERRITORY_PREFIXES) {
    if (type.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

// === Baseline Diffing ===

/**
 * Compare discovered annotation types against the known baseline vocabulary.
 *
 * Produces a full vocabulary analysis including:
 * - approved: types present in both baseline and annotations, organized by domain
 * - new: types in annotations but not baseline, with count >= 3
 * - spurious: types in annotations but not baseline, with count < 3
 * - unused: types in baseline but not in any annotation
 * - pluginTerritory: types that belong in plugins
 * - synonymClusters: groups of similar type names
 *
 * @param annotationTypes - Map from type string to occurrence count
 * @param baseline - The current Grafema baseline vocabulary
 * @returns Full vocabulary analysis
 */
export function diffAgainstBaseline(
  annotationTypes: Map<string, number>,
  baseline: BaselineVocabulary,
): VocabularyAnalysis {
  // Build the full set of baseline types
  const baselineSet = new Set<string>();
  for (const t of baseline.nodeTypes) baselineSet.add(t);
  for (const t of baseline.edgeTypes) baselineSet.add(t);
  for (const ns of Object.values(baseline.namespacedNodeTypes)) {
    for (const t of ns) baselineSet.add(t);
  }

  // Classify each annotation type
  const approvedNodeTypes: Record<string, string[]> = {};
  const approvedEdgeTypes: Record<string, string[]> = {};
  const newTypes: VocabularyAnalysis['new'] = [];
  const spuriousTypes: VocabularyAnalysis['spurious'] = [];
  const pluginTerritoryTypes: string[] = [];
  const usedBaselineTypes = new Set<string>();

  for (const [type, count] of annotationTypes) {
    // Check plugin territory first
    if (isPluginTerritory(type)) {
      pluginTerritoryTypes.push(type);
      continue;
    }

    if (baselineSet.has(type)) {
      // Approved — in baseline
      usedBaselineTypes.add(type);
      const domain = classifyDomain(type);

      // Determine if it's a node type or edge type based on baseline
      const isNodeType =
        baseline.nodeTypes.includes(type) ||
        Object.values(baseline.namespacedNodeTypes).some((ns) => ns.includes(type));

      if (isNodeType) {
        if (!approvedNodeTypes[domain]) approvedNodeTypes[domain] = [];
        if (!approvedNodeTypes[domain].includes(type)) {
          approvedNodeTypes[domain].push(type);
        }
      } else {
        if (!approvedEdgeTypes[domain]) approvedEdgeTypes[domain] = [];
        if (!approvedEdgeTypes[domain].includes(type)) {
          approvedEdgeTypes[domain].push(type);
        }
      }
    } else if (count >= 3) {
      // New type — not in baseline but appears 3+ times
      newTypes.push({
        type,
        count,
        domain: classifyDomain(type),
        examples: [], // Caller should populate with construct IDs
      });
    } else {
      // Spurious — not in baseline and appears < 3 times
      spuriousTypes.push({ type, count });
    }
  }

  // Find unused baseline types
  const unusedTypes: string[] = [];
  for (const t of baselineSet) {
    if (!usedBaselineTypes.has(t)) {
      unusedTypes.push(t);
    }
  }

  // Find synonym clusters among all discovered types
  const allDiscoveredTypes = Array.from(annotationTypes.keys());
  const synonymClusters = findSynonymClusters(allDiscoveredTypes);

  // Sort for deterministic output
  unusedTypes.sort();
  pluginTerritoryTypes.sort();
  newTypes.sort((a, b) => b.count - a.count);
  spuriousTypes.sort((a, b) => b.count - a.count);

  for (const domain of Object.keys(approvedNodeTypes)) {
    approvedNodeTypes[domain].sort();
  }
  for (const domain of Object.keys(approvedEdgeTypes)) {
    approvedEdgeTypes[domain].sort();
  }

  return {
    approved: {
      nodeTypes: approvedNodeTypes,
      edgeTypes: approvedEdgeTypes,
    },
    new: newTypes,
    synonymClusters,
    unused: unusedTypes,
    pluginTerritory: pluginTerritoryTypes,
    spurious: spuriousTypes,
  };
}

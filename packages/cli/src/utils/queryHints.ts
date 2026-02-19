/**
 * Query hint utilities for the CLI raw query path.
 *
 * Note: extractQueriedTypes() is intentionally duplicated from packages/mcp/src/utils.ts.
 * The CLI cannot import @grafema/mcp (dependency direction). If the Datalog syntax changes,
 * both copies must be updated.
 */
import { levenshtein } from '@grafema/core';

export function extractQueriedTypes(query: string): { nodeTypes: string[]; edgeTypes: string[] } {
  const nodeTypes: string[] = [];
  const edgeTypes: string[] = [];

  // Match node(VAR, "TYPE") — only working node predicate.
  // type(VAR, "TYPE") is excluded: Rust evaluator has no "type" branch.
  const nodeRegex = /\bnode\([^,)]+,\s*"([^"]+)"\)/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRegex.exec(query)) !== null) {
    nodeTypes.push(m[1]);
  }

  const edgeRegex = /\b(?:edge|incoming)\([^,)]+,\s*[^,)]+,\s*"([^"]+)"\)/g;
  while ((m = edgeRegex.exec(query)) !== null) {
    edgeTypes.push(m[1]);
  }

  return { nodeTypes, edgeTypes };
}

export function findSimilarTypes(
  queriedType: string,
  availableTypes: string[],
  maxDistance: number = 2
): string[] {
  const queriedLower = queriedType.toLowerCase();
  const similar: string[] = [];

  for (const type of availableTypes) {
    const dist = levenshtein(queriedLower, type.toLowerCase());
    if (dist <= maxDistance && (dist > 0 || queriedType !== type)) {
      similar.push(type);
    }
  }

  return similar;
}

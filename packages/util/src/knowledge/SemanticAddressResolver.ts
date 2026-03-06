/**
 * SemanticAddressResolver — lazy resolver from semantic addresses to code graph node IDs.
 *
 * Semantic addresses (e.g., "src/auth.js:hashPassword:FUNCTION") are human-readable
 * references to code. After re-analysis, node IDs may change.
 * This resolver bridges KB references to current graph state at query time.
 */

import type { ParsedSemanticAddress, ResolvedAddress } from './types.js';

/** Minimal backend interface for resolving semantic addresses */
export interface ResolverBackend {
  getAllNodes(filter?: Record<string, unknown>): Promise<Array<Record<string, unknown> & { id: string }>>;
}

interface CacheEntry {
  result: ResolvedAddress;
  resolvedAt: number;
}

/**
 * Parse a semantic address string into its components.
 *
 * Format: `file:name:TYPE` or `file:scope1:...:scopeN:name:TYPE`
 * - Last segment = node type (FUNCTION, CLASS, VARIABLE, etc.)
 * - First segment = file path (contains `/` or `.`)
 * - Middle segments = scope path; last middle segment is the name
 *
 * @returns parsed address or null if invalid
 */
export function parseSemanticAddress(address: string): ParsedSemanticAddress | null {
  if (!address || typeof address !== 'string') return null;

  const parts = address.split(':');
  // Minimum: file:name:TYPE = 3 parts
  if (parts.length < 3) return null;

  const type = parts[parts.length - 1];
  const file = parts[0];

  // File must contain / or . to be valid
  if (!file.includes('/') && !file.includes('.')) return null;

  // Type must be uppercase
  if (type !== type.toUpperCase() || !/^[A-Z_]+$/.test(type)) return null;

  // Middle segments: everything between file and type
  const middle = parts.slice(1, -1);
  if (middle.length === 0) return null;

  const name = middle[middle.length - 1];
  const scopePath = middle.slice(0, -1);

  return { file, name, type, scopePath };
}

export class SemanticAddressResolver {
  private backend: ResolverBackend;
  private cache = new Map<string, CacheEntry>();
  private generation = 0;

  constructor(backend: ResolverBackend) {
    this.backend = backend;
  }

  /**
   * Increment the generation counter, marking all cached entries stale.
   * Call this after re-analysis to force re-resolution on next access.
   */
  bumpGeneration(): void {
    this.generation++;
  }

  /** Current generation number */
  getGeneration(): number {
    return this.generation;
  }

  /**
   * Resolve a semantic address to a code graph node ID.
   *
   * - `kb:` addresses pass through without backend query (KB-internal refs).
   * - Results are cached; stale entries (resolvedAt < generation) are re-resolved.
   */
  async resolve(address: string): Promise<ResolvedAddress> {
    // KB-internal addresses pass through
    if (address.startsWith('kb:')) {
      return { address, codeNodeId: null, status: 'resolved' };
    }

    // Check cache
    const cached = this.cache.get(address);
    if (cached && cached.resolvedAt >= this.generation) {
      return cached.result;
    }

    const parsed = parseSemanticAddress(address);
    if (!parsed) {
      const result: ResolvedAddress = { address, codeNodeId: null, status: 'dangling' };
      this.cache.set(address, { result, resolvedAt: this.generation });
      return result;
    }

    // Query backend for matching nodes
    const filter: Record<string, unknown> = {
      file: parsed.file,
      name: parsed.name,
      nodeType: parsed.type,
    };

    const nodes = await this.backend.getAllNodes(filter);

    let result: ResolvedAddress;

    if (nodes.length === 1) {
      result = { address, codeNodeId: nodes[0].id, status: 'resolved' };
    } else if (nodes.length === 0) {
      result = { address, codeNodeId: null, status: 'dangling' };
    } else {
      // Multiple matches — disambiguate by scope path
      const match = this.disambiguateByScope(nodes, parsed.scopePath);
      if (match) {
        result = { address, codeNodeId: match.id, status: 'resolved' };
      } else {
        // Take first match as best-effort
        result = { address, codeNodeId: nodes[0].id, status: 'resolved' };
      }
    }

    this.cache.set(address, { result, resolvedAt: this.generation });
    return result;
  }

  /**
   * Resolve multiple addresses in bulk.
   */
  async resolveAll(addresses: string[]): Promise<ResolvedAddress[]> {
    return Promise.all(addresses.map(addr => this.resolve(addr)));
  }

  /**
   * Get all addresses that resolved as dangling at the current generation.
   */
  getDanglingAddresses(): ResolvedAddress[] {
    const results: ResolvedAddress[] = [];
    for (const entry of this.cache.values()) {
      if (entry.resolvedAt >= this.generation && entry.result.status === 'dangling') {
        results.push(entry.result);
      }
    }
    return results;
  }

  /**
   * Disambiguate multiple matching nodes using the scope path from the address.
   * Matches the node whose scopePath best matches the address's scope segments.
   */
  private disambiguateByScope(
    nodes: Array<Record<string, unknown> & { id: string }>,
    addressScopePath: string[],
  ): { id: string } | null {
    if (addressScopePath.length === 0) return null;

    let bestMatch: { id: string } | null = null;
    let bestScore = -1;

    for (const node of nodes) {
      const nodeScopePath = node['scopePath'];
      if (!Array.isArray(nodeScopePath)) continue;

      // Score: count matching scope segments from the end
      let score = 0;
      const aLen = addressScopePath.length;
      const nLen = nodeScopePath.length;
      for (let i = 1; i <= Math.min(aLen, nLen); i++) {
        if (addressScopePath[aLen - i] === nodeScopePath[nLen - i]) {
          score++;
        } else {
          break;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = node;
      }
    }

    return bestScore > 0 ? bestMatch : null;
  }
}

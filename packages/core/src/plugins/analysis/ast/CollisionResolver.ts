/**
 * CollisionResolver - Graduated disambiguation for v2 semantic IDs.
 *
 * Pipeline position: After all visitors complete for a file, before GraphBuilder.
 *
 * Algorithm:
 * 1. Group PendingNodes by baseId
 * 2. For groups with size=1: no change needed
 * 3. For groups with size>1: compute content hashes
 *    a. If all hashes unique within group: append [h:xxxx]
 *    b. If hash collision: append [h:xxxx]#N (counter)
 *
 * Complexity: O(n) amortized where n = total nodes in file.
 */

import { computeContentHash } from '../../../core/SemanticId.js';
import type { ContentHashHints } from '../../../core/SemanticId.js';

/**
 * A node awaiting final ID assignment.
 *
 * Created by visitors during AST traversal. Contains the
 * base ID (without hash/counter) and content hints for
 * hash computation if disambiguation is needed.
 */
export interface PendingNode {
  /** Base ID: file->TYPE->name or file->TYPE->name[in:parent] */
  baseId: string;

  /** Content hints for hash computation (node-type-specific) */
  contentHints: ContentHashHints;

  /**
   * Reference to the collection object whose .id will be updated.
   * CollisionResolver mutates this in place.
   */
  collectionRef: { id: string };

  /** Original insertion order (for deterministic counter assignment) */
  insertionOrder: number;
}

export class CollisionResolver {
  /**
   * Resolve collisions and assign final IDs.
   *
   * Mutates each PendingNode's collectionRef.id in place.
   * Returns a map of baseId -> finalId for nodes that were changed,
   * used to rewrite cross-references (e.g., callArguments.parentCallId).
   *
   * Note: since multiple nodes can share the same baseId, the returned map
   * only contains entries where the OLD id on the collectionRef differs
   * from the NEW final id. Callers should use collectionRef objects for
   * precise cross-reference resolution.
   */
  resolve(nodes: PendingNode[]): void {
    if (nodes.length === 0) return;

    // Step 1: Group by baseId
    const groups = new Map<string, PendingNode[]>();
    for (const node of nodes) {
      let group = groups.get(node.baseId);
      if (!group) {
        group = [];
        groups.set(node.baseId, group);
      }
      group.push(node);
    }

    // Step 2: Process each group
    for (const [baseId, group] of groups) {
      if (group.length === 1) {
        // Unique -- base ID is final
        group[0].collectionRef.id = baseId;
        continue;
      }

      // Sort by insertion order for deterministic counter assignment
      group.sort((a, b) => a.insertionOrder - b.insertionOrder);

      // Compute hashes for all nodes in group
      const hashes = group.map(n => computeContentHash(n.contentHints));

      // Sub-group by hash
      const hashGroups = new Map<string, number[]>();
      for (let i = 0; i < group.length; i++) {
        const hash = hashes[i];
        let hg = hashGroups.get(hash);
        if (!hg) {
          hg = [];
          hashGroups.set(hash, hg);
        }
        hg.push(i);
      }

      // Assign final IDs
      for (const [hash, indices] of hashGroups) {
        if (indices.length === 1) {
          // Unique hash within collision group
          const node = group[indices[0]];
          node.collectionRef.id = this.appendHash(baseId, hash);
        } else {
          // Hash collision -- need counter
          for (let c = 0; c < indices.length; c++) {
            const node = group[indices[c]];
            node.collectionRef.id = this.appendHashAndCounter(baseId, hash, c);
          }
        }
      }
    }
  }

  /**
   * Append content hash to base ID.
   *
   * "file->TYPE->name" -> "file->TYPE->name[h:xxxx]"
   * "file->TYPE->name[in:parent]" -> "file->TYPE->name[in:parent,h:xxxx]"
   */
  private appendHash(baseId: string, hash: string): string {
    const bracketIdx = baseId.indexOf('[');
    if (bracketIdx === -1) {
      return `${baseId}[h:${hash}]`;
    }
    // Insert hash before closing bracket
    return `${baseId.slice(0, -1)},h:${hash}]`;
  }

  /**
   * Append content hash and counter to base ID.
   * Counter 0 is omitted (first occurrence doesn't need disambiguation).
   */
  private appendHashAndCounter(baseId: string, hash: string, counter: number): string {
    const withHash = this.appendHash(baseId, hash);
    if (counter === 0) return withHash;
    return `${withHash}#${counter}`;
  }
}

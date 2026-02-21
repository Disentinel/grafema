/**
 * Unit tests for findNodeAtCursor — REG-530
 *
 * Tests cursor-to-node matching, especially for multi-specifier imports
 * where multiple IMPORT nodes share the same line but have different
 * column ranges (column..endColumn).
 *
 * Since the vscode package uses extensionless TS imports that can't be
 * resolved by Node.js native TS strip mode, we register a custom ESM
 * resolve hook that appends .ts to bare relative imports.
 *
 * Mock setup: stub client returning WireNode arrays via getAllNodes().
 * No RFDB server or vscode dependency needed — pure logic tests.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// ============================================================================
// Register ESM resolve hook for .ts extension resolution
// ============================================================================

// Register a loader that rewrites extensionless relative imports to .ts
// within the vscode/src directory.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  // Only intercept relative imports without extensions
  if (specifier.startsWith('./') && !specifier.endsWith('.js') && !specifier.endsWith('.ts') && !specifier.endsWith('.json') && context.parentURL?.includes('packages/vscode/src/')) {
    return nextResolve(specifier + '.ts', context);
  }
  // Mock external packages used by nodeLocator.ts (type-only imports, stripped at runtime)
  if (specifier === '@grafema/rfdb-client' || specifier === '@grafema/types') {
    return { url: 'data:text/javascript,export default {}', shortCircuit: true };
  }
  if (specifier === 'vscode') {
    return { url: 'data:text/javascript,export default {}', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`));

// ============================================================================
// Types (lightweight, no runtime deps)
// ============================================================================

interface WireNode {
  id: string;
  nodeType: string;
  name: string;
  file: string;
  exported: boolean;
  metadata: string;
}

// ============================================================================
// Import the module under test
// ============================================================================

let findNodeAtCursor: (
  client: { getAllNodes: (q?: { file?: string }) => Promise<WireNode[]> },
  filePath: string,
  line: number,
  column: number,
) => Promise<WireNode | null>;

before(async () => {
  const mod = await import('../../src/nodeLocator.ts');
  findNodeAtCursor = mod.findNodeAtCursor;
});

// ============================================================================
// Mock infrastructure
// ============================================================================

/**
 * Create a minimal mock client with getAllNodes().
 * Only getAllNodes is needed by findNodeAtCursor.
 */
function createMockClient(nodes: WireNode[]) {
  return {
    getAllNodes: async (query?: { file?: string; nodeType?: string }) => {
      return nodes.filter((n) => {
        if (query?.file && n.file !== query.file) return false;
        if (query?.nodeType && n.nodeType !== query.nodeType) return false;
        return true;
      });
    },
  };
}

/**
 * Helper to create a WireNode with metadata JSON string.
 */
function makeImportNode(
  id: string,
  name: string,
  file: string,
  meta: { line: number; column?: number; endColumn?: number; endLine?: number },
): WireNode {
  return {
    id,
    nodeType: 'IMPORT',
    name,
    file,
    exported: false,
    metadata: JSON.stringify(meta),
  };
}

function makeFunctionNode(
  id: string,
  name: string,
  file: string,
  meta: { line: number; column?: number; endColumn?: number; endLine?: number },
): WireNode {
  return {
    id,
    nodeType: 'FUNCTION',
    name,
    file,
    exported: false,
    metadata: JSON.stringify(meta),
  };
}

// ============================================================================
// Test constants
// ============================================================================

const FILE = '/project/src/utils.js';

// ============================================================================
// SECTION A: Multi-specifier import — cursor on each specifier
//
// Simulates: import { join, resolve, basename } from 'path'
// 3 IMPORT nodes, all line=1, with different column ranges:
//   join:     column=9,  endColumn=13
//   resolve:  column=15, endColumn=22
//   basename: column=24, endColumn=32
// ============================================================================

describe('findNodeAtCursor — multi-specifier imports (REG-530)', () => {
  const joinNode = makeImportNode('imp-join', 'join', FILE, {
    line: 1, column: 9, endColumn: 13,
  });
  const resolveNode = makeImportNode('imp-resolve', 'resolve', FILE, {
    line: 1, column: 15, endColumn: 22,
  });
  const basenameNode = makeImportNode('imp-basename', 'basename', FILE, {
    line: 1, column: 24, endColumn: 32,
  });
  const allNodes = [joinNode, resolveNode, basenameNode];

  it('cursor inside "join" range → returns join node', async () => {
    const client = createMockClient(allNodes);
    const result = await findNodeAtCursor(client, FILE, 1, 10);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-join');
    assert.strictEqual(result.name, 'join');
  });

  it('cursor inside "resolve" range → returns resolve node', async () => {
    const client = createMockClient(allNodes);
    const result = await findNodeAtCursor(client, FILE, 1, 17);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-resolve');
    assert.strictEqual(result.name, 'resolve');
  });

  it('cursor inside "basename" range → returns basename node', async () => {
    const client = createMockClient(allNodes);
    const result = await findNodeAtCursor(client, FILE, 1, 26);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-basename');
    assert.strictEqual(result.name, 'basename');
  });

  it('cursor at exact start of "join" range (column=9) → returns join node', async () => {
    const client = createMockClient(allNodes);
    const result = await findNodeAtCursor(client, FILE, 1, 9);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-join');
  });

  it('cursor at exact start of "resolve" range (column=15) → returns resolve node', async () => {
    const client = createMockClient(allNodes);
    const result = await findNodeAtCursor(client, FILE, 1, 15);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-resolve');
  });
});

// ============================================================================
// SECTION B: Exclusive end — cursor at boundary
//
// endColumn is exclusive (like Babel AST ranges), so cursor AT endColumn
// is outside the node's range and should NOT match via range matching.
// ============================================================================

describe('findNodeAtCursor — exclusive endColumn boundary', () => {
  const joinNode = makeImportNode('imp-join', 'join', FILE, {
    line: 1, column: 9, endColumn: 13,
  });
  const resolveNode = makeImportNode('imp-resolve', 'resolve', FILE, {
    line: 1, column: 15, endColumn: 22,
  });

  it('cursor at endColumn of "join" (col=13) → should NOT range-match join', async () => {
    const client = createMockClient([joinNode, resolveNode]);
    const result = await findNodeAtCursor(client, FILE, 1, 13);

    // endColumn=13 is exclusive, so col 13 is outside join's range.
    // It should fall through to distance-based matching.
    // join: distance = |9-13| = 4, specificity = 996
    // resolve: distance = |15-13| = 2, specificity = 998
    // resolve wins by distance
    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-resolve',
      'Cursor at exclusive endColumn of join should resolve to closer node by distance');
  });

  it('cursor one before endColumn of "join" (col=12) → should match join', async () => {
    const client = createMockClient([joinNode, resolveNode]);
    const result = await findNodeAtCursor(client, FILE, 1, 12);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-join');
  });
});

// ============================================================================
// SECTION C: Backward compat — nodes WITHOUT endColumn
//
// Existing nodes in the graph may not have endColumn. findNodeAtCursor
// should fall back to distance-based matching (current behavior).
// ============================================================================

describe('findNodeAtCursor — backward compat (no endColumn)', () => {
  it('nodes without endColumn → falls back to distance-based matching', async () => {
    // 3 IMPORT nodes, all line=1, column=0, no endColumn
    const node1 = makeImportNode('imp-a', 'useState', FILE, { line: 1, column: 0 });
    const node2 = makeImportNode('imp-b', 'useEffect', FILE, { line: 1, column: 0 });
    const node3 = makeImportNode('imp-c', 'useMemo', FILE, { line: 1, column: 0 });

    const client = createMockClient([node1, node2, node3]);
    const result = await findNodeAtCursor(client, FILE, 1, 10);

    // All have equal distance from cursor (column=0, distance=10).
    // Should return one of them (first wins in stable sort).
    assert.ok(result, 'Should find a node via distance fallback');
    assert.strictEqual(result.nodeType, 'IMPORT');
  });

  it('nodes with column but no endColumn → closest column wins', async () => {
    const nodeA = makeImportNode('imp-a', 'join', FILE, { line: 1, column: 5 });
    const nodeB = makeImportNode('imp-b', 'resolve', FILE, { line: 1, column: 20 });

    const client = createMockClient([nodeA, nodeB]);

    // Cursor at col 8: distance to A is 3, distance to B is 12. A wins.
    const result = await findNodeAtCursor(client, FILE, 1, 8);
    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-a');
  });
});

// ============================================================================
// SECTION D: Mixed — some nodes have endColumn, some don't
//
// When one node has endColumn and contains the cursor (range match),
// it should beat distance-only matches because range specificity (2000)
// is higher than distance specificity (1000 - distance).
// ============================================================================

describe('findNodeAtCursor — mixed endColumn presence', () => {
  it('range match (with endColumn) wins over distance match (without endColumn)', async () => {
    // Node with precise range: column=9, endColumn=13
    const rangeNode = makeImportNode('imp-range', 'join', FILE, {
      line: 1, column: 9, endColumn: 13,
    });

    // Node without endColumn, closer by column distance
    const distanceNode = makeImportNode('imp-dist', 'React', FILE, {
      line: 1, column: 10,  // distance to cursor(11) = 1
    });

    const client = createMockClient([rangeNode, distanceNode]);

    // Cursor at col 11 — inside rangeNode's range [9,13), also close to distanceNode.
    // Range match specificity (2000) > distance specificity (1000-1 = 999).
    const result = await findNodeAtCursor(client, FILE, 1, 11);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-range',
      'Range match should beat distance match');
  });

  it('cursor outside range node but close → distance-only node wins', async () => {
    const rangeNode = makeImportNode('imp-range', 'join', FILE, {
      line: 1, column: 9, endColumn: 13,
    });

    // Node without endColumn, at column 14 (closer to cursor at 14)
    const distanceNode = makeImportNode('imp-dist', 'resolve', FILE, {
      line: 1, column: 14,
    });

    const client = createMockClient([rangeNode, distanceNode]);

    // Cursor at col 14 — outside rangeNode's range [9,13), right on distanceNode
    // rangeNode: distance = |9-14| = 5, specificity = 995
    // distanceNode: distance = |14-14| = 0, specificity = 1000
    // distanceNode wins
    const result = await findNodeAtCursor(client, FILE, 1, 14);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-dist');
  });
});

// ============================================================================
// SECTION E: No match on line — fallback to closest node by line
// ============================================================================

describe('findNodeAtCursor — no nodes on cursor line', () => {
  it('cursor on empty line → falls back to closest node by line distance', async () => {
    const nodeOnLine3 = makeFunctionNode('fn-a', 'handleRequest', FILE, {
      line: 3, column: 0,
    });
    const nodeOnLine10 = makeFunctionNode('fn-b', 'validate', FILE, {
      line: 10, column: 0,
    });

    const client = createMockClient([nodeOnLine3, nodeOnLine10]);

    // Cursor at line 5 — no nodes on line 5.
    // Closest by line: line 3 (distance=2) beats line 10 (distance=5).
    const result = await findNodeAtCursor(client, FILE, 5, 0);

    assert.ok(result, 'Should find a node via line fallback');
    assert.strictEqual(result.id, 'fn-a',
      'Should return closest node by line number');
  });

  it('no nodes in file at all → returns null', async () => {
    const client = createMockClient([]);
    const result = await findNodeAtCursor(client, FILE, 1, 0);

    assert.strictEqual(result, null);
  });

  it('nodes exist but in different file → returns null', async () => {
    const otherFileNode = makeImportNode('imp-x', 'foo', '/other/file.js', {
      line: 1, column: 0,
    });

    const client = createMockClient([otherFileNode]);
    const result = await findNodeAtCursor(client, FILE, 1, 0);

    assert.strictEqual(result, null);
  });
});

// ============================================================================
// SECTION F: Edge cases
// ============================================================================

describe('findNodeAtCursor — edge cases', () => {
  it('nodes with no metadata line → skipped in matching', async () => {
    const noLineNode: WireNode = {
      id: 'no-line',
      nodeType: 'IMPORT',
      name: 'orphan',
      file: FILE,
      exported: false,
      metadata: '{}',  // no line field
    };
    const validNode = makeImportNode('valid', 'join', FILE, { line: 1, column: 0 });

    const client = createMockClient([noLineNode, validNode]);
    const result = await findNodeAtCursor(client, FILE, 1, 0);

    assert.ok(result, 'Should find the valid node');
    assert.strictEqual(result.id, 'valid');
  });

  it('node with invalid metadata JSON → skipped gracefully', async () => {
    const badMetaNode: WireNode = {
      id: 'bad-meta',
      nodeType: 'IMPORT',
      name: 'broken',
      file: FILE,
      exported: false,
      metadata: 'not-json',
    };
    const validNode = makeImportNode('valid', 'join', FILE, { line: 1, column: 0 });

    const client = createMockClient([badMetaNode, validNode]);
    const result = await findNodeAtCursor(client, FILE, 1, 0);

    assert.ok(result, 'Should find the valid node despite broken metadata');
    assert.strictEqual(result.id, 'valid');
  });

  it('single node on line → always returned regardless of column', async () => {
    const node = makeImportNode('only', 'React', FILE, {
      line: 1, column: 0, endColumn: 5,
    });

    const client = createMockClient([node]);

    // Cursor far from node's column range — should still match via distance fallback
    const result = await findNodeAtCursor(client, FILE, 1, 50);

    assert.ok(result, 'Should find the only node on the line');
    assert.strictEqual(result.id, 'only');
  });
});

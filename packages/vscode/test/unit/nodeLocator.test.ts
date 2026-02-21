/**
 * Unit tests for nodeLocator.ts — REG-531 + REG-530
 *
 * Tests findNodeAtCursor with the containment-based algorithm:
 * 1. Containment matching: cursor within [start, end] range, smaller span = more specific
 * 2. Proximity fallback: nodes without end positions use column distance
 * 3. Type bonus: CALL nodes get +100 specificity bonus
 * 4. Zero-location guard: endLine=0 or endColumn=0 skips containment
 * 5. Multi-specifier imports: endColumn differentiates import bindings on same line
 *
 * Mock setup: in-memory graph with synthetic WireNode objects.
 * No RFDB server needed — pure logic tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WireNode, IRFDBClient } from '@grafema/types';

// ============================================================================
// Mock infrastructure
// ============================================================================

interface MockGraph {
  nodes: Record<string, WireNode>;
}

/**
 * Create a mock IRFDBClient backed by an in-memory graph.
 *
 * Only implements getAllNodes — the only method findNodeAtCursor uses.
 */
function createMockClient(graph: MockGraph): IRFDBClient {
  return {
    getAllNodes: async (query?: { file?: string; nodeType?: string }) => {
      return Object.values(graph.nodes).filter((n) => {
        if (query?.file && n.file !== query.file) return false;
        if (query?.nodeType && n.nodeType !== query.nodeType) return false;
        return true;
      });
    },
  } as IRFDBClient;
}

/**
 * Helper to create a WireNode with position metadata.
 *
 * @param id       - Unique node ID
 * @param nodeType - Node type (CALL, PROPERTY_ACCESS, FUNCTION, etc.)
 * @param name     - Display name
 * @param pos      - Position metadata: { line, column, endLine?, endColumn? }
 */
function makeNode(
  id: string,
  nodeType: string,
  name: string,
  pos: { line: number; column: number; endLine?: number; endColumn?: number },
  file = 'src/service.ts',
): WireNode {
  const metadata: Record<string, unknown> = {
    line: pos.line,
    column: pos.column,
  };
  if (pos.endLine !== undefined) metadata.endLine = pos.endLine;
  if (pos.endColumn !== undefined) metadata.endColumn = pos.endColumn;

  return {
    id,
    nodeType: nodeType as WireNode['nodeType'],
    name,
    file,
    exported: false,
    metadata: JSON.stringify(metadata),
  };
}

// ============================================================================
// Import the module under test
//
// Uses require() to load the compiled JS output from dist/.
// If nodeLocator.ts has not been compiled, this will fail with a clear error.
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { findNodeAtCursor } = require('../../src/nodeLocator');

// ============================================================================
// Test 1: Chained method call — CALL wins over PROPERTY_ACCESS
// ============================================================================

describe('findNodeAtCursor — chained method call', () => {
  it('CALL node preferred over PROPERTY_ACCESS when cursor is inside CALL span', async () => {
    // Scenario: this.obj.method() on line 10
    // CALL spans the entire expression, PROPERTY_ACCESS spans just "obj"
    const graph: MockGraph = {
      nodes: {
        call1: makeNode('call1', 'CALL', 'this.obj.method', {
          line: 10, column: 4, endLine: 10, endColumn: 35,
        }),
        prop1: makeNode('prop1', 'PROPERTY_ACCESS', 'obj', {
          line: 10, column: 9, endLine: 10, endColumn: 12,
        }),
      },
    };

    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, 'src/service.ts', 10, 20);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'call1', 'CALL node should win over PROPERTY_ACCESS at col 20');
  });
});

// ============================================================================
// Test 2: Chained call — cursor at various positions within CALL span
// ============================================================================

describe('findNodeAtCursor — cursor at various positions in chained call', () => {
  const graph: MockGraph = {
    nodes: {
      call1: makeNode('call1', 'CALL', 'this.obj.method', {
        line: 10, column: 4, endLine: 10, endColumn: 35,
      }),
      prop1: makeNode('prop1', 'PROPERTY_ACCESS', 'obj', {
        line: 10, column: 9, endLine: 10, endColumn: 12,
      }),
    },
  };

  it('cursor at col 4 (start of CALL) -> CALL', async () => {
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, 'src/service.ts', 10, 4);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'call1', 'CALL node should be selected at its start position');
  });

  it('cursor at col 9 (on property) -> CALL (CALL contains cursor and has type bonus)', async () => {
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, 'src/service.ts', 10, 9);

    assert.ok(result, 'Should find a node');
    // At col 9, both CALL (span 31) and PROPERTY_ACCESS (span 3) contain cursor.
    // PROPERTY_ACCESS has smaller span, but CALL has +100 type bonus.
    // The algorithm should prefer CALL due to the bonus.
    assert.strictEqual(result.id, 'call1', 'CALL node should win due to type bonus');
  });

  it('cursor at col 30 (on method name) -> CALL', async () => {
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, 'src/service.ts', 10, 30);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'call1', 'CALL node should be selected at method name position');
  });
});

// ============================================================================
// Test 3: Multi-line call — cursor on second line of span
// ============================================================================

describe('findNodeAtCursor — multi-line call', () => {
  it('cursor on second line of multi-line CALL span', async () => {
    // CALL spans lines 10-11
    const graph: MockGraph = {
      nodes: {
        call1: makeNode('call1', 'CALL', 'this.manager.build', {
          line: 10, column: 4, endLine: 11, endColumn: 30,
        }),
      },
    };

    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, 'src/service.ts', 11, 10);

    assert.ok(result, 'Should find a node on second line of multi-line call');
    assert.strictEqual(result.id, 'call1', 'Multi-line CALL should be found when cursor is on line 11');
  });
});

// ============================================================================
// Test 4: Property access without call — no CALL node exists
// ============================================================================

describe('findNodeAtCursor — property access without call', () => {
  it('PROPERTY_ACCESS selected when no CALL node exists', async () => {
    const graph: MockGraph = {
      nodes: {
        prop1: makeNode('prop1', 'PROPERTY_ACCESS', 'prop', {
          line: 10, column: 15, endLine: 10, endColumn: 19,
        }),
      },
    };

    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, 'src/service.ts', 10, 17);

    assert.ok(result, 'Should find the PROPERTY_ACCESS node');
    assert.strictEqual(result.id, 'prop1', 'PROPERTY_ACCESS should be selected when it is the only candidate');
  });
});

// ============================================================================
// Test 5: Multiple calls on same line — correct one selected by position
// ============================================================================

describe('findNodeAtCursor — multiple calls on same line', () => {
  const graph: MockGraph = {
    nodes: {
      callFoo: makeNode('callFoo', 'CALL', 'foo', {
        line: 10, column: 0, endLine: 10, endColumn: 4,
      }),
      callBar: makeNode('callBar', 'CALL', 'bar', {
        line: 10, column: 6, endLine: 10, endColumn: 10,
      }),
    },
  };

  it('cursor at col 1 -> "foo"', async () => {
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, 'src/service.ts', 10, 1);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'callFoo', 'Cursor at col 1 should match "foo" (span 0-4)');
  });

  it('cursor at col 8 -> "bar"', async () => {
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, 'src/service.ts', 10, 8);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'callBar', 'Cursor at col 8 should match "bar" (span 6-10)');
  });
});

// ============================================================================
// Test 6: Nested calls — inner call preferred (smaller span)
// ============================================================================

describe('findNodeAtCursor — nested calls', () => {
  it('inner CALL preferred over outer CALL when cursor is within both', async () => {
    // outer(inner()) — cursor inside inner's span
    const graph: MockGraph = {
      nodes: {
        outer: makeNode('outer', 'CALL', 'outer', {
          line: 10, column: 0, endLine: 10, endColumn: 20,
        }),
        inner: makeNode('inner', 'CALL', 'inner', {
          line: 10, column: 6, endLine: 10, endColumn: 14,
        }),
      },
    };

    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, 'src/service.ts', 10, 10);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(
      result.id,
      'inner',
      'Inner CALL (smaller span) should be preferred over outer CALL',
    );
  });
});

// ============================================================================
// Test 7: Fallback — nodes without end positions use proximity
// ============================================================================

describe('findNodeAtCursor — proximity fallback', () => {
  it('nodes without endLine/endColumn use proximity + type bonus', async () => {
    // Two nodes on line 10 with no end positions
    const graph: MockGraph = {
      nodes: {
        callFoo: makeNode('callFoo', 'CALL', 'foo', {
          line: 10, column: 0,
        }),
        propBar: makeNode('propBar', 'PROPERTY_ACCESS', 'bar', {
          line: 10, column: 5,
        }),
      },
    };

    const client = createMockClient(graph);
    // Cursor at col 3 — distance to CALL(0) = 3, distance to PROP(5) = 2
    // Proximity alone: PROP wins (closer). But CALL has +100 bonus.
    // CALL: 1000 - 3 + 100 = 1097; PROP: 1000 - 2 = 998
    const result = await findNodeAtCursor(client, 'src/service.ts', 10, 3);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(
      result.id,
      'callFoo',
      'CALL node should win via type bonus despite PROPERTY_ACCESS being closer',
    );
  });
});

// ============================================================================
// Test 8: Zero-location guard — endLine=0, endColumn=0 skips containment
// ============================================================================

describe('findNodeAtCursor — zero-location guard', () => {
  it('endLine=0 and endColumn=0 should not use containment matching', async () => {
    // Node has endLine=0 and endColumn=0 (sentinel/unset values)
    // Should fall back to proximity, not treat as valid containment range
    const graph: MockGraph = {
      nodes: {
        call1: makeNode('call1', 'CALL', 'foo', {
          line: 10, column: 0, endLine: 0, endColumn: 0,
        }),
      },
    };

    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, 'src/service.ts', 10, 5);

    // The node is on line 10 with endLine=0 — the guard should prevent
    // containment matching (0:0 is not a valid end position).
    // It should still be found via proximity on line 10.
    assert.ok(result, 'Should still find the node via proximity fallback');
    assert.strictEqual(result.id, 'call1', 'Node should be found via proximity, not containment');
  });
});

// ============================================================================
// Edge case: empty file — no nodes
// ============================================================================

describe('findNodeAtCursor — empty file', () => {
  it('returns null when no nodes exist in file', async () => {
    const graph: MockGraph = { nodes: {} };
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, 'src/empty.ts', 1, 0);

    assert.strictEqual(result, null, 'Should return null for file with no nodes');
  });
});

// ============================================================================
// REG-530: Multi-specifier import — cursor on each specifier
//
// Simulates: import { join, resolve, basename } from 'path'
// 3 IMPORT nodes, all line=1, with different column ranges
// ============================================================================

const IMPORT_FILE = '/project/src/utils.js';

describe('findNodeAtCursor — multi-specifier imports (REG-530)', () => {
  const graph: MockGraph = {
    nodes: {
      'imp-join': makeNode('imp-join', 'IMPORT', 'join',
        { line: 1, column: 9, endLine: 1, endColumn: 13 }, IMPORT_FILE),
      'imp-resolve': makeNode('imp-resolve', 'IMPORT', 'resolve',
        { line: 1, column: 15, endLine: 1, endColumn: 22 }, IMPORT_FILE),
      'imp-basename': makeNode('imp-basename', 'IMPORT', 'basename',
        { line: 1, column: 24, endLine: 1, endColumn: 32 }, IMPORT_FILE),
    },
  };

  it('cursor inside "join" range -> returns join node', async () => {
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, IMPORT_FILE, 1, 10);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-join');
    assert.strictEqual(result.name, 'join');
  });

  it('cursor inside "resolve" range -> returns resolve node', async () => {
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, IMPORT_FILE, 1, 17);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-resolve');
    assert.strictEqual(result.name, 'resolve');
  });

  it('cursor inside "basename" range -> returns basename node', async () => {
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, IMPORT_FILE, 1, 26);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-basename');
    assert.strictEqual(result.name, 'basename');
  });

  it('cursor at exact start of "join" range (column=9) -> returns join node', async () => {
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, IMPORT_FILE, 1, 9);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-join');
  });

  it('cursor at exact start of "resolve" range (column=15) -> returns resolve node', async () => {
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, IMPORT_FILE, 1, 15);

    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-resolve');
  });
});

// ============================================================================
// REG-530: Backward compat — nodes WITHOUT endColumn
// ============================================================================

describe('findNodeAtCursor — backward compat (no endColumn)', () => {
  it('nodes without endColumn fall back to distance-based matching', async () => {
    const graph: MockGraph = {
      nodes: {
        'imp-a': makeNode('imp-a', 'IMPORT', 'useState', { line: 1, column: 0 }, IMPORT_FILE),
        'imp-b': makeNode('imp-b', 'IMPORT', 'useEffect', { line: 1, column: 0 }, IMPORT_FILE),
        'imp-c': makeNode('imp-c', 'IMPORT', 'useMemo', { line: 1, column: 0 }, IMPORT_FILE),
      },
    };

    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, IMPORT_FILE, 1, 10);

    // All have equal distance from cursor (column=0, distance=10).
    // Should return one of them (first wins in stable sort).
    assert.ok(result, 'Should find a node via distance fallback');
    assert.strictEqual(result.nodeType, 'IMPORT');
  });

  it('nodes with column but no endColumn — closest column wins', async () => {
    const graph: MockGraph = {
      nodes: {
        'imp-a': makeNode('imp-a', 'IMPORT', 'join', { line: 1, column: 5 }, IMPORT_FILE),
        'imp-b': makeNode('imp-b', 'IMPORT', 'resolve', { line: 1, column: 20 }, IMPORT_FILE),
      },
    };

    const client = createMockClient(graph);

    // Cursor at col 8: distance to A is 3, distance to B is 12. A wins.
    const result = await findNodeAtCursor(client, IMPORT_FILE, 1, 8);
    assert.ok(result, 'Should find a node');
    assert.strictEqual(result.id, 'imp-a');
  });
});

// ============================================================================
// REG-530: No match on line — fallback to closest by line
// ============================================================================

describe('findNodeAtCursor — no nodes on cursor line', () => {
  it('cursor on empty line — falls back to closest node by line distance', async () => {
    const graph: MockGraph = {
      nodes: {
        'fn-a': makeNode('fn-a', 'FUNCTION', 'handleRequest', { line: 3, column: 0 }, IMPORT_FILE),
        'fn-b': makeNode('fn-b', 'FUNCTION', 'validate', { line: 10, column: 0 }, IMPORT_FILE),
      },
    };

    const client = createMockClient(graph);

    // Cursor at line 5 — closest by line: line 3 (distance=2) beats line 10 (distance=5).
    const result = await findNodeAtCursor(client, IMPORT_FILE, 5, 0);

    assert.ok(result, 'Should find a node via line fallback');
    assert.strictEqual(result.id, 'fn-a', 'Should return closest node by line number');
  });

  it('no nodes in file at all -> returns null', async () => {
    const graph: MockGraph = { nodes: {} };
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, IMPORT_FILE, 1, 0);

    assert.strictEqual(result, null);
  });

  it('nodes exist but in different file -> returns null', async () => {
    const graph: MockGraph = {
      nodes: {
        'imp-x': makeNode('imp-x', 'IMPORT', 'foo', { line: 1, column: 0 }, '/other/file.js'),
      },
    };

    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, IMPORT_FILE, 1, 0);

    assert.strictEqual(result, null);
  });
});

// ============================================================================
// REG-530: Edge cases
// ============================================================================

describe('findNodeAtCursor — metadata edge cases', () => {
  it('nodes with no metadata line are skipped in matching', async () => {
    const noLineNode: WireNode = {
      id: 'no-line',
      nodeType: 'IMPORT' as WireNode['nodeType'],
      name: 'orphan',
      file: IMPORT_FILE,
      exported: false,
      metadata: '{}',
    };
    const validNode = makeNode('valid', 'IMPORT', 'join', { line: 1, column: 0 }, IMPORT_FILE);

    const graph: MockGraph = { nodes: { 'no-line': noLineNode, valid: validNode } };
    const client = createMockClient(graph);
    const result = await findNodeAtCursor(client, IMPORT_FILE, 1, 0);

    assert.ok(result, 'Should find the valid node');
    assert.strictEqual(result.id, 'valid');
  });

  it('single node on line — always returned regardless of column', async () => {
    const graph: MockGraph = {
      nodes: {
        only: makeNode('only', 'IMPORT', 'React', { line: 1, column: 0, endLine: 1, endColumn: 5 }, IMPORT_FILE),
      },
    };

    const client = createMockClient(graph);

    // Cursor far from node's column range — should still match via distance fallback
    const result = await findNodeAtCursor(client, IMPORT_FILE, 1, 50);

    assert.ok(result, 'Should find the only node on the line');
    assert.strictEqual(result.id, 'only');
  });
});

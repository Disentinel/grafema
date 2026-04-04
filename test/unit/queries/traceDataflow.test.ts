/**
 * Tests for traceDataflow backward BFS call boundary crossing (REG-576)
 *
 * Verifies that backward trace follows CALL → CALLS → FUNCTION → RETURNS → expressions
 * to cross function call boundaries and reach return value sources.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { traceBackwardBFS, type DataflowBackend, type DataflowNode, type DataflowEdge } from '@grafema/util';

// =============================================================================
// MOCK BACKEND
// =============================================================================

class MockBackend implements DataflowBackend {
  private nodes: Map<string, DataflowNode> = new Map();
  private edges: DataflowEdge[] = [];

  addNode(node: DataflowNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: DataflowEdge): void {
    this.edges.push(edge);
  }

  async getNode(id: string): Promise<DataflowNode | null> {
    return this.nodes.get(id) ?? null;
  }

  async *queryNodes(filter: Record<string, unknown>): AsyncIterable<DataflowNode> {
    for (const node of this.nodes.values()) {
      let match = true;
      for (const [key, val] of Object.entries(filter)) {
        if ((node as Record<string, unknown>)[key] !== val) { match = false; break; }
      }
      if (match) yield node;
    }
  }

  async getOutgoingEdges(id: string, types?: string[] | null): Promise<DataflowEdge[]> {
    return this.edges.filter(
      (e) => e.src === id && (!types || types.includes(e.type))
    );
  }

  async getIncomingEdges(id: string, types?: string[] | null): Promise<DataflowEdge[]> {
    return this.edges.filter(
      (e) => e.dst === id && (!types || types.includes(e.type))
    );
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('traceBackwardBFS — call boundary crossing (REG-576)', () => {
  let db: MockBackend;

  beforeEach(() => {
    db = new MockBackend();
  });

  it('should cross call boundary: VARIABLE ← CALL → FUNCTION → RETURNS → LITERAL', async () => {
    // Graph: const result = foo();  function foo() { return 'hello'; }
    //
    // VARIABLE:result ←ASSIGNED_FROM← CALL:foo →CALLS→ FUNCTION:foo →RETURNS→ LITERAL:'hello'
    db.addNode({ id: 'var-result', type: 'VARIABLE', name: 'result', file: 'app.ts', line: 1 });
    db.addNode({ id: 'call-foo', type: 'CALL', name: 'foo', file: 'app.ts', line: 1 });
    db.addNode({ id: 'fn-foo', type: 'FUNCTION', name: 'foo', file: 'util.ts', line: 5 });
    db.addNode({ id: 'lit-hello', type: 'LITERAL', name: "'hello'", file: 'util.ts', line: 6 });

    db.addEdge({ src: 'var-result', dst: 'call-foo', type: 'ASSIGNED_FROM' });
    db.addEdge({ src: 'call-foo', dst: 'fn-foo', type: 'CALLS' });
    db.addEdge({ src: 'fn-foo', dst: 'lit-hello', type: 'RETURNS' });

    const reached = await traceBackwardBFS(db, 'var-result', 5000);
    const reachedIds = reached.map(n => n.id);

    assert.ok(reachedIds.includes('call-foo'), 'Should reach the CALL node');
    assert.ok(reachedIds.includes('lit-hello'), 'Should cross call boundary and reach return LITERAL');
  });

  it('should reach multiple return values through call boundary', async () => {
    // Graph: function bar() { if (cond) return 1; return 2; }
    //        const x = bar();
    db.addNode({ id: 'var-x', type: 'VARIABLE', name: 'x', file: 'app.ts', line: 1 });
    db.addNode({ id: 'call-bar', type: 'CALL', name: 'bar', file: 'app.ts', line: 1 });
    db.addNode({ id: 'fn-bar', type: 'FUNCTION', name: 'bar', file: 'util.ts', line: 10 });
    db.addNode({ id: 'lit-1', type: 'LITERAL', name: '1', file: 'util.ts', line: 11 });
    db.addNode({ id: 'lit-2', type: 'LITERAL', name: '2', file: 'util.ts', line: 12 });

    db.addEdge({ src: 'var-x', dst: 'call-bar', type: 'ASSIGNED_FROM' });
    db.addEdge({ src: 'call-bar', dst: 'fn-bar', type: 'CALLS' });
    db.addEdge({ src: 'fn-bar', dst: 'lit-1', type: 'RETURNS' });
    db.addEdge({ src: 'fn-bar', dst: 'lit-2', type: 'RETURNS' });

    const reached = await traceBackwardBFS(db, 'var-x', 5000);
    const reachedIds = reached.map(n => n.id);

    assert.ok(reachedIds.includes('lit-1'), 'Should reach first return value');
    assert.ok(reachedIds.includes('lit-2'), 'Should reach second return value');
  });

  it('should cross call boundary for METHOD nodes', async () => {
    // Graph: const val = obj.getVal();  method getVal() { return 42; }
    db.addNode({ id: 'var-val', type: 'VARIABLE', name: 'val', file: 'app.ts', line: 1 });
    db.addNode({ id: 'call-getVal', type: 'CALL', name: 'obj.getVal', file: 'app.ts', line: 1 });
    db.addNode({ id: 'method-getVal', type: 'METHOD', name: 'getVal', file: 'service.ts', line: 20 });
    db.addNode({ id: 'lit-42', type: 'LITERAL', name: '42', file: 'service.ts', line: 21 });

    db.addEdge({ src: 'var-val', dst: 'call-getVal', type: 'ASSIGNED_FROM' });
    db.addEdge({ src: 'call-getVal', dst: 'method-getVal', type: 'CALLS' });
    db.addEdge({ src: 'method-getVal', dst: 'lit-42', type: 'RETURNS' });

    const reached = await traceBackwardBFS(db, 'var-val', 5000);
    const reachedIds = reached.map(n => n.id);

    assert.ok(reachedIds.includes('lit-42'), 'Should cross call boundary for METHOD');
  });

  it('should NOT cross call boundary for non-function callee targets', async () => {
    // CALL resolves to IMPORT_BINDING (not a function) — don't follow RETURNS
    db.addNode({ id: 'var-r', type: 'VARIABLE', name: 'r', file: 'app.ts', line: 1 });
    db.addNode({ id: 'call-ib', type: 'CALL', name: 'imported', file: 'app.ts', line: 1 });
    db.addNode({ id: 'ib', type: 'IMPORT_BINDING', name: 'imported', file: 'app.ts', line: 0 });

    db.addEdge({ src: 'var-r', dst: 'call-ib', type: 'ASSIGNED_FROM' });
    db.addEdge({ src: 'call-ib', dst: 'ib', type: 'CALLS' });

    const reached = await traceBackwardBFS(db, 'var-r', 5000);
    const reachedIds = reached.map(n => n.id);

    assert.ok(reachedIds.includes('call-ib'), 'Should reach CALL');
    assert.ok(!reachedIds.includes('ib'), 'Should NOT traverse into IMPORT_BINDING via RETURNS');
  });
});

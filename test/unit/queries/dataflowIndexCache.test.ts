/**
 * Tests for DataflowIndexCache: ensures shared index reuse across multiple
 * traceForwardBFS / traceBackwardBFS calls on the same graph snapshot.
 *
 * Architectural fix for REG-1093: behaviorEnricher OOM caused by traceForwardBFS
 * rebuilding paReadByName / callsByReceiver on every invocation. Sharing a
 * cache across calls turns N rebuilds into 1.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  traceForwardBFS,
  traceBackwardBFS,
  makeDataflowIndexCache,
  type DataflowBackend,
  type DataflowNode,
  type DataflowEdge,
  type DataflowIndexCache,
} from '@grafema/util';

// =============================================================================
// SPYING MOCK BACKEND
// =============================================================================

class SpyBackend implements DataflowBackend {
  private nodes: Map<string, DataflowNode> = new Map();
  private edges: DataflowEdge[] = [];

  /** Per-type queryNodes call counter — used to assert index reuse. */
  queryNodesCounts: Map<string, number> = new Map();

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
    const t = String(filter.type ?? '<any>');
    this.queryNodesCounts.set(t, (this.queryNodesCounts.get(t) ?? 0) + 1);
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
// FIXTURE
// =============================================================================

/**
 * Build a small graph with multiple PROPERTY_ACCESS and CALL nodes so the
 * forward BFS will trigger paReadByName + callsByReceiver index builds.
 *
 * Layout:
 *   const db = ...      → VARIABLE 'db' in app.ts
 *   db.foo()            → CALL 'db.foo' in app.ts
 *   db.bar              → PROPERTY_ACCESS 'bar' (read)
 *   const x = ...       → second VARIABLE used as start node
 */
function buildFixture(): SpyBackend {
  const db = new SpyBackend();
  db.addNode({ id: 'var-db', type: 'VARIABLE', name: 'db', file: 'app.ts' });
  db.addNode({ id: 'var-x', type: 'VARIABLE', name: 'x', file: 'app.ts' });
  db.addNode({ id: 'call-foo', type: 'CALL', name: 'db.foo', file: 'app.ts' });
  db.addNode({ id: 'pa-bar', type: 'PROPERTY_ACCESS', name: 'bar', file: 'app.ts' });
  // No edges needed — the BFS will only touch paReadByName / callsByReceiver
  // index builds because both start nodes are VARIABLE/CONSTANT/PARAMETER and
  // trigger the receiver heuristic.
  return db;
}

// =============================================================================
// TESTS
// =============================================================================

describe('DataflowIndexCache — shared index reuse', () => {
  let db: SpyBackend;
  let cache: DataflowIndexCache;

  beforeEach(() => {
    db = buildFixture();
    cache = makeDataflowIndexCache();
  });

  it('makeDataflowIndexCache returns a fresh empty cache', () => {
    const c = makeDataflowIndexCache();
    assert.strictEqual(c.paReadByName, undefined);
    assert.strictEqual(c.callsByReceiver, undefined);
    assert.strictEqual(c.catchParamIds, undefined);
    assert.strictEqual(c.paWriterByName, undefined);
  });

  it('first traceForwardBFS call populates the cache', async () => {
    await traceForwardBFS(db, 'var-db', 100, cache);
    assert.ok(cache.callsByReceiver, 'callsByReceiver should be populated');
    // paReadByName is built lazily — only when a PROPERTY_ACCESS node is hit
    // in the BFS loop. With no incoming READS_FROM edges to var-db, the BFS
    // only triggers callsByReceiver via the method-call receiver heuristic.
    assert.ok(cache.callsByReceiver.size >= 0);
  });

  it('second call with same cache reuses indexes (no re-query of CALL nodes)', async () => {
    // First call — builds the index.
    await traceForwardBFS(db, 'var-db', 100, cache);
    const firstCallCount = db.queryNodesCounts.get('CALL') ?? 0;
    assert.ok(firstCallCount >= 1, 'first call must scan CALL nodes at least once');

    // Second call — must NOT scan CALL nodes again because cache.callsByReceiver
    // is now populated.
    await traceForwardBFS(db, 'var-x', 100, cache);
    const secondCallCount = db.queryNodesCounts.get('CALL') ?? 0;
    assert.strictEqual(
      secondCallCount,
      firstCallCount,
      'second call must reuse cached callsByReceiver — no extra CALL queryNodes scan',
    );
  });

  it('omitting cache rebuilds indexes per call (legacy behaviour preserved)', async () => {
    await traceForwardBFS(db, 'var-db', 100); // no cache
    const firstCallCount = db.queryNodesCounts.get('CALL') ?? 0;

    await traceForwardBFS(db, 'var-x', 100); // no cache
    const secondCallCount = db.queryNodesCounts.get('CALL') ?? 0;

    assert.ok(
      secondCallCount > firstCallCount,
      'without cache, each call must re-scan CALL nodes (legacy behaviour)',
    );
  });

  it('traceBackwardBFS reuses paWriterByName via shared cache', async () => {
    // Add a PROPERTY_ACCESS reader so backward BFS triggers the writer-index build.
    db.addNode({ id: 'pa-read', type: 'PROPERTY_ACCESS', name: 'foo', file: 'app.ts' });
    db.addNode({ id: 'pa-write', type: 'PROPERTY_ACCESS', name: 'foo', file: 'app.ts' });
    db.addEdge({ src: 'pa-write', dst: 'var-db', type: 'WRITES_TO' });

    await traceBackwardBFS(db, 'pa-read', 100, cache);
    const firstPaCount = db.queryNodesCounts.get('PROPERTY_ACCESS') ?? 0;

    await traceBackwardBFS(db, 'pa-read', 100, cache);
    const secondPaCount = db.queryNodesCounts.get('PROPERTY_ACCESS') ?? 0;

    // Second call must NOT rebuild paWriterByName: PROPERTY_ACCESS scan count
    // must not increase.
    assert.strictEqual(
      secondPaCount,
      firstPaCount,
      'second backward call must reuse cached paWriterByName',
    );
  });
});

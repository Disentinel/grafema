/**
 * Unit test for loadStream's unplaced-node handling (DAI-22 Chunk-6 §B.3).
 *
 * parseStream isn't called directly — it pulls from fetch(). Instead we
 * exercise the internal reasoning by synthesising a minimal NDJSON
 * stream via a mock fetch, then assert that the returned LayoutResult:
 *   - excludes unplaced nodes from `nodes`
 *   - includes them in `unplacedNodes`
 *   - populates `regionTree` from a nested regions header
 *   - surfaces `layout_meta` verbatim
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;
let prevFetch: unknown;
let prevWindow: unknown;

before(() => {
  prevFetch = g.fetch;
  prevWindow = g.window;
  if (g.window === undefined) {
    g.window = { addEventListener: () => undefined, removeEventListener: () => undefined };
  }
});

after(() => {
  if (prevFetch === undefined) delete g.fetch;
  else g.fetch = prevFetch;
  if (prevWindow === undefined) delete g.window;
  else g.window = prevWindow;
});

function mockStream(lines: unknown[]): Response {
  const text = lines.map((l) => JSON.stringify(l)).join('\n');
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(encoder.encode(text));
      ctl.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

describe('parseStream — DAI-22 stream frames', () => {
  it('segregates unplaced nodes and surfaces layoutMeta + regionTree', async () => {
    const frames = [
      {
        type: 'header',
        typeTable: ['FUNCTION', 'METHOD'],
        edgeTypeTable: ['CALLS'],
        regions: [
          {
            id: 'file:a.ts',
            depth: 0,
            path: 'a.ts',
            kind: 'file',
            name: 'a.ts',
            children: [],
          },
        ],
      },
      {
        type: 'layout_meta',
        source: 'committed',
        symbol_count: 3,
        committed_at: '2026-04-23T00:00:00Z',
        overflow_files: [{ file: 'a.ts', skipped: 5, cap: 2 }],
      },
      // placed
      { type: 'node', i: 0, t: 0, id: 'f1', name: 'f1', file: 'a.ts', region: 'a.ts', degree: 0, pos: { q: 0, r: 0 } },
      // placed
      { type: 'node', i: 1, t: 0, id: 'f2', name: 'f2', file: 'a.ts', region: 'a.ts', degree: 0, pos: { q: 1, r: 0 } },
      // unplaced: skipped_overflow
      { type: 'node', i: 2, t: 0, id: 'f3', name: 'f3', file: 'a.ts', region: 'a.ts', degree: 0, pos: null, unplaced_reason: 'skipped_overflow' },
      // unplaced: excluded
      { type: 'node', i: 3, t: 0, id: 'f4', name: 'f4', file: 'a.ts', region: 'a.ts', degree: 0, pos: null, unplaced_reason: 'excluded' },
      { type: 'nodes_done', count: 4 },
      { type: 'done', nodeCount: 4, edgeCount: 0, elapsed: 1 },
    ];

    g.fetch = async () => mockStream(frames);

    const mod = await import('../../../src/store/loadStream');
    const result = await mod.parseStream({ url: '/stub' });

    // Placed: only f1 + f2
    assert.equal(result.nodes.length, 2);
    assert.deepEqual(result.nodes.map((n) => n.id), ['f1', 'f2']);

    // Unplaced: f3 + f4
    assert.ok(result.unplacedNodes);
    assert.equal(result.unplacedNodes.length, 2);
    const reasons = result.unplacedNodes.map((u) => u.unplacedReason).sort();
    assert.deepEqual(reasons, ['excluded', 'skipped_overflow']);

    // Unplaced nodes still carry their metadata (file, name) for search
    const f3 = result.unplacedNodes.find((u) => u.id === 'f3');
    assert.ok(f3);
    assert.equal(f3.file, 'a.ts');
    assert.equal(f3.name, 'f3');

    // layoutMeta surfaced
    assert.ok(result.layoutMeta);
    assert.equal(result.layoutMeta.source, 'committed');
    assert.equal(result.layoutMeta.symbol_count, 3);
    assert.deepEqual(result.layoutMeta.overflow_files, [
      { file: 'a.ts', skipped: 5, cap: 2 },
    ]);

    // regionTree built from nested roots
    assert.ok(result.regionTree);
    assert.equal(result.regionTree.byId.size, 1);
    assert.ok(result.regionTree.byId.has('file:a.ts'));
  });
});

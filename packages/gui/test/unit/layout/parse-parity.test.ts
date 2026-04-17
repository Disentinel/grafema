/**
 * Parity test: parseStream and parseFixture must return the same
 * LayoutResult shape for equivalent inputs.
 *
 * This is the contract that lets fetchLayout treat both sources
 * uniformly. If parity breaks, the higher-level dispatcher will
 * surface source-specific fields to callers and couple them again.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseFixture } from '../../../src/store/loadFixture.js';
import { parseStream } from '../../../src/store/loadStream.js';
import type { LayoutResult } from '../../../src/layout/types.js';

// ----------------------------------------------------------------------------
// Shared test fixtures
// ----------------------------------------------------------------------------

function fixtureJson() {
  return {
    nodes: [
      { id: 'x/a', type: 'FUNCTION', name: 'a', file: 'x/a.ts', region: 'x', degree: 1 },
      { id: 'x/b', type: 'FUNCTION', name: 'b', file: 'x/b.ts', region: 'x', degree: 1 },
    ],
    edges: [{ source: 0, target: 1, type: 'CALLS' }],
    regions: [{ path: 'x', depth: 1, tileCount: 2 }],
  };
}

function ndjson(): string {
  return [
    JSON.stringify({
      type: 'header',
      typeTable: ['FUNCTION'],
      edgeTypeTable: ['CALLS'],
      regions: [{ path: 'x', depth: 1, tileCount: 2, parentIdx: null }],
    }),
    JSON.stringify({
      type: 'node', i: 0, t: 0,
      id: 'x/a', name: 'a', file: 'x/a.ts', region: 'x',
      degree: 1, pos: { q: 0, r: 0 },
    }),
    JSON.stringify({
      type: 'node', i: 1, t: 0,
      id: 'x/b', name: 'b', file: 'x/b.ts', region: 'x',
      degree: 1, pos: { q: 1, r: 0 },
    }),
    JSON.stringify({ type: 'nodes_done', count: 2 }),
    JSON.stringify({ type: 'edge', s: 0, d: 1, t: 0 }),
    JSON.stringify({ type: 'done', nodeCount: 2, edgeCount: 1, elapsed: 1 }),
  ].join('\n') + '\n';
}

type FetchFn = typeof globalThis.fetch;
function withFetch(handler: FetchFn, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => { globalThis.fetch = original; });
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('parseStream / parseFixture contract parity', () => {
  it('both return LayoutResult with the same key set', async () => {
    let fx: LayoutResult | null = null;
    let st: LayoutResult | null = null;

    await withFetch(
      async () => new Response(JSON.stringify(fixtureJson()), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
      async () => {
        fx = await parseFixture('./fixtures/parity.json');
      },
    );

    await withFetch(
      async () => new Response(new Blob([ndjson()]), {
        status: 200, headers: { 'content-type': 'application/x-ndjson' },
      }),
      async () => {
        st = await parseStream({});
      },
    );

    assert.ok(fx !== null && st !== null);
    const fxKeys = Object.keys(fx as object).sort();
    const stKeys = Object.keys(st as object).sort();
    assert.deepEqual(fxKeys, stKeys, 'same top-level keys');
  });

  it('both return identical identity fields for matching node[0]', async () => {
    let fx: LayoutResult | null = null;
    let st: LayoutResult | null = null;

    await withFetch(
      async () => new Response(JSON.stringify(fixtureJson()), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
      async () => { fx = await parseFixture('./fixtures/parity.json'); },
    );
    await withFetch(
      async () => new Response(new Blob([ndjson()]), {
        status: 200, headers: { 'content-type': 'application/x-ndjson' },
      }),
      async () => { st = await parseStream({}); },
    );

    assert.ok(fx !== null && st !== null);
    const f = (fx as LayoutResult).nodes[0];
    const s = (st as LayoutResult).nodes[0];
    assert.equal(f.id, s.id);
    assert.equal(f.type, s.type);
    assert.equal(f.name, s.name);
    assert.equal(f.file, s.file);
    assert.equal(f.region, s.region);
    assert.equal(f.degree, s.degree);
  });
});

/**
 * Tests for the unified layout data-fetcher (REG-XXX C7).
 *
 * `fetchLayout(opts, signal?)` dispatches between the static fixture
 * loader and the NDJSON streaming loader, returning a `LayoutResult`
 * that matches `DataState.setGraphData`'s input shape.
 *
 * Fetcher primitives MUST NOT touch `useDataStore` — wiring into the
 * store is the host's responsibility (App.tsx / back-compat wrappers).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchLayout } from '../../../src/layout/layoutClient.js';
import type { LayoutResult } from '../../../src/layout/types.js';

// ----------------------------------------------------------------------------
// Fixture-data builders (small, deterministic)
// ----------------------------------------------------------------------------

interface FixtureShape {
  nodes: Array<{
    id: string; type: string; name: string; file: string;
    region: string; degree: number; metrics?: Record<string, number>;
  }>;
  edges: Array<{ source: number; target: number; type: string }>;
  regions: Array<{ path: string; depth: number; tileCount: number }>;
}

function sampleFixture(): FixtureShape {
  return {
    nodes: [
      { id: 'a/index', type: 'FUNCTION', name: 'foo', file: 'a/index.ts', region: 'a', degree: 2 },
      { id: 'a/util',  type: 'FUNCTION', name: 'bar', file: 'a/util.ts',  region: 'a', degree: 1 },
    ],
    edges: [
      { source: 0, target: 1, type: 'CALLS' },
    ],
    regions: [
      { path: 'a', depth: 1, tileCount: 2 },
    ],
  };
}

function sampleStreamNdjson(): string {
  const lines = [
    JSON.stringify({
      type: 'header',
      typeTable: ['FUNCTION'],
      edgeTypeTable: ['CALLS'],
      regions: [{ path: 'a', depth: 1, tileCount: 2, parentIdx: null }],
    }),
    JSON.stringify({
      type: 'node',
      i: 0, t: 0,
      id: 'a/index', name: 'foo', file: 'a/index.ts', region: 'a',
      degree: 2,
      pos: { q: 0, r: 0 },
    }),
    JSON.stringify({
      type: 'node',
      i: 1, t: 0,
      id: 'a/util', name: 'bar', file: 'a/util.ts', region: 'a',
      degree: 1,
      pos: { q: 1, r: 0 },
    }),
    JSON.stringify({ type: 'nodes_done', count: 2 }),
    JSON.stringify({ type: 'edge', s: 0, d: 1, t: 0 }),
    JSON.stringify({ type: 'done', nodeCount: 2, edgeCount: 1, elapsed: 5 }),
  ];
  return lines.join('\n') + '\n';
}

// ----------------------------------------------------------------------------
// Fetch mocking helpers
// ----------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;

function withMockedFetch(handler: FetchFn, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjsonResponse(body: string): Response {
  return new Response(new Blob([body]), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('fetchLayout — fixture source', () => {
  it('parses fixture JSON into a LayoutResult without touching the store', async () => {
    await withMockedFetch(
      async (_input) => jsonResponse(sampleFixture()),
      async () => {
        const result: LayoutResult = await fetchLayout({
          source: { kind: 'fixture', path: './fixtures/sample.json' },
        });
        assert.ok(Array.isArray(result.nodes), 'nodes is array');
        assert.ok(Array.isArray(result.edges), 'edges is array');
        assert.ok(Array.isArray(result.regions), 'regions is array');
        assert.ok(Array.isArray(result.typeTable), 'typeTable is array');
        assert.ok(Array.isArray(result.edgeTypeTable), 'edgeTypeTable is array');
        assert.equal(result.nodes.length, 2, 'both nodes retained');
        assert.equal(result.edges.length, 1, 'edge retained');
        assert.equal(result.nodes[0].id, 'a/index');
        assert.equal(typeof result.nodes[0].x, 'number');
        assert.equal(typeof result.nodes[0].z, 'number');
      },
    );
  });

  it('passes the given fixture path to fetch', async () => {
    let seenUrl: string | null = null;
    await withMockedFetch(
      async (input) => {
        seenUrl = typeof input === 'string' ? input : (input as Request).url ?? String(input);
        return jsonResponse(sampleFixture());
      },
      async () => {
        await fetchLayout({
          source: { kind: 'fixture', path: './fixtures/custom.json' },
        });
      },
    );
    assert.ok(seenUrl !== null && seenUrl.includes('custom.json'), `seen: ${seenUrl}`);
  });
});

describe('fetchLayout — stream source', () => {
  it('parses NDJSON stream into a LayoutResult', async () => {
    await withMockedFetch(
      async (_input) => ndjsonResponse(sampleStreamNdjson()),
      async () => {
        const result: LayoutResult = await fetchLayout({
          source: { kind: 'stream', url: '/api/graph-stream' },
        });
        assert.equal(result.nodes.length, 2);
        assert.equal(result.edges.length, 1);
        assert.equal(result.nodes[0].id, 'a/index');
        assert.equal(result.nodes[0].type, 'FUNCTION');
        assert.equal(result.edges[0].type, 'CALLS');
        assert.equal(result.regions.length, 1);
      },
    );
  });

  it('passes the given stream url to fetch', async () => {
    let seenUrl: string | null = null;
    await withMockedFetch(
      async (input) => {
        seenUrl = typeof input === 'string' ? input : (input as Request).url ?? String(input);
        return ndjsonResponse(sampleStreamNdjson());
      },
      async () => {
        await fetchLayout({
          source: { kind: 'stream', url: '/api/custom-stream' },
        });
      },
    );
    assert.ok(seenUrl !== null && seenUrl.includes('/api/custom-stream'), `seen: ${seenUrl}`);
  });
});

describe('fetchLayout — parity between fixture and stream', () => {
  it('produces structurally equal nodes for matching inputs', async () => {
    // Build a fixture where the hand-constructed stream positions align with
    // the deterministic grid layout the fixture path produces. We only check
    // name/type/region — positions differ because fixture uses gridLayout and
    // stream uses server-provided positions. The data contract itself must match.
    const fx = sampleFixture();
    let fixtureResult: LayoutResult | null = null;
    await withMockedFetch(
      async (_input) => jsonResponse(fx),
      async () => {
        fixtureResult = await fetchLayout({
          source: { kind: 'fixture', path: './fixtures/sample.json' },
        });
      },
    );

    let streamResult: LayoutResult | null = null;
    await withMockedFetch(
      async (_input) => ndjsonResponse(sampleStreamNdjson()),
      async () => {
        streamResult = await fetchLayout({
          source: { kind: 'stream', url: '/api/graph-stream' },
        });
      },
    );

    assert.ok(fixtureResult !== null && streamResult !== null);
    const f = fixtureResult as LayoutResult;
    const s = streamResult as LayoutResult;
    // Same identity-level fields on node[0]
    assert.equal(f.nodes[0].id, s.nodes[0].id);
    assert.equal(f.nodes[0].type, s.nodes[0].type);
    assert.equal(f.nodes[0].name, s.nodes[0].name);
    assert.equal(f.nodes[0].file, s.nodes[0].file);
    assert.equal(f.nodes[0].region, s.nodes[0].region);
    assert.equal(f.nodes[0].degree, s.nodes[0].degree);
    // Same edge count + type
    assert.equal(f.edges.length, s.edges.length);
    assert.equal(f.edges[0].type, s.edges[0].type);
  });
});

describe('fetchLayout — abort', () => {
  it('rejects with AbortError when signal aborts before fetch', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await withMockedFetch(
      async (_input, init) => {
        // Simulate real fetch: check abort signal upfront.
        if (init?.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return jsonResponse(sampleFixture());
      },
      async () => {
        await assert.rejects(
          () => fetchLayout(
            { source: { kind: 'fixture', path: './fixtures/sample.json' } },
            ctl.signal,
          ),
          (err: unknown) => {
            assert.ok(err instanceof Error, 'err is Error');
            assert.equal((err as Error).name, 'AbortError');
            return true;
          },
        );
      },
    );
  });

  it('propagates signal to fetch() for stream source', async () => {
    let receivedSignal: AbortSignal | undefined;
    const ctl = new AbortController();
    await withMockedFetch(
      async (_input, init) => {
        receivedSignal = init?.signal ?? undefined;
        return ndjsonResponse(sampleStreamNdjson());
      },
      async () => {
        await fetchLayout(
          { source: { kind: 'stream', url: '/api/graph-stream' } },
          ctl.signal,
        );
      },
    );
    assert.ok(receivedSignal === ctl.signal, 'signal passed through');
  });
});

describe('fetchLayout — invalid source', () => {
  it('rejects with TypeError for unknown source kind', async () => {
    await assert.rejects(
      // @ts-expect-error — deliberately invalid kind to test runtime guard
      () => fetchLayout({ source: { kind: 'bogus', path: 'x' } }),
      (err: unknown) => {
        assert.ok(err instanceof TypeError, 'err is TypeError');
        return true;
      },
    );
  });
});

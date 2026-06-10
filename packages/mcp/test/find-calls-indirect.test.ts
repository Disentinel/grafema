/**
 * Regression test: `find_calls` must count and surface INDIRECT (callback) usages
 * consistently with pagination.
 *
 * `find_calls` advertises "Find every place in the codebase that calls a specific
 * function or method" and powers dead-code detection ("0 calls found → unused").
 * It collects two kinds of call-sites:
 *   1. direct CALL nodes ("foo()" / "obj.foo()")
 *   2. indirect usages — the function passed as an argument (a REFERENCE node with
 *      an incoming PASSES_ARGUMENT edge, e.g. `register(foo)`).
 *
 * BUG (pre-fix): the indirect-usage scan was wrapped in
 *   `if (totalMatched === 0 || calls.length < limit) { ... }`
 * so as soon as the DIRECT calls alone filled the page `limit`, the entire indirect
 * loop was skipped. Indirect call-sites were then dropped from BOTH the reported
 * total AND the results, and pagination reported `hasMore: false` — telling the
 * agent there was nothing more to fetch. Direct calls (loop 1) are always counted,
 * indirect calls (loop 2) were only counted when there was room: an asymmetry that
 * makes the total wrong and hides real call-sites whenever a popular function has
 * `>= limit` direct calls (the common case in large codebases).
 *
 * These tests are written BEFORE the fix and FAIL for the right reason until the
 * indirect loop participates in counting/pagination the same way the direct loop does.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mock } from 'node:test';

// --- Minimal in-memory graph backend exposing only what handleFindCalls uses ---

interface Edge { src: string; dst: string; type: string }
interface Node { id: string; type: string; name: string; file?: string; line?: number }

function createCallGraphBackend(nodes: Node[], edges: Edge[]) {
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);

  return {
    async *queryNodes(filter: { type?: string; name?: string } = {}) {
      for (const n of nodeMap.values()) {
        if (filter.type !== undefined && n.type !== filter.type) continue;
        if (filter.name !== undefined && n.name !== filter.name) continue;
        yield n;
      }
    },
    async getNode(id: string) {
      return nodeMap.get(id) ?? null;
    },
    async getOutgoingEdges(id: string, types?: string[]) {
      return edges.filter(e => e.src === id && (!types || types.includes(e.type)));
    },
    async getIncomingEdges(id: string, types?: string[]) {
      return edges.filter(e => e.dst === id && (!types || types.includes(e.type)));
    },
    // Unused by handleFindCalls but part of the backend surface.
    async nodeCount() { return nodeMap.size; },
  };
}

// --- Scenario: 2 direct calls + 1 indirect (callback) usage of "target" ---

function buildScenario() {
  const nodes: Node[] = [
    { id: 'CALL:a.js:1', type: 'CALL', name: 'target', file: 'a.js', line: 1 },
    { id: 'CALL:a.js:2', type: 'CALL', name: 'target', file: 'a.js', line: 2 },
    { id: 'REF:b.js:5', type: 'REFERENCE', name: 'target', file: 'b.js', line: 5 },
    { id: 'FUNCTION:b.js:registerHandler', type: 'FUNCTION', name: 'registerHandler', file: 'b.js', line: 4 },
  ];
  const edges: Edge[] = [
    // `registerHandler` passes `target` as a callback argument.
    { src: 'FUNCTION:b.js:registerHandler', dst: 'REF:b.js:5', type: 'PASSES_ARGUMENT' },
  ];
  return createCallGraphBackend(nodes, edges);
}

let mockBackend: ReturnType<typeof buildScenario>;

// Mock ensureAnalyzed BEFORE importing the handler (tests run against built dist).
mock.module('../dist/analysis.js', {
  namedExports: {
    ensureAnalyzed: async () => mockBackend,
  },
});

const { handleFindCalls } = await import('../dist/handlers/query-handlers.js');

describe('find_calls indirect (callback) usages + pagination', () => {
  beforeEach(() => {
    mockBackend = buildScenario();
  });

  it('counts indirect usages even when direct calls fill the page limit', async () => {
    // limit=2 is exactly filled by the 2 direct calls, so the buggy guard skipped
    // the indirect-usage scan entirely.
    const result = await handleFindCalls({ name: 'target', limit: 2 });
    const text = result.content[0].text as string;

    assert.ok(
      text.includes('Found 3 call(s)'),
      `total must include the indirect usage; got:\n${text}`,
    );
  });

  it('reports hasMore so the agent can page to the indirect usage', async () => {
    const result = await handleFindCalls({ name: 'target', limit: 2 });
    const text = result.content[0].text as string;

    assert.ok(
      text.includes('use offset=2 to get more'),
      `pagination must signal more results remain; got:\n${text}`,
    );
  });

  it('surfaces the indirect usage on the next page', async () => {
    const result = await handleFindCalls({ name: 'target', limit: 2, offset: 2 });
    const text = result.content[0].text as string;

    assert.ok(
      text.includes('registerHandler'),
      `the callback caller must be reachable via pagination; got:\n${text}`,
    );
    assert.ok(text.includes('Found 3 call(s)'), `total must stay consistent across pages; got:\n${text}`);
  });

  it('still includes the indirect usage when limit is generous (regression guard)', async () => {
    const result = await handleFindCalls({ name: 'target', limit: 10 });
    const text = result.content[0].text as string;

    assert.ok(text.includes('Found 3 call(s)'), `got:\n${text}`);
    assert.ok(text.includes('registerHandler'), `callback usage must be in results; got:\n${text}`);
  });
});

/**
 * Test the `semantic_search` MCP tool honors its published `top_k` parameter.
 *
 * Bug: the tool's input schema (definitions/enox-tools.ts) advertises `top_k`
 * (and the description example uses `top_k=5`), but the handler read `args.limit`
 * with a default of 20. So a caller passing `top_k=5` was silently ignored and
 * got 20 results — a schema/handler param mismatch on a live tool
 * (dispatched at server.ts `case 'semantic_search'`).
 *
 * The handler accepts an optional injected client so its result-limiting logic
 * is testable without standing up the knowledge RFDB backend.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { handleSemanticSearch } from '../dist/handlers/enox-handlers.js';
import { ENOX_TOOLS } from '../dist/definitions/enox-tools.js';

/** Minimal fake RFDBClient — handleSemanticSearch only calls queryNodes(). */
function fakeClient(nodeCount: number): any {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i + 1}`,
    name: `match${i + 1}`,
    nodeType: 'fact',
    metadata: '{}',
  }));
  return {
    // eslint-disable-next-line require-yield
    async *queryNodes() {
      for (const n of nodes) yield n;
    },
  };
}

function countFromResult(res: any): string {
  return res.content?.[0]?.text ?? '';
}

describe('semantic_search top_k parameter (schema/handler contract)', () => {
  it('respects top_k=3 (caps results to 3, not the old default)', async () => {
    const res = await handleSemanticSearch({ query: 'match', top_k: 3 }, fakeClient(25));
    assert.ok(!res.isError, 'should not error');
    assert.ok(
      countFromResult(res).includes('Found 3 result(s)'),
      `expected 3 results, got:\n${countFromResult(res)}`,
    );
  });

  it('defaults to 10 (the schema-documented default), not 20', async () => {
    const res = await handleSemanticSearch({ query: 'match' }, fakeClient(25));
    assert.ok(
      countFromResult(res).includes('Found 10 result(s)'),
      `expected default 10, got:\n${countFromResult(res)}`,
    );
  });

  it('ignores the old `limit` arg — `top_k` is the contract', async () => {
    // Passing `limit` (no longer a recognized param) must NOT override; default 10 applies.
    const res = await handleSemanticSearch({ query: 'match', limit: 5 } as any, fakeClient(25));
    assert.ok(
      countFromResult(res).includes('Found 10 result(s)'),
      `expected default 10 (limit ignored), got:\n${countFromResult(res)}`,
    );
  });

  it('does not fabricate a similarity score (substring search has no real similarity)', async () => {
    // The handler does substring matching (no embeddings yet), so a bracketed decimal
    // like "[0.95]" would read to an agent as a real similarity metric that was never computed.
    const res = await handleSemanticSearch({ query: 'match', top_k: 3 }, fakeClient(5));
    const text = countFromResult(res);
    assert.ok(!/\[\d\.\d{2}\]/.test(text), `must not fabricate a similarity score, got:\n${text}`);
    // Results are still listed by name so the tool remains useful.
    assert.ok(text.includes('match1'), `should still list result names, got:\n${text}`);
  });

  it('schema is honest: drops unimplemented include_edges, description reflects substring (REG-1152)', () => {
    const tool = ENOX_TOOLS.find((t: any) => t.name === 'semantic_search') as any;
    assert.ok(tool, 'semantic_search tool exists');
    const props = tool.inputSchema.properties;
    // include_edges was advertised but never read by the handler — must not be advertised.
    assert.strictEqual(props.include_edges, undefined, 'include_edges must not be advertised');
    // The real params stay.
    assert.ok(props.query && props.top_k, 'query/top_k still advertised');
    // Description must not overpromise embedding-based semantic search (it does substring matching).
    assert.match(tool.description, /substring/i, 'description should reflect substring matching');
  });
});

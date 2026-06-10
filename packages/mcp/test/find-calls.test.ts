/**
 * Tests for the find_calls MCP tool (`findCallsLogic`).
 *
 * find_calls must surface ALL call-sites of a function:
 *   1. direct CALL nodes        — "foo()" / "obj.foo()"
 *   2. callback usages          — the function passed as an argument
 *                                 (caller → PASSES_ARGUMENT → REFERENCE "foo")
 *
 * Regression target: the callback pass used to be gated on
 * `totalMatched === 0 || calls.length < limit`, so when direct CALL matches
 * alone filled the requested page, callback usages were neither counted (wrong
 * total → wrong `hasMore`) nor reachable via pagination — they silently
 * vanished. These tests pin the corrected behavior: callbacks always count
 * toward the total and stay reachable, regardless of how many direct calls
 * there are.
 *
 * TDD: the "accurate total" assertions FAIL before the fix (total reported as
 * the direct-call count only).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { MockBackend } from './helpers/MockBackend.js';
import { findCallsLogic } from '../src/handlers/query-handlers.js';

type Edge = { src: string; dst: string; type: string };

/**
 * MockBackend extended with an edge store + overrides, so find_calls can walk
 * CALLS (direct) and PASSES_ARGUMENT (callback) edges. Mirrors the
 * FindGuardsMockBackend pattern in mcp.test.ts.
 */
class FindCallsMockBackend extends MockBackend {
  private localEdges: Edge[] = [];

  async addEdge(edge: Edge): Promise<void> {
    this.localEdges.push(edge);
  }

  override async getIncomingEdges(id: string, types?: string[]): Promise<Edge[]> {
    return this.localEdges.filter(e => e.dst === id && (!types || types.includes(e.type)));
  }

  override async getOutgoingEdges(id: string, types?: string[]): Promise<Edge[]> {
    return this.localEdges.filter(e => e.src === id && (!types || types.includes(e.type)));
  }
}

function resultText(res: { content: Array<{ text?: string }> }): string {
  return res.content[0]?.text ?? '';
}

describe('find_calls callback accounting', () => {
  let backend: FindCallsMockBackend;

  beforeEach(() => {
    backend = new FindCallsMockBackend();
  });

  /** Add `count` direct CALL nodes named `name`. */
  async function addDirectCalls(name: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await backend.addNode({
        id: `CALL:caller.ts:${i}->${name}`,
        type: 'CALL',
        name,
        file: 'caller.ts',
        line: i + 1,
      });
    }
  }

  /**
   * Add a callback usage of `name`: a REFERENCE node passed as an argument from
   * a FUNCTION caller (caller -[PASSES_ARGUMENT]-> REFERENCE).
   */
  async function addCallbackUsage(name: string, callerName: string): Promise<void> {
    const refId = `REFERENCE:reg.ts:1->${name}`;
    const callerId = `FUNCTION:reg.ts:1->${callerName}`;
    await backend.addNode({ id: refId, type: 'REFERENCE', name, file: 'reg.ts', line: 1 });
    await backend.addNode({ id: callerId, type: 'FUNCTION', name: callerName, file: 'reg.ts', line: 1 });
    await backend.addEdge({ src: callerId, dst: refId, type: 'PASSES_ARGUMENT' });
  }

  it('counts the callback usage toward the total even when direct calls fill the page', async () => {
    // 2 direct calls + 1 callback; request a page of exactly 2 so direct calls
    // alone fill it. The total MUST still be 3 (the callback is a real
    // call-site) — before the fix it was reported as 2 and the callback was
    // hidden with no way to paginate to it (hasMore=false).
    await addDirectCalls('foo', 2);
    await addCallbackUsage('foo', 'register');

    const res = await findCallsLogic(backend, { name: 'foo', limit: 2 });
    const text = resultText(res);

    assert.match(text, /Found 3 call\(s\)/, `expected total of 3, got:\n${text}`);
    // hasMore must be advertised so an agent knows to paginate for the callback.
    assert.match(text, /offset=2/, `expected pagination hint to reach the callback, got:\n${text}`);
  });

  it('returns the hidden callback usage when paginating past the direct calls', async () => {
    await addDirectCalls('foo', 2);
    await addCallbackUsage('foo', 'register');

    const res = await findCallsLogic(backend, { name: 'foo', limit: 2, offset: 2 });
    const text = resultText(res);

    assert.match(text, /Found 3 call\(s\)/, `expected total of 3, got:\n${text}`);
    // The synthetic callback entry name is `<caller>(<fn>)`.
    assert.match(text, /register\(foo\)/, `expected callback usage on page 2, got:\n${text}`);
  });

  it('still surfaces callbacks on page 1 when direct calls do not fill the page (no regression)', async () => {
    await addDirectCalls('foo', 1);
    await addCallbackUsage('foo', 'register');

    const res = await findCallsLogic(backend, { name: 'foo', limit: 10 });
    const text = resultText(res);

    assert.match(text, /Found 2 call\(s\)/, `expected total of 2, got:\n${text}`);
    assert.match(text, /register\(foo\)/, `expected callback usage in results, got:\n${text}`);
  });

  it('reports an accurate total when there are only direct calls (no spurious callbacks)', async () => {
    await addDirectCalls('foo', 2);

    const res = await findCallsLogic(backend, { name: 'foo', limit: 10 });
    const text = resultText(res);

    assert.match(text, /Found 2 call\(s\)/, `expected total of 2, got:\n${text}`);
    assert.doesNotMatch(text, /register\(foo\)/);
  });
});

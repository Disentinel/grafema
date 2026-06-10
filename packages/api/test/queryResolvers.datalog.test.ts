/**
 * Query Resolver — datalog pagination tests
 *
 * The `datalog` resolver slices its result set with a client-supplied
 * `limit`/`offset`. Without a lower-bound clamp, a negative `limit` reaches
 * `results.slice(offset, offset + limit)`, where JS interprets the negative
 * end index as an offset from the end and returns almost the whole result set
 * instead of an empty page — the same class of bug as `paginateArray`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { queryResolvers } from '../src/resolvers/query.js';
import type { GraphQLContext } from '../src/context.js';

interface DatalogReturn {
  success: boolean;
  count: number;
  results: unknown[];
  error: string | null;
}

/**
 * Build a minimal mock GraphQLContext whose `checkGuarantee` returns `count`
 * binding-less result rows and whose node loader resolves to null. Only the
 * surface the datalog resolver touches is implemented.
 */
function mockContext(count: number): GraphQLContext {
  const rows = Array.from({ length: count }, () => ({ bindings: [] as { name: string; value: unknown }[] }));
  return {
    backend: {
      checkGuarantee: async () => rows,
    },
    loaders: {
      node: { load: async () => null },
    },
  } as unknown as GraphQLContext;
}

describe('queryResolvers.datalog pagination', () => {
  it('returns an empty page for a negative limit (no slice underflow)', async () => {
    const ctx = mockContext(5);
    const result = (await queryResolvers.datalog(
      {},
      { query: 'q(X)', limit: -1, offset: 0 },
      ctx
    )) as DatalogReturn;

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.count, 5); // total reported faithfully
    assert.strictEqual(result.results.length, 0); // but no rows leaked
  });

  it('returns an empty page for a negative offset', async () => {
    const ctx = mockContext(5);
    const result = (await queryResolvers.datalog(
      {},
      { query: 'q(X)', limit: 10, offset: -3 },
      ctx
    )) as DatalogReturn;

    // A negative offset must not wrap around to the tail of the result set.
    assert.strictEqual(result.results.length, 5);
  });

  it('still paginates normally for valid limit/offset', async () => {
    const ctx = mockContext(10);
    const result = (await queryResolvers.datalog(
      {},
      { query: 'q(X)', limit: 3, offset: 2 },
      ctx
    )) as DatalogReturn;

    assert.strictEqual(result.count, 10);
    assert.strictEqual(result.results.length, 3);
  });
});

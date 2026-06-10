/**
 * REG-658 — get_documentation(topic="queries") must list the Datalog predicates
 * the engine actually implements, not just node/edge/attr/negation.
 *
 * Source of truth: the builtin dispatch in
 * packages/rfdb-server/src/datalog/eval.rs (eval_atom match arm).
 * Each predicate below was verified to execute via a live query_graph at authoring.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { handleGetDocumentation } from '../dist/handlers/documentation-handlers.js';

async function queriesDoc(): Promise<string> {
  const res = await handleGetDocumentation({ topic: 'queries' });
  return res.content.map((c: { text?: string }) => c.text ?? '').join('\n');
}

describe('get_documentation("queries") — REG-658', () => {
  it('documents every builtin Datalog predicate from eval.rs', async () => {
    const doc = await queriesDoc();
    for (const pred of [
      'node(', 'edge(', 'incoming(', 'path(', 'attr(', 'attr_edge(',
      'parent_function(', 'neq(', 'starts_with(', 'not_starts_with(',
      'string_contains(', 'gt(', 'lt(', 'gte(', 'lte(',
    ]) {
      assert.ok(doc.includes(pred), `queries doc should document predicate "${pred}"`);
    }
  });

  it('documents negation and known limitations', async () => {
    const doc = await queriesDoc();
    assert.match(doc, /negation/i, 'should mention negation');
    assert.match(doc, /no aggregations|GROUP BY|ORDER BY/i, 'should state aggregation/ordering limits');
  });
});

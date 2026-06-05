/**
 * REG-279 — `ls` disambiguates duplicate node names.
 *
 * Backend-free: exercises the pure formatNodeList() helper directly, no
 * analyze/db needed → safe for the CI unit gate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatNodeList, type NodeInfo } from '../src/commands/ls.js';

const node = (over: Partial<NodeInfo>): NodeInfo => ({
  id: 'id', type: 'MODULE', name: '', file: '', ...over,
});

describe('formatNodeList — duplicate disambiguation (REG-279)', () => {
  it('appends the semantic id to entries whose display collides', () => {
    const nodes: NodeInfo[] = [
      node({ id: 'a.js->MODULE->app', name: 'app.js', file: 'app.js' }),
      node({ id: 'b.js->MODULE->app', name: 'app.js', file: 'app.js' }),
    ];
    const out = formatNodeList(nodes, 'MODULE', '/p');

    // Both collide → both carry their (distinct) id, so the two lines differ.
    assert.notStrictEqual(out[0], out[1], 'colliding entries must be distinguishable');
    assert.match(out[0], /\[a\.js->MODULE->app\]/);
    assert.match(out[1], /\[b\.js->MODULE->app\]/);
  });

  it('leaves unique entries untouched (no id noise)', () => {
    const nodes: NodeInfo[] = [
      node({ id: 'x->FUNCTION->foo', type: 'FUNCTION', name: 'foo', file: 'x.ts', line: 1 }),
      node({ id: 'y->FUNCTION->bar', type: 'FUNCTION', name: 'bar', file: 'y.ts', line: 2 }),
    ];
    const out = formatNodeList(nodes, 'FUNCTION', '/p');

    assert.doesNotMatch(out[0], /\[/, 'unique entry should not get an id suffix');
    assert.doesNotMatch(out[1], /\[/, 'unique entry should not get an id suffix');
    assert.match(out[0], /foo/);
  });
});

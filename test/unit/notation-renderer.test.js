/**
 * Tests for notation/renderer — pure rendering function
 *
 * Verifies:
 * - Correct DSL output for known node/edge structures
 * - LOD 0 (names only), LOD 1 (edges), LOD 2 (nested)
 * - Archetype grouping and sorting
 * - Target merging (same operator+verb)
 * - Budget enforcement
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { renderNotation } from '../../packages/util/dist/notation/index.js';

// Helper to build SubgraphData from simple descriptions
function makeSubgraph(rootNodes, edges, extraNodes = []) {
  const nodeMap = new Map();
  for (const n of [...rootNodes, ...extraNodes]) {
    nodeMap.set(n.id, n);
  }
  return { rootNodes, edges, nodeMap };
}

describe('renderNotation', () => {
  it('should render a simple function with calls', () => {
    const subgraph = makeSubgraph(
      [{ id: 'login', type: 'FUNCTION', name: 'login' }],
      [
        { src: 'login', dst: 'bcrypt', type: 'IMPORTS' },
        { src: 'login', dst: 'findUser', type: 'CALLS' },
        { src: 'login', dst: 'config', type: 'READS_FROM' },
      ],
      [
        { id: 'bcrypt', type: 'EXTERNAL', name: 'bcrypt' },
        { id: 'findUser', type: 'FUNCTION', name: 'findByEmail' },
        { id: 'config', type: 'VARIABLE', name: 'config.auth' },
      ],
    );

    const result = renderNotation(subgraph);

    assert.ok(result.includes('login {'), 'Should have login block');
    assert.ok(result.includes('o- imports bcrypt'), 'Should show imports');
    assert.ok(result.includes('> calls findByEmail'), 'Should show calls');
    assert.ok(result.includes('< reads config.auth'), 'Should show reads');
    assert.ok(result.includes('}'), 'Should close block');
  });

  it('should merge targets with same operator+verb', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'handler' }],
      [
        { src: 'fn', dst: 'a', type: 'CALLS' },
        { src: 'fn', dst: 'b', type: 'CALLS' },
        { src: 'fn', dst: 'c', type: 'CALLS' },
      ],
      [
        { id: 'a', type: 'FUNCTION', name: 'alpha' },
        { id: 'b', type: 'FUNCTION', name: 'beta' },
        { id: 'c', type: 'FUNCTION', name: 'gamma' },
      ],
    );

    const result = renderNotation(subgraph);

    assert.ok(
      result.includes('> calls alpha, beta, gamma'),
      `Should merge calls. Got:\n${result}`,
    );
  });

  it('should sort lines by archetype order (depends before flow_out before write)', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'process' }],
      [
        { src: 'fn', dst: 'db', type: 'WRITES_TO' },
        { src: 'fn', dst: 'lib', type: 'IMPORTS' },
        { src: 'fn', dst: 'other', type: 'CALLS' },
      ],
      [
        { id: 'db', type: 'VARIABLE', name: 'database' },
        { id: 'lib', type: 'EXTERNAL', name: 'lodash' },
        { id: 'other', type: 'FUNCTION', name: 'helper' },
      ],
    );

    const result = renderNotation(subgraph);
    const lines = result.split('\n').filter(l => l.trim().length > 0);

    // Find indices of each line type
    const importsIdx = lines.findIndex(l => l.includes('o- imports'));
    const callsIdx = lines.findIndex(l => l.includes('> calls'));
    const writesIdx = lines.findIndex(l => l.includes('=> writes'));

    assert.ok(importsIdx >= 0, 'Should have imports line');
    assert.ok(callsIdx >= 0, 'Should have calls line');
    assert.ok(writesIdx >= 0, 'Should have writes line');
    assert.ok(importsIdx < callsIdx, 'imports (depends) should come before calls (flow_out)');
    assert.ok(callsIdx < writesIdx, 'calls (flow_out) should come before writes (write)');
  });

  it('should render LOD 0 as names only (no edges)', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'handler' }],
      [
        { src: 'fn', dst: 'other', type: 'CALLS' },
      ],
      [
        { id: 'other', type: 'FUNCTION', name: 'other' },
      ],
    );

    const result = renderNotation(subgraph, { depth: 0 });

    assert.ok(result.includes('handler'), 'Should show name');
    assert.ok(!result.includes('>'), 'Should not show edge operators');
    assert.ok(!result.includes('{'), 'Should not have block braces');
  });

  it('should apply archetype filter', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'handler' }],
      [
        { src: 'fn', dst: 'a', type: 'CALLS' },
        { src: 'fn', dst: 'b', type: 'WRITES_TO' },
        { src: 'fn', dst: 'c', type: 'THROWS' },
      ],
      [
        { id: 'a', type: 'FUNCTION', name: 'foo' },
        { id: 'b', type: 'VARIABLE', name: 'db' },
        { id: 'c', type: 'CLASS', name: 'Err' },
      ],
    );

    const result = renderNotation(subgraph, { archetypeFilter: ['exception'] });

    assert.ok(result.includes('>x throws Err'), 'Should show exception');
    assert.ok(!result.includes('> calls'), 'Should not show calls');
    assert.ok(!result.includes('=> writes'), 'Should not show writes');
  });

  it('should enforce budget with ...+N more', () => {
    // Create more line groups than default budget (7)
    const edges = [];
    const extraNodes = [];
    const types = [
      'IMPORTS', 'CALLS', 'READS_FROM', 'WRITES_TO',
      'THROWS', 'EMITS_EVENT', 'HAS_CONDITION', 'GOVERNS',
      'DELEGATES_TO',
    ];

    for (let i = 0; i < types.length; i++) {
      edges.push({ src: 'fn', dst: `t${i}`, type: types[i] });
      extraNodes.push({ id: `t${i}`, type: 'VARIABLE', name: `target${i}` });
    }

    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'bigFn' }],
      edges,
      extraNodes,
    );

    const result = renderNotation(subgraph, { budget: 5 });

    assert.ok(result.includes('...+'), `Should have budget overflow indicator. Got:\n${result}`);
  });

  it('should handle containment edges as nesting in LOD 2', () => {
    const subgraph = makeSubgraph(
      [{ id: 'mod', type: 'MODULE', name: 'auth.ts' }],
      [
        { src: 'mod', dst: 'fn1', type: 'CONTAINS' },
        { src: 'mod', dst: 'fn2', type: 'CONTAINS' },
        { src: 'fn1', dst: 'ext', type: 'CALLS' },
      ],
      [
        { id: 'fn1', type: 'FUNCTION', name: 'login' },
        { id: 'fn2', type: 'FUNCTION', name: 'logout' },
        { id: 'ext', type: 'FUNCTION', name: 'validate' },
      ],
    );

    const result = renderNotation(subgraph, { depth: 2 });

    assert.ok(result.includes('auth.ts'), 'Should show module name');
    assert.ok(result.includes('login'), 'Should show child login');
    assert.ok(result.includes('logout'), 'Should show child logout');
    assert.ok(result.includes('> calls validate'), 'Should show call from login');
  });

  it('should render empty notation for node with no edges', () => {
    const subgraph = makeSubgraph(
      [{ id: 'lonely', type: 'FUNCTION', name: 'lonely' }],
      [],
    );

    const result = renderNotation(subgraph);
    assert.ok(result.includes('lonely'), 'Should show name');
    assert.ok(!result.includes('{'), 'Should not have block (no content)');
  });

  it('should show all 7 archetype operators when present', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'allOps' }],
      [
        { src: 'fn', dst: 'a', type: 'IMPORTS' },
        { src: 'fn', dst: 'b', type: 'CALLS' },
        { src: 'fn', dst: 'c', type: 'READS_FROM' },
        { src: 'fn', dst: 'd', type: 'WRITES_TO' },
        { src: 'fn', dst: 'e', type: 'THROWS' },
        { src: 'fn', dst: 'f', type: 'EMITS_EVENT' },
        { src: 'fn', dst: 'g', type: 'GOVERNS' },
      ],
      [
        { id: 'a', type: 'EXTERNAL', name: 'lib' },
        { id: 'b', type: 'FUNCTION', name: 'helper' },
        { id: 'c', type: 'VARIABLE', name: 'config' },
        { id: 'd', type: 'VARIABLE', name: 'db' },
        { id: 'e', type: 'CLASS', name: 'AppError' },
        { id: 'f', type: 'LITERAL', name: "'update'" },
        { id: 'g', type: 'VARIABLE', name: 'rule1' },
      ],
    );

    const result = renderNotation(subgraph);

    assert.ok(result.includes('o-'), 'Should have depends operator');
    assert.ok(result.includes('> '), 'Should have flow_out operator');
    assert.ok(result.includes('< '), 'Should have flow_in operator');
    assert.ok(result.includes('=>'), 'Should have write operator');
    assert.ok(result.includes('>x'), 'Should have exception operator');
    assert.ok(result.includes('~>>'), 'Should have publishes operator');
    assert.ok(result.includes('|='), 'Should have governs operator');
  });

  it('should add [] modifier for edges inside loops', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'process' }],
      [
        { src: 'fn', dst: 'loop1', type: 'CONTAINS' },
        { src: 'loop1', dst: 'call1', type: 'CONTAINS' },
        { src: 'call1', dst: 'target', type: 'CALLS' },
      ],
      [
        { id: 'loop1', type: 'LOOP', name: 'for' },
        { id: 'call1', type: 'CALL', name: 'emit' },
        { id: 'target', type: 'FUNCTION', name: 'send' },
      ],
    );
    // depth=4: fn(d=4)→loop1(d=3)→call1(d=2, shows edges). call1 is inside loop → gets []
    const result = renderNotation(subgraph, { depth: 4 });
    assert.ok(result.includes('[]'), `Should have loop modifier. Got:\n${result}`);
    assert.ok(result.includes('[] > calls send'), `Should prefix calls line with []. Got:\n${result}`);
  });

  it('should not add [] modifier for edges outside loops', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'process' }],
      [
        { src: 'fn', dst: 'call1', type: 'CONTAINS' },
        { src: 'call1', dst: 'target', type: 'CALLS' },
      ],
      [
        { id: 'call1', type: 'CALL', name: 'emit' },
        { id: 'target', type: 'FUNCTION', name: 'send' },
      ],
    );
    const result = renderNotation(subgraph, { depth: 2 });
    assert.ok(!result.includes('[]'), `Should NOT have loop modifier. Got:\n${result}`);
    assert.ok(result.includes('> calls send'), `Should have calls without modifier. Got:\n${result}`);
  });

  it('should add [] modifier for deeply nested loop descendants', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'process' }],
      [
        { src: 'fn', dst: 'loop1', type: 'CONTAINS' },
        { src: 'loop1', dst: 'ifBlock', type: 'CONTAINS' },
        { src: 'ifBlock', dst: 'call1', type: 'CONTAINS' },
        { src: 'call1', dst: 'target', type: 'CALLS' },
      ],
      [
        { id: 'loop1', type: 'LOOP', name: 'for' },
        { id: 'ifBlock', type: 'CONDITION', name: 'if' },
        { id: 'call1', type: 'CALL', name: 'emit' },
        { id: 'target', type: 'FUNCTION', name: 'send' },
      ],
    );
    // depth=5: fn(d=5)→loop1(d=4)→if(d=3)→call1(d=2, shows edges). call1 is loop descendant → gets []
    const result = renderNotation(subgraph, { depth: 5 });
    assert.ok(result.includes('[] > calls send'), `Should prefix deeply nested calls with []. Got:\n${result}`);
  });

  it('should add ?? modifier for unresolved edges', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'handler' }],
      [
        { src: 'fn', dst: 'unknown', type: 'CALLS', metadata: { resolved: false } },
        { src: 'fn', dst: 'known', type: 'CALLS', metadata: { resolved: true } },
      ],
      [
        { id: 'unknown', type: 'FUNCTION', name: 'dynamicCall' },
        { id: 'known', type: 'FUNCTION', name: 'staticCall' },
      ],
    );
    const result = renderNotation(subgraph);
    assert.ok(result.includes('??'), `Should have dynamic modifier for unresolved edge. Got:\n${result}`);
    assert.ok(result.includes('?? > calls dynamicCall'), `Should prefix unresolved call with ??. Got:\n${result}`);
    assert.ok(result.includes('> calls staticCall'), `Should have resolved call without ??. Got:\n${result}`);
    // Unresolved and resolved should NOT be merged into one line
    assert.ok(!result.includes('dynamicCall, staticCall'), 'Should not merge uncertain with certain targets');
    assert.ok(!result.includes('staticCall, dynamicCall'), 'Should not merge certain with uncertain targets');
  });

  it('should add ?? modifier for low-confidence edges', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'handler' }],
      [
        { src: 'fn', dst: 'a', type: 'CALLS', metadata: { confidence: 0.5 } },
        { src: 'fn', dst: 'b', type: 'CALLS', metadata: { confidence: 1.0 } },
      ],
      [
        { id: 'a', type: 'FUNCTION', name: 'maybe' },
        { id: 'b', type: 'FUNCTION', name: 'definitely' },
      ],
    );
    const result = renderNotation(subgraph);
    assert.ok(result.includes('?? > calls maybe'), `Low-confidence edge should get ??. Got:\n${result}`);
    assert.ok(!result.includes('?? > calls definitely'), `Full-confidence edge should NOT get ??. Got:\n${result}`);
  });

  it('should add ?? modifier for dynamic dispatch edges', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'handler' }],
      [
        { src: 'fn', dst: 'a', type: 'CALLS', metadata: { dynamic: true } },
      ],
      [
        { id: 'a', type: 'FUNCTION', name: 'computed' },
      ],
    );
    const result = renderNotation(subgraph);
    assert.ok(result.includes('?? > calls computed'), `Dynamic edge should get ??. Got:\n${result}`);
  });

  it('should combine [] and ?? modifiers when both apply', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'process' }],
      [
        { src: 'fn', dst: 'loop1', type: 'CONTAINS' },
        { src: 'loop1', dst: 'call1', type: 'CONTAINS' },
        { src: 'call1', dst: 'target', type: 'CALLS', metadata: { resolved: false } },
      ],
      [
        { id: 'loop1', type: 'LOOP', name: 'for' },
        { id: 'call1', type: 'CALL', name: 'emit' },
        { id: 'target', type: 'FUNCTION', name: 'send' },
      ],
    );
    // depth=4: fn(d=4)→loop1(d=3)→call1(d=2, shows edges). call1 inside loop + unresolved → [] ??
    const result = renderNotation(subgraph, { depth: 4 });
    assert.ok(
      result.includes('[] ?? > calls send'),
      `Should combine loop and dynamic modifiers. Got:\n${result}`,
    );
  });

  it('should not add ?? modifier for edges without uncertainty metadata', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'handler' }],
      [
        { src: 'fn', dst: 'a', type: 'CALLS' },
        { src: 'fn', dst: 'b', type: 'CALLS', metadata: { someOtherField: 'value' } },
      ],
      [
        { id: 'a', type: 'FUNCTION', name: 'alpha' },
        { id: 'b', type: 'FUNCTION', name: 'beta' },
      ],
    );
    const result = renderNotation(subgraph);
    assert.ok(!result.includes('??'), `Should NOT have ?? for edges without uncertainty metadata. Got:\n${result}`);
  });

  it('should include locations when requested', () => {
    const subgraph = makeSubgraph(
      [{ id: 'fn', type: 'FUNCTION', name: 'handler', file: 'src/handler.ts', line: 42 }],
      [{ src: 'fn', dst: 'a', type: 'CALLS' }],
      [{ id: 'a', type: 'FUNCTION', name: 'foo' }],
    );

    const result = renderNotation(subgraph, { includeLocations: true });
    assert.ok(result.includes('src/handler.ts:42'), 'Should show location');
  });
});

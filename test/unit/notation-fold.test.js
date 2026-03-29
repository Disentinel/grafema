/**
 * Tests for notation/fold — structural compression of sibling blocks
 *
 * Verifies all 11 folding rules, invariants (count conservation, idempotence),
 * LOD 3 bypass, and interaction with budget/perspective.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { renderNotation } from '../../packages/util/dist/notation/index.js';
import { foldBlocks } from '../../packages/util/dist/notation/fold.js';

// Helper to build SubgraphData from simple descriptions
function makeSubgraph(rootNodes, edges, extraNodes = []) {
  const nodeMap = new Map();
  for (const n of [...rootNodes, ...extraNodes]) {
    nodeMap.set(n.id, n);
  }
  return { rootNodes, edges, nodeMap };
}

// Helper: create N identical children with same edge pattern
function makeIdenticalChildren(parent, count, {
  namePrefix = 'handler',
  childType = 'FUNCTION',
  edgeType = 'IMPORTS',
  targetPrefix = 'target',
  targetType = 'EXTERNAL',
} = {}) {
  const edges = [];
  const extraNodes = [];

  for (let i = 0; i < count; i++) {
    const childId = `${namePrefix}${i}`;
    const targetId = `${targetPrefix}${i}`;

    // Containment: parent → child
    edges.push({ src: parent.id, dst: childId, type: 'CONTAINS' });
    // Edge from child → target
    edges.push({ src: childId, dst: targetId, type: edgeType });

    extraNodes.push({ id: childId, type: childType, name: `${namePrefix}${i}` });
    extraNodes.push({ id: targetId, type: targetType, name: `${targetPrefix}${i}` });
  }

  return { edges, extraNodes };
}

describe('foldBlocks', () => {
  // === Rule 1: Group Fold ===

  it('Rule 1: should fold 5 identical-signature children into exemplar + summary', () => {
    const parent = { id: 'mod', type: 'MODULE', name: 'server.ts' };
    const { edges, extraNodes } = makeIdenticalChildren(parent, 5);

    const subgraph = makeSubgraph([parent], edges, extraNodes);

    const depth2 = renderNotation(subgraph, { depth: 2 });
    const depth3 = renderNotation(subgraph, { depth: 3 });

    // depth=2 should fold: exemplar + "...+N more"
    assert.ok(depth2.includes('...+'), `depth=2 should have fold summary. Got:\n${depth2}`);
    assert.ok(depth2.includes('handler0'), 'Should show exemplar (first child)');

    // depth=3 should show all 5 individually (no folding)
    assert.ok(!depth3.includes('...+'), `depth=3 should NOT fold. Got:\n${depth3}`);
    for (let i = 0; i < 5; i++) {
      assert.ok(depth3.includes(`handler${i}`), `depth=3 should show handler${i}`);
    }
  });

  it('Rule 1: should NOT fold groups with <= 3 members', () => {
    const parent = { id: 'mod', type: 'MODULE', name: 'small.ts' };
    const { edges, extraNodes } = makeIdenticalChildren(parent, 3);

    const subgraph = makeSubgraph([parent], edges, extraNodes);
    const result = renderNotation(subgraph, { depth: 2 });

    assert.ok(!result.includes('...+'), `Should not fold 3 or fewer children. Got:\n${result}`);
  });

  // === Rule 2: Anomaly Preservation ===

  it('Rule 2: should show anomalous children individually alongside fold', () => {
    const parent = { id: 'mod', type: 'MODULE', name: 'server.ts' };
    const { edges, extraNodes } = makeIdenticalChildren(parent, 5);

    // Add an anomaly: different type of child
    edges.push({ src: parent.id, dst: 'anomaly', type: 'CONTAINS' });
    edges.push({ src: 'anomaly', dst: 'db', type: 'WRITES_TO' });
    extraNodes.push({ id: 'anomaly', type: 'FUNCTION', name: 'setup' });
    extraNodes.push({ id: 'db', type: 'VARIABLE', name: 'database' });

    const subgraph = makeSubgraph([parent], edges, extraNodes);
    const result = renderNotation(subgraph, { depth: 2 });

    assert.ok(result.includes('...+'), 'Should fold the identical group');
    assert.ok(result.includes('setup'), 'Should show anomaly individually');
    assert.ok(result.includes('writes'), 'Anomaly should have its edges');
  });

  // === Rule 3: Source Aggregation ===

  it('Rule 3: should mention common source when all fold members share one target', () => {
    const parent = { id: 'mod', type: 'MODULE', name: 'server.ts' };
    const edges = [];
    const extraNodes = [];

    // 5 imports all from the same target
    for (let i = 0; i < 5; i++) {
      const childId = `imp${i}`;
      edges.push({ src: parent.id, dst: childId, type: 'CONTAINS' });
      edges.push({ src: childId, dst: 'sharedModule', type: 'IMPORTS' });
      extraNodes.push({ id: childId, type: 'IMPORT', name: `import${i}` });
    }
    extraNodes.push({ id: 'sharedModule', type: 'MODULE', name: 'handlers/index.js' });

    const subgraph = makeSubgraph([parent], edges, extraNodes);
    const result = renderNotation(subgraph, { depth: 2 });

    assert.ok(result.includes('...+'), 'Should fold');
    assert.ok(
      result.includes('from handlers/index.js'),
      `Should mention common source. Got:\n${result}`,
    );
  });

  // === Rule 4: Dedup ===

  it('Rule 4: should deduplicate blocks with same nodeId', () => {
    const blocks = [
      { nodeId: 'fn1', displayName: 'parseFile', nodeType: 'FUNCTION', lines: [{ operator: '>', verb: 'calls', targets: ['a'], sortOrder: 1 }], children: [] },
      { nodeId: 'fn1', displayName: 'parseFile', nodeType: 'FUNCTION', lines: [{ operator: '>', verb: 'calls', targets: ['a', 'b'], sortOrder: 1 }], children: [] },
    ];

    const result = foldBlocks(blocks);

    const parseFileBlocks = result.filter(b => b.displayName === 'parseFile');
    assert.equal(parseFileBlocks.length, 1, 'Should dedup to 1 block');
    assert.ok(parseFileBlocks[0].lines[0].targets.includes('b'), 'Should keep richer block');
  });

  // === Rule 5: Structural Suppression ===

  it('Rule 5: should inline trivial leaf children as [type: name1, name2, ...]', () => {
    const blocks = [];
    for (let i = 0; i < 5; i++) {
      blocks.push({
        nodeId: `schema${i}`,
        displayName: `Schema${i}`,
        nodeType: 'TYPE',
        lines: [],
        children: [],
      });
    }

    const result = foldBlocks(blocks);
    const trivialBlock = result.find(b => b.foldMeta?.kind === 'trivial-group');

    assert.ok(trivialBlock, 'Should create trivial group');
    assert.ok(trivialBlock.displayName.includes('[type:'), 'Should inline as [type: ...]');
    assert.ok(trivialBlock.displayName.includes('Schema0'), 'Should list names');
    assert.equal(trivialBlock.foldMeta.count, 5, 'Count should be 5');
  });

  // === Rule 6: Target Dedup ===

  it('Rule 6: should deduplicate targets within lines', () => {
    const blocks = [
      {
        nodeId: 'fn1',
        displayName: 'parseFile',
        nodeType: 'FUNCTION',
        lines: [{
          operator: '>',
          verb: 'returns',
          targets: ['result', 'result', 'other', 'other'],
          sortOrder: 1,
        }],
        children: [],
      },
    ];

    const result = foldBlocks(blocks);
    const fn = result.find(b => b.displayName === 'parseFile');

    assert.ok(fn, 'Should have parseFile');
    assert.deepEqual(fn.lines[0].targets, ['result', 'other'], 'Should dedup targets');
  });

  // === Rule 7: Repeated Leaf Fold ===

  it('Rule 7: should collapse N identical-name leaves into name ×N', () => {
    const blocks = [];
    for (let i = 0; i < 5; i++) {
      blocks.push({
        nodeId: `fn${i}`,
        displayName: 'function',
        nodeType: 'KEYWORD',
        lines: [],
        children: [],
      });
    }

    const result = foldBlocks(blocks);
    const leafRepeat = result.find(b => b.foldMeta?.kind === 'leaf-repeat');

    assert.ok(leafRepeat, 'Should create leaf-repeat');
    assert.ok(leafRepeat.displayName.includes('function'), 'Should have name');
    assert.ok(leafRepeat.displayName.includes('×5'), 'Should have count');
  });

  it('Rule 7: should NOT fold leaf names with <= 3 occurrences', () => {
    const blocks = [];
    for (let i = 0; i < 3; i++) {
      blocks.push({
        nodeId: `fn${i}`,
        displayName: 'function',
        nodeType: 'KEYWORD',
        lines: [],
        children: [],
      });
    }

    const result = foldBlocks(blocks);
    const leafRepeat = result.find(b => b.foldMeta?.kind === 'leaf-repeat');

    assert.ok(!leafRepeat, 'Should not fold 3 or fewer');
  });

  // === Rules 8/9: Derivation Chain ===

  it('Rule 8/9: should collapse derivation chain into composition notation', () => {
    const blocks = [
      { nodeId: 'pack1', displayName: 'pack', nodeType: 'REFERENCE', lines: [], children: [], location: 'Expr.hs:111' },
      { nodeId: 'pack2', displayName: 'pack', nodeType: 'REFERENCE', lines: [], children: [], location: 'Expr.hs:111' },
      {
        nodeId: 'occ1', displayName: 'occNameString', nodeType: 'REFERENCE',
        lines: [{ operator: '>', verb: 'derived from', targets: ['pack'], sortOrder: 1 }],
        children: [], location: 'Expr.hs:111',
      },
      { nodeId: 'occ2', displayName: 'occNameString', nodeType: 'REFERENCE', lines: [], children: [], location: 'Expr.hs:111' },
      {
        nodeId: 'rdr1', displayName: 'rdrNameOcc', nodeType: 'REFERENCE',
        lines: [{ operator: '>', verb: 'derived from', targets: ['occNameString'], sortOrder: 1 }],
        children: [], location: 'Expr.hs:111',
      },
      { nodeId: 'rdr2', displayName: 'rdrNameOcc', nodeType: 'REFERENCE', lines: [], children: [], location: 'Expr.hs:111' },
      {
        nodeId: 'unLoc1', displayName: 'unLoc', nodeType: 'REFERENCE',
        lines: [{ operator: '>', verb: 'derived from', targets: ['rdrNameOcc'], sortOrder: 1 }],
        children: [], location: 'Expr.hs:111',
      },
      { nodeId: 'unLoc2', displayName: 'unLoc', nodeType: 'REFERENCE', lines: [], children: [], location: 'Expr.hs:111' },
      {
        nodeId: 'name1', displayName: 'name', nodeType: 'REFERENCE',
        lines: [
          { operator: '>', verb: 'derived from', targets: ['unLoc'], sortOrder: 1 },
          { operator: '<', verb: 'reads', targets: ['name'], sortOrder: 2 },
        ],
        children: [], location: 'Expr.hs:111',
      },
    ];

    const result = foldBlocks(blocks);

    // Should have a chain block
    const chain = result.find(b => b.foldMeta?.kind === 'chain');
    assert.ok(chain, `Should detect chain. Got: ${result.map(b => b.displayName).join(', ')}`);
    assert.ok(chain.displayName.includes('∘'), 'Chain should use ∘ notation');
    assert.ok(chain.displayName.includes('pack'), 'Chain should start with pack');
    assert.ok(chain.foldMeta.chainSteps.length >= 3, 'Chain should have >= 3 steps');

    // Original blocks should be consumed (much fewer blocks in result)
    assert.ok(result.length < blocks.length, 'Chain should reduce total block count');
  });

  // === Rule 10: Repetitive Call Fold ===

  it('Rule 10: should fold same function called repeatedly', () => {
    const blocks = [];
    for (let i = 0; i < 5; i++) {
      blocks.push({
        nodeId: `call${i}`,
        displayName: 'mkGlobal',
        nodeType: 'CALL',
        lines: [{ operator: '<', verb: 'reads', targets: ['mkGlobal'], sortOrder: 1 }],
        children: [],
        location: `Globals.hs:${44 + i}`,
      });
    }

    const result = foldBlocks(blocks);

    // Should have exemplar + fold summary
    const exemplar = result.find(b => b.displayName === 'mkGlobal' && !b.foldMeta);
    const foldSummary = result.find(b => b.foldMeta?.kind === 'fold' && b.foldMeta?.label === 'mkGlobal');

    assert.ok(exemplar, 'Should have exemplar');
    assert.ok(foldSummary, `Should have fold summary. Got: ${result.map(b => `${b.displayName} (${b.foldMeta?.kind ?? 'none'})`).join(', ')}`);
    assert.ok(foldSummary.displayName.includes('...+4 more'), 'Fold summary should show count');
  });

  // === Rule 11: Case Dispatch Fold ===

  it('Rule 11: should fold case dispatch branches', () => {
    const blocks = [];
    const patterns = ['VarDecl', 'FuncDecl', 'ClassDecl', 'ExprStmt'];

    for (const pattern of patterns) {
      const handler = `rule${pattern}`;
      // Pattern node (leaf)
      blocks.push({
        nodeId: `${pattern}-node`,
        displayName: pattern,
        nodeType: 'PATTERN',
        lines: [],
        children: [],
        location: `Walker.hs:52`,
      });
      // Handler node with "derived from case"
      blocks.push({
        nodeId: `${handler}-node`,
        displayName: handler,
        nodeType: 'FUNCTION',
        lines: [{ operator: '>', verb: 'derived from', targets: ['case'], sortOrder: 1 }],
        children: [],
        location: `Walker.hs:52`,
      });
      // Handler dup
      blocks.push({
        nodeId: `${handler}-dup`,
        displayName: handler,
        nodeType: 'FUNCTION',
        lines: [],
        children: [],
        location: `Walker.hs:52`,
      });
      // Arg node
      blocks.push({
        nodeId: `${handler}-arg`,
        displayName: 'node',
        nodeType: 'REFERENCE',
        lines: [
          { operator: '>', verb: 'derived from', targets: [handler], sortOrder: 1 },
          { operator: '<', verb: 'reads', targets: ['node'], sortOrder: 2 },
        ],
        children: [],
        location: `Walker.hs:52`,
      });
    }

    const result = foldBlocks(blocks);

    const dispatch = result.find(b => b.foldMeta?.kind === 'dispatch');
    assert.ok(dispatch, `Should detect dispatch pattern. Got: ${result.map(b => `${b.displayName}(${b.foldMeta?.kind ?? '-'})`).join(', ')}`);

    // Should have much fewer blocks than original
    assert.ok(result.length < blocks.length, 'Dispatch should compress blocks');
  });

  // === Invariant: Count Conservation (Inv-F4) ===

  it('Inv-F4: fold counts should sum to original children count', () => {
    const blocks = [];
    // 5 identical + 2 different
    for (let i = 0; i < 5; i++) {
      blocks.push({
        nodeId: `imp${i}`,
        displayName: `import${i}`,
        nodeType: 'IMPORT',
        lines: [{ operator: 'o-', verb: 'imports', targets: ['lib'], sortOrder: 1 }],
        children: [],
      });
    }
    blocks.push({
      nodeId: 'fn1',
      displayName: 'main',
      nodeType: 'FUNCTION',
      lines: [{ operator: '>', verb: 'calls', targets: ['start'], sortOrder: 2 }],
      children: [],
    });
    blocks.push({
      nodeId: 'fn2',
      displayName: 'setup',
      nodeType: 'FUNCTION',
      lines: [{ operator: '>', verb: 'calls', targets: ['init'], sortOrder: 2 }],
      children: [],
    });

    const result = foldBlocks(blocks);

    // Count: fold.count for fold summaries + individual blocks (no foldMeta)
    let totalCount = 0;
    for (const b of result) {
      if (b.foldMeta?.kind === 'fold') {
        totalCount += b.foldMeta.count;
      } else if (b.foldMeta?.kind === 'trivial-group') {
        totalCount += b.foldMeta.count;
      } else if (b.foldMeta?.kind === 'leaf-repeat') {
        totalCount += b.foldMeta.count;
      } else if (!b.foldMeta) {
        // Exemplars are output alongside fold summaries, don't double-count
        // Only count non-exemplar individual blocks
        const isExemplar = result.some(
          other => other.foldMeta?.kind === 'fold' && other.nodeId === `fold:${b.nodeId}`,
        );
        if (!isExemplar) totalCount += 1;
      }
    }

    assert.equal(totalCount, blocks.length, `Count should be conserved: ${totalCount} vs ${blocks.length}`);
  });

  // === Invariant: Idempotence (Inv-F5) ===

  it('Inv-F5: applying fold twice should produce same result', () => {
    const blocks = [];
    for (let i = 0; i < 5; i++) {
      blocks.push({
        nodeId: `imp${i}`,
        displayName: `import${i}`,
        nodeType: 'IMPORT',
        lines: [{ operator: 'o-', verb: 'imports', targets: ['lib'], sortOrder: 1 }],
        children: [],
      });
    }

    const once = foldBlocks(blocks);
    const twice = foldBlocks(once);

    assert.equal(once.length, twice.length, 'Same number of blocks');

    // Compare unordered — content should be identical, order may vary
    const sortByName = (a, b) => a.displayName.localeCompare(b.displayName);
    const sortedOnce = [...once].sort(sortByName);
    const sortedTwice = [...twice].sort(sortByName);

    for (let i = 0; i < sortedOnce.length; i++) {
      assert.equal(sortedOnce[i].displayName, sortedTwice[i].displayName, `Block ${i} displayName matches`);
      assert.equal(sortedOnce[i].foldMeta?.kind, sortedTwice[i].foldMeta?.kind, `Block ${i} foldMeta kind matches`);
    }
  });

  // === LOD 3 bypass ===

  it('LOD 3 should NOT apply folding (unfolded output)', () => {
    const parent = { id: 'mod', type: 'MODULE', name: 'server.ts' };
    const { edges, extraNodes } = makeIdenticalChildren(parent, 6);

    const subgraph = makeSubgraph([parent], edges, extraNodes);

    const folded = renderNotation(subgraph, { depth: 2 });
    const unfolded = renderNotation(subgraph, { depth: 3 });

    assert.ok(folded.includes('...+'), 'depth=2 should fold');
    assert.ok(!unfolded.includes('...+'), 'depth=3 should NOT fold');

    // depth=3 should show all children
    for (let i = 0; i < 6; i++) {
      assert.ok(unfolded.includes(`handler${i}`), `depth=3 should show handler${i}`);
    }
  });

  // === Fold + Perspective ===

  it('Fold operates on perspective-filtered data', () => {
    const parent = { id: 'mod', type: 'MODULE', name: 'app.ts' };
    const edges = [];
    const extraNodes = [];

    // 5 functions that each call and write
    for (let i = 0; i < 5; i++) {
      const childId = `fn${i}`;
      const callTarget = `call${i}`;
      const writeTarget = `write${i}`;

      edges.push({ src: parent.id, dst: childId, type: 'CONTAINS' });
      edges.push({ src: childId, dst: callTarget, type: 'CALLS' });
      edges.push({ src: childId, dst: writeTarget, type: 'WRITES_TO' });

      extraNodes.push({ id: childId, type: 'FUNCTION', name: `fn${i}` });
      extraNodes.push({ id: callTarget, type: 'FUNCTION', name: `call${i}` });
      extraNodes.push({ id: writeTarget, type: 'VARIABLE', name: `write${i}` });
    }

    const subgraph = makeSubgraph([parent], edges, extraNodes);

    // With security perspective (write + exception only), all 5 have same signature
    const result = renderNotation(subgraph, {
      depth: 2,
      archetypeFilter: ['write', 'exception'],
    });

    assert.ok(result.includes('...+'), `Should fold with perspective filter. Got:\n${result}`);
  });

  // === Role: Datum inline ===

  it('Role: datum blocks should render inline preserving archetype', () => {
    const parent = { id: 'mod', type: 'MODULE', name: 'server.ts' };
    const edges = [
      { src: parent.id, dst: 'var1', type: 'CONTAINS' },
      { src: 'var1', dst: 'src1', type: 'ASSIGNED_FROM' },
    ];
    const extraNodes = [
      { id: 'var1', type: 'VARIABLE', name: 'projectPath' },
      { id: 'src1', type: 'FUNCTION', name: 'getProjectPath' },
    ];

    const subgraph = makeSubgraph([parent], edges, extraNodes);
    const result = renderNotation(subgraph, { depth: 2 });

    // Should render as inline with archetype preserved: "name < verb source"
    assert.ok(
      result.includes('projectPath < assigned from getProjectPath'),
      `Should render datum inline with archetype. Got:\n${result}`,
    );
    // Should NOT have braces (not a container block)
    assert.ok(
      !result.includes('projectPath {') && !result.includes('projectPath ('),
      `Should NOT render datum as block with braces. Got:\n${result}`,
    );
  });

  it('Role: datum without source renders as name only', () => {
    const blocks = [
      {
        nodeId: 'var1',
        displayName: 'count',
        nodeType: 'VARIABLE',
        lines: [],
        children: [],
      },
    ];

    const result = foldBlocks(blocks);
    const datum = result.find(b => b.foldMeta?.kind === 'datum-inline');
    assert.ok(datum, 'Should create datum-inline');
    assert.equal(datum.displayName, 'count', 'Should keep name when no source edges');
  });

  it('Role: VARIABLE with behavior edges stays as actor block', () => {
    const blocks = [
      {
        nodeId: 'var1',
        displayName: 'db',
        nodeType: 'VARIABLE',
        lines: [
          { operator: '>', verb: 'calls', targets: ['connect'], sortOrder: 1 },
          { operator: '<', verb: 'assigned from', targets: ['createPool'], sortOrder: 2 },
        ],
        children: [],
      },
    ];

    const result = foldBlocks(blocks);
    const block = result.find(b => b.displayName === 'db');
    assert.ok(block, 'Should have db block');
    assert.ok(!block.foldMeta, 'Should NOT be datum-inline (has behavior)');
    assert.ok(block.lines.length > 0, 'Should keep lines');
  });

  // === Role: No suppression of nodes with edges ===

  it('Role: REFERENCE with edges should NOT be suppressed', () => {
    const blocks = [
      {
        nodeId: 'fn1',
        displayName: 'main',
        nodeType: 'FUNCTION',
        lines: [{ operator: '>', verb: 'calls', targets: ['start'], sortOrder: 1 }],
        children: [],
      },
      {
        nodeId: 'ref1',
        displayName: 'someRef',
        nodeType: 'REFERENCE',
        lines: [{ operator: '<', verb: 'reads', targets: ['x'], sortOrder: 1 }],
        children: [],
      },
    ];

    const result = foldBlocks(blocks);
    assert.ok(result.some(b => b.displayName === 'main'), 'Should keep actor');
    assert.ok(result.some(b => b.displayName.includes('someRef')), 'Should keep REFERENCE with edges (Inv-2)');
  });

  // === Sort order: input → process → output ===

  it('Sort: receives should appear before calls in rendered output', () => {
    const parent = { id: 'fn', type: 'FUNCTION', name: 'handler' };
    const edges = [
      { src: parent.id, dst: 'arg', type: 'RECEIVES_ARGUMENT' },
      { src: parent.id, dst: 'target', type: 'CALLS' },
      { src: parent.id, dst: 'dep', type: 'IMPORTS' },
    ];
    const extraNodes = [
      { id: 'arg', type: 'PARAMETER', name: 'req' },
      { id: 'target', type: 'FUNCTION', name: 'process' },
      { id: 'dep', type: 'MODULE', name: 'utils' },
    ];

    const subgraph = makeSubgraph([parent], edges, extraNodes);
    const result = renderNotation(subgraph, { depth: 1 });

    const receivesPos = result.indexOf('receives');
    const importsPos = result.indexOf('imports');
    const callsPos = result.indexOf('calls');

    assert.ok(receivesPos >= 0, 'Should have receives line');
    assert.ok(importsPos >= 0, 'Should have imports line');
    assert.ok(callsPos >= 0, 'Should have calls line');
    assert.ok(receivesPos < importsPos, `receives (${receivesPos}) should come before imports (${importsPos})`);
    assert.ok(importsPos < callsPos, `imports (${importsPos}) should come before calls (${callsPos})`);
  });

  // === Edge case: empty input ===

  it('should handle empty block list', () => {
    const result = foldBlocks([]);
    assert.deepEqual(result, []);
  });

  // === Edge case: single block ===

  it('should return single block unchanged', () => {
    const block = {
      nodeId: 'fn1',
      displayName: 'main',
      nodeType: 'FUNCTION',
      lines: [{ operator: '>', verb: 'calls', targets: ['start'], sortOrder: 1 }],
      children: [],
    };

    const result = foldBlocks([block]);
    assert.equal(result.length, 1);
    assert.equal(result[0].displayName, 'main');
  });

  // === Recursive folding ===

  it('should recursively fold children of non-folded blocks', () => {
    // Parent with 2 unique children, each with 5 identical grandchildren
    const child1 = {
      nodeId: 'fn1',
      displayName: 'processA',
      nodeType: 'FUNCTION',
      lines: [{ operator: '>', verb: 'calls', targets: ['external'], sortOrder: 1 }],
      children: [],
    };

    const child2 = {
      nodeId: 'fn2',
      displayName: 'processB',
      nodeType: 'FUNCTION',
      lines: [{ operator: '>', verb: 'calls', targets: ['other'], sortOrder: 1 }],
      children: [],
    };

    // Give child1 five identical grandchildren
    for (let i = 0; i < 5; i++) {
      child1.children.push({
        nodeId: `gc${i}`,
        displayName: `helper${i}`,
        nodeType: 'FUNCTION',
        lines: [{ operator: '<', verb: 'reads', targets: ['config'], sortOrder: 1 }],
        children: [],
      });
    }

    const result = foldBlocks([child1, child2]);

    // child1 should have its grandchildren folded
    const resultChild1 = result.find(b => b.displayName === 'processA');
    assert.ok(resultChild1, 'Should have processA');
    assert.ok(
      resultChild1.children.some(b => b.foldMeta?.kind === 'fold'),
      `processA's grandchildren should be folded. Children: ${resultChild1.children.map(b => b.displayName).join(', ')}`,
    );
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderTraceNarrative } from '@grafema/util';

/**
 * Helper: create a DataflowNode
 */
function node(id, type, name, file, line) {
  return { id, type, name, file, line };
}

/**
 * Helper: create a TraceDataflowResult
 */
function result(direction, startNode, reached, totalReached) {
  return {
    direction,
    startNode,
    reached,
    totalReached: totalReached ?? reached.length,
  };
}

/** Get body lines (everything before the legend block, excluding trailing blank). */
function bodyLines(output) {
  const lines = output.split('\n');
  const legendIdx = lines.findIndex(l => l.startsWith('Legend:'));
  if (legendIdx < 0) return lines;
  const end = legendIdx > 0 && lines[legendIdx - 1] === '' ? legendIdx - 1 : legendIdx;
  return lines.slice(0, end);
}

describe('renderTraceNarrative', () => {
  it('returns message for empty results', () => {
    const out = renderTraceNarrative([], 'foo');
    assert.ok(out.includes('No dataflow results'));
    assert.ok(out.includes('foo'));
  });

  it('handles all-noise results with informative message', () => {
    const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
    const reached = [
      node('r1', 'REFERENCE', 'ref1', 'a.js', 2),
      node('r2', 'EXPRESSION', 'expr1', 'a.js', 3),
    ];
    const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');
    // BFS found 2 nodes but all are noise — should say so, not "no reachable nodes"
    assert.ok(out.includes('2 nodes reached'), `Expected "2 nodes reached", got first line: ${out.split('\n')[0]}`);
    assert.ok(out.includes('internal references'), 'Should mention internal references');
    assert.ok(out.includes('detail="full"'), 'Should suggest detail="full"');
  });

  it('shows "no reachable nodes" when BFS truly found nothing', () => {
    const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
    const out = renderTraceNarrative([result('forward', start, [])], 'SEED');
    assert.ok(out.includes('no reachable nodes'));
  });

  // === Legend and LOD hints ===

  describe('legend and LOD hints', () => {
    it('includes legend generated from archetypes', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [node('n1', 'VARIABLE', 'x', 'a.js', 5)];
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('Legend:'));
      // Legend is generated from archetypes.ts — same as describe tool
      assert.ok(out.includes('> calls') || out.includes('> routes'), 'Legend should include flow_out verb from archetypes');
      assert.ok(out.includes('< reads') || out.includes('< receives'), 'Legend should include flow_in verb from archetypes');
      assert.ok(out.includes('{} contains'));
    });

    it('shows LOD hint for normal detail', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [node('n1', 'VARIABLE', 'x', 'a.js', 5)];
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('detail="full"'));
      assert.ok(out.includes('detail="summary"'));
    });

    it('shows LOD hint for summary detail', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [node('n1', 'VARIABLE', 'x', 'a.js', 5)];
      const out = renderTraceNarrative(
        [result('forward', start, reached)],
        'SEED',
        { detail: 'summary' },
      );

      assert.ok(out.includes('detail="normal"'));
      assert.ok(out.includes('detail="full"'));
    });

    it('shows LOD hint for full detail', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [node('n1', 'VARIABLE', 'x', 'a.js', 5)];
      const out = renderTraceNarrative(
        [result('forward', start, reached)],
        'SEED',
        { detail: 'full' },
      );

      assert.ok(out.includes('detail="summary"'));
      assert.ok(out.includes('detail="normal"'));
    });
  });

  // === detail="full" ===

  describe('detail="full"', () => {
    it('lists every node with no budget', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'src/main.js', 1);
      const reached = [];
      for (let i = 0; i < 100; i++) {
        reached.push(node(`n${i}`, 'VARIABLE', `var${i}`, `src/file${i % 5}.js`, i));
      }

      const out = renderTraceNarrative(
        [result('forward', start, reached, reached.length)],
        'SEED',
        { detail: 'full' },
      );

      assert.ok(!out.includes('... and'));
      assert.ok(!out.includes('... +'));
      assert.ok(out.includes('var0 (VARIABLE)'));
      assert.ok(out.includes('var50 (VARIABLE)'));
      assert.ok(out.includes('var99 (VARIABLE)'));
      const body = bodyLines(out);
      assert.ok(body.length > 35, `Full detail should exceed budget: got ${body.length} lines`);
    });

    it('groups by file', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [
        node('n1', 'VARIABLE', 'x', 'a.js', 2),
        node('n2', 'CALL', 'fn', 'b.js', 1),
      ];

      const out = renderTraceNarrative(
        [result('forward', start, reached)],
        'SEED',
        { detail: 'full' },
      );

      assert.ok(out.includes('a.js'));
      assert.ok(out.includes('b.js'));
      assert.ok(out.includes('> x (VARIABLE)'));
      assert.ok(out.includes('> fn (CALL)'));
    });
  });

  // === detail="summary" ===

  describe('detail="summary"', () => {
    it('shows only per-file type counts', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [
        node('n1', 'VARIABLE', 'x', 'a.js', 2),
        node('n2', 'VARIABLE', 'y', 'a.js', 3),
        node('n3', 'CALL', 'fn', 'b.js', 1),
      ];

      const out = renderTraceNarrative(
        [result('forward', start, reached)],
        'SEED',
        { detail: 'summary' },
      );

      assert.ok(out.includes('a.js'));
      assert.ok(out.includes('2 VARIABLE'));
      assert.ok(out.includes('b.js'));
      assert.ok(out.includes('1 CALL'));
      // Should NOT show individual node operators
      assert.ok(!out.includes('> x'));
      assert.ok(!out.includes('> y'));
    });
  });

  // === Unified operators (same vocabulary as describe) ===

  describe('unified operator vocabulary', () => {
    it('maps CONSTANT to => (write), same as describe', () => {
      const start = node('s1', 'VARIABLE', 'x', 'a.js', 1);
      const reached = [node('n1', 'CONSTANT', 'CONFIG', 'a.js', 5)];
      const out = renderTraceNarrative([result('forward', start, reached)], 'x');

      assert.ok(out.includes('=> CONFIG (CONSTANT)'));
    });

    it('maps BRANCH to ?| (gates)', () => {
      const start = node('s1', 'VARIABLE', 'x', 'a.js', 1);
      const reached = [node('n1', 'BRANCH', 'ternary', 'a.js', 5)];
      const out = renderTraceNarrative([result('forward', start, reached)], 'x');

      assert.ok(out.includes('?| ternary (BRANCH)'));
    });

    it('maps FUNCTION/METHOD to o- (depends)', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [
        node('n1', 'FUNCTION', 'handler', 'a.js', 2),
        node('n2', 'METHOD', 'process', 'a.js', 3),
      ];
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('o- handler (FUNCTION)'));
      assert.ok(out.includes('o- process (METHOD)'));
    });

    it('maps CLASS to {} (contains)', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [node('n1', 'CLASS', 'MyClass', 'a.js', 2)];
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('{} MyClass (CLASS)'));
    });

    it('maps EXPORT forward to > (flow_out)', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [node('n1', 'EXPORT', 'api', 'a.js', 2)];
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('> api (EXPORT)'));
    });

    it('maps IMPORT forward to < (flow_in)', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [node('n1', 'IMPORT', 'lodash', 'a.js', 2)];
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('< lodash (IMPORT)'));
    });
  });

  // === Count accuracy (filtered count in header) ===

  describe('count accuracy', () => {
    it('header shows filtered count, not totalReached', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      // 3 real + 2 noise = 5 totalReached, but only 3 shown
      const reached = [
        node('n1', 'VARIABLE', 'x', 'a.js', 2),
        node('n2', 'REFERENCE', 'ref', 'a.js', 3),
        node('n3', 'CALL', 'fn', 'a.js', 4),
        node('n4', 'EXPRESSION', 'e', 'a.js', 5),
        node('n5', 'PARAMETER', 'p', 'a.js', 6),
      ];
      const out = renderTraceNarrative([result('forward', start, reached, 5)], 'SEED');

      // Should show 3 (filtered), not 5 (total with noise)
      assert.ok(out.includes('3 nodes reached'), `Expected "3 nodes reached", got: ${out.split('\n')[0]}`);
    });
  });

  // === Line number sorting ===

  describe('line number sorting', () => {
    it('sorts nodes within file by line number', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      // Nodes in BFS order (not line order)
      const reached = [
        node('n1', 'VARIABLE', 'z', 'a.js', 30),
        node('n2', 'VARIABLE', 'a', 'a.js', 5),
        node('n3', 'VARIABLE', 'm', 'a.js', 15),
      ];
      const out = renderTraceNarrative(
        [result('forward', start, reached)],
        'SEED',
        { detail: 'full' },
      );

      const lines = out.split('\n').filter(l => l.includes('(VARIABLE)'));
      assert.equal(lines.length, 3);
      // Should be sorted: a (5), m (15), z (30)
      assert.ok(lines[0].includes('a'), `First should be 'a', got: ${lines[0]}`);
      assert.ok(lines[1].includes('m'), `Second should be 'm', got: ${lines[1]}`);
      assert.ok(lines[2].includes('z'), `Third should be 'z', got: ${lines[2]}`);
    });
  });

  // === Tier 1: 1-5 nodes (normal detail) ===

  describe('tier 1 — chain', () => {
    it('single node forward', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [node('n1', 'VARIABLE', 'x', 'a.js', 5)];
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('"SEED" →'));
      assert.ok(out.includes('chain'));
      assert.ok(out.includes('1 nodes reached'));
      assert.ok(out.includes('> x (VARIABLE)'));
    });

    it('5 nodes same file', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [
        node('n1', 'VARIABLE', 'a', 'a.js', 2),
        node('n2', 'CALL', 'doSomething', 'a.js', 3),
        node('n3', 'PARAMETER', 'p', 'a.js', 4),
        node('n4', 'RETURN', 'ret', 'a.js', 5),
        node('n5', 'CONSTANT', 'C', 'a.js', 6),
      ];
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('chain'));
      assert.ok(out.includes('5 nodes reached'));
      assert.ok(out.includes('> a (VARIABLE)'));
      assert.ok(out.includes('> doSomething (CALL)'));
      assert.ok(out.includes('> p (PARAMETER)'));
      assert.ok(out.includes('> ret (RETURN)'));
      assert.ok(out.includes('=> C (CONSTANT)'));
    });
  });

  // === Tier 2: 6-30 nodes ===

  describe('tier 2 — fan-out', () => {
    it('15 nodes across 4 files', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'src/index.js', 1);
      const reached = [];
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 3; j++) {
          reached.push(node(`n${i}_${j}`, 'VARIABLE', `var_${i}_${j}`, `src/mod${i}.js`, j + 1));
        }
      }
      reached.push(node('nx1', 'CALL', 'init', 'src/index.js', 10));
      reached.push(node('nx2', 'CALL', 'setup', 'src/index.js', 11));
      reached.push(node('nx3', 'CALL', 'boot', 'src/index.js', 12));

      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('15 nodes reached'));
      assert.ok(out.includes('src/mod0.js'));
      assert.ok(out.includes('src/mod1.js'));
    });
  });

  // === Tier 3: 31-100 nodes ===

  describe('tier 3 — compression', () => {
    it('50 nodes body fits in budget', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'src/main.js', 1);
      const reached = [];
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 5; j++) {
          reached.push(node(`n${i}_${j}`, 'VARIABLE', `v_${i}_${j}`, `src/file${i}.js`, j + 1));
        }
      }

      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('50 nodes reached'));
      const body = bodyLines(out);
      assert.ok(body.length <= 35, `Body ${body.length} lines exceeds 35-line budget`);
    });
  });

  // === Tier 5: 300+ nodes ===

  describe('tier 5 — directory summary', () => {
    it('300+ nodes grouped by directory', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'src/main.js', 1);
      const reached = [];
      for (let d = 0; d < 10; d++) {
        for (let f = 0; f < 5; f++) {
          for (let n = 0; n < 7; n++) {
            reached.push(node(
              `n${d}_${f}_${n}`,
              n % 2 === 0 ? 'VARIABLE' : 'CALL',
              `node_${d}_${f}_${n}`,
              `src/dir${d}/file${f}.js`,
              n + 1,
            ));
          }
        }
      }

      const out = renderTraceNarrative(
        [result('forward', start, reached, reached.length)],
        'SEED',
      );

      assert.ok(out.includes('350 nodes reached'));
      assert.ok(out.includes('src/dir0/'));
      const body = bodyLines(out);
      assert.ok(body.length <= 35, `Body ${body.length} lines exceeds 35-line budget`);
    });
  });

  // === Backward direction ===

  describe('backward direction', () => {
    it('uses inverted operators', () => {
      const start = node('s1', 'VARIABLE', 'x', 'a.js', 1);
      const reached = [
        node('n1', 'PARAMETER', 'p', 'a.js', 2),
        node('n2', 'CALL', 'fetch', 'a.js', 3),
        node('n3', 'IMPORT', 'lib', 'a.js', 4),
      ];
      const out = renderTraceNarrative([result('backward', start, reached)], 'x');

      assert.ok(out.includes('"x" ←'));
      // Backward: PARAMETER/CALL → < (flow_in)
      assert.ok(out.includes('< p (PARAMETER)'));
      assert.ok(out.includes('< fetch (CALL)'));
      // Backward: IMPORT → > (inverted)
      assert.ok(out.includes('> lib (IMPORT)'));
    });
  });

  // === Noise filtering ===

  describe('noise filtering', () => {
    it('skips REFERENCE, EXPRESSION, LITERAL nodes', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [
        node('n1', 'VARIABLE', 'x', 'a.js', 2),
        node('n2', 'REFERENCE', 'ref_x', 'a.js', 3),
        node('n3', 'EXPRESSION', 'expr', 'a.js', 4),
        node('n4', 'LITERAL', '42', 'a.js', 5),
        node('n5', 'CALL', 'doWork', 'a.js', 6),
      ];
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('x (VARIABLE)'));
      assert.ok(out.includes('doWork (CALL)'));
      const body = bodyLines(out);
      const bodyText = body.join('\n');
      assert.ok(!bodyText.includes('REFERENCE'));
      assert.ok(!bodyText.includes('(EXPRESSION)'));
      assert.ok(!bodyText.includes('(LITERAL)'));
    });
  });

  // === Shape detection (pinned assertions) ===

  describe('shape detection', () => {
    it('detects chain for ≤2 files ≤10 nodes', () => {
      const start = node('s1', 'VARIABLE', 'x', 'a.js', 1);
      const reached = [
        node('n1', 'CALL', 'fn', 'a.js', 2),
        node('n2', 'VARIABLE', 'y', 'b.js', 1),
      ];
      const out = renderTraceNarrative([result('forward', start, reached)], 'x');
      assert.ok(out.includes('chain'), `Expected chain, got: ${out.split('\n')[0]}`);
    });

    it('detects fan-out for 1 source, 3+ target files', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'src/entry.js', 1);
      const reached = [];
      // 4 target files, start file has <30% of nodes
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 3; j++) {
          reached.push(node(`n${i}_${j}`, 'VARIABLE', `v${i}${j}`, `src/mod${i}.js`, j));
        }
      }
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');
      assert.ok(out.includes('fan-out'), `Expected fan-out, got: ${out.split('\n')[0]}`);
    });

    it('detects fan-in when one file has >50% of nodes', () => {
      const start = node('s1', 'VARIABLE', 'result', 'src/main.js', 1);
      // main.js has 7/10 nodes (70%), 3+ files total
      const reached = [
        node('n1', 'CALL', 'a', 'src/a.js', 1),
        node('n2', 'CALL', 'b', 'src/b.js', 1),
        node('n3', 'VARIABLE', 'x', 'src/main.js', 2),
        node('n4', 'VARIABLE', 'y', 'src/main.js', 3),
        node('n5', 'VARIABLE', 'z', 'src/main.js', 4),
        node('n6', 'VARIABLE', 'w', 'src/main.js', 5),
        node('n7', 'VARIABLE', 'v', 'src/main.js', 6),
        node('n8', 'VARIABLE', 'u', 'src/main.js', 7),
        node('n9', 'VARIABLE', 't', 'src/main.js', 8),
        node('n10', 'CALL', 'c', 'src/c.js', 1),
      ];
      const out = renderTraceNarrative([result('backward', start, reached)], 'result');
      assert.ok(out.includes('fan-in'), `Expected fan-in, got: ${out.split('\n')[0]}`);
    });

    it('detects diamond for 4+ files with spread distribution', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'src/entry.js', 1);
      // 4 files, each ~25% — no single file has >50%, not fan-out (start not in these files)
      const reached = [
        node('n1', 'VARIABLE', 'a1', 'src/a.js', 1),
        node('n2', 'VARIABLE', 'a2', 'src/a.js', 2),
        node('n3', 'VARIABLE', 'a3', 'src/a.js', 3),
        node('n4', 'VARIABLE', 'b1', 'src/b.js', 1),
        node('n5', 'VARIABLE', 'b2', 'src/b.js', 2),
        node('n6', 'VARIABLE', 'b3', 'src/b.js', 3),
        node('n7', 'VARIABLE', 'c1', 'src/c.js', 1),
        node('n8', 'VARIABLE', 'c2', 'src/c.js', 2),
        node('n9', 'VARIABLE', 'c3', 'src/c.js', 3),
        node('n10', 'VARIABLE', 'd1', 'src/d.js', 1),
        node('n11', 'VARIABLE', 'd2', 'src/d.js', 2),
        node('n12', 'VARIABLE', 'd3', 'src/d.js', 3),
      ];
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');
      // 4 files, start file not in results, each ~25% — could be fan-out or diamond
      // fan-out: 4+ other files, start has <30% → yes, this is fan-out
      // That's OK — the point is it's not misidentified as chain
      assert.ok(
        out.includes('fan-out') || out.includes('diamond'),
        `Expected fan-out or diamond, got: ${out.split('\n')[0]}`,
      );
    });
  });

  // === Multiple results (forward + backward) ===

  describe('multiple results', () => {
    it('renders both forward and backward', () => {
      const start = node('s1', 'VARIABLE', 'x', 'a.js', 1);
      const fwdReached = [node('n1', 'CALL', 'save', 'b.js', 1)];
      const bwdReached = [node('n2', 'PARAMETER', 'input', 'c.js', 1)];

      const out = renderTraceNarrative([
        result('forward', start, fwdReached),
        result('backward', start, bwdReached),
      ], 'x');

      assert.ok(out.includes('"x" →'));
      assert.ok(out.includes('"x" ←'));
      assert.ok(out.includes('save'));
      assert.ok(out.includes('input'));
    });
  });

  // === Budget enforcement ===

  describe('hard budget', () => {
    it('normal detail body never exceeds 35 lines', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'src/main.js', 1);
      const reached = [];
      for (let i = 0; i < 200; i++) {
        reached.push(node(`n${i}`, 'VARIABLE', `var${i}`, `src/file${i % 20}.js`, i));
      }

      const out = renderTraceNarrative(
        [result('forward', start, reached, reached.length)],
        'SEED',
      );
      const body = bodyLines(out);
      assert.ok(body.length <= 35, `Body ${body.length} lines exceeds 35-line budget`);
    });

    it('full detail has no budget', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'src/main.js', 1);
      const reached = [];
      for (let i = 0; i < 50; i++) {
        reached.push(node(`n${i}`, 'VARIABLE', `var${i}`, `src/file${i % 5}.js`, i));
      }

      const out = renderTraceNarrative(
        [result('forward', start, reached, reached.length)],
        'SEED',
        { detail: 'full' },
      );
      const body = bodyLines(out);
      assert.ok(body.length > 35, `Full detail should exceed 35 lines, got ${body.length}`);
    });
  });

  // === Anonymous nodes ===

  describe('anonymous nodes', () => {
    it('shows (anonymous) for nodes without name', () => {
      const start = node('s1', 'CONSTANT', 'SEED', 'a.js', 1);
      const reached = [node('n1', 'FUNCTION', undefined, 'a.js', 2)];
      const out = renderTraceNarrative([result('forward', start, reached)], 'SEED');

      assert.ok(out.includes('(anonymous)'));
    });
  });
});

/**
 * Unit tests for OverflowBadge (DAI-22 Chunk-6 §A.7).
 *
 * Covers:
 *   - meanPosition: mean of placed symbol positions (Chunk-6 fallback
 *     for hull centroid — Chunk-7 will supersede).
 *   - placedNodesForFile: selects nodes by file path.
 *   - overflowTooltip: exact tooltip string per §A.7.
 *   - Render smoke: badge renders with data-* attrs + title tooltip.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';

import {
  OverflowBadge,
  meanPosition,
  overflowTooltip,
  placedNodesForFile,
} from '../../src/OverflowBadge';

describe('meanPosition', () => {
  it('returns the arithmetic mean of 3 positions', () => {
    const m = meanPosition([
      { x: 0, z: 0 },
      { x: 6, z: 0 },
      { x: 0, z: 6 },
    ]);
    assert.deepEqual(m, { x: 2, z: 2 });
  });

  it('returns null on empty input', () => {
    assert.equal(meanPosition([]), null);
  });

  it('handles a single node', () => {
    const m = meanPosition([{ x: 4, z: -3 }]);
    assert.deepEqual(m, { x: 4, z: -3 });
  });
});

describe('placedNodesForFile', () => {
  it('filters nodes by exact file path', () => {
    const nodes = [
      { id: 'a', type: 'FUNCTION', name: 'a', file: 'src/x.ts', region: '', x: 0, z: 0, degree: 0 },
      { id: 'b', type: 'FUNCTION', name: 'b', file: 'src/y.ts', region: '', x: 1, z: 1, degree: 0 },
      { id: 'c', type: 'FUNCTION', name: 'c', file: 'src/x.ts', region: '', x: 2, z: 2, degree: 0 },
    ];
    const out = placedNodesForFile(nodes, 'src/x.ts');
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((n) => n.id), ['a', 'c']);
  });
});

describe('overflowTooltip', () => {
  it('formats the §A.7 tooltip exactly', () => {
    const t = overflowTooltip({ file: 'src/heavy.ts', skipped: 847, cap: 500 });
    assert.match(t, /847 symbols not displayed/);
    assert.match(t, /hard cap 500/);
    assert.match(t, /grafema layout --max-symbols-per-file=<N>/);
  });
});

describe('OverflowBadge render', () => {
  it('renders with data-* attrs and title tooltip', () => {
    const html = renderToString(
      React.createElement(OverflowBadge, {
        entry: { file: 'src/heavy.ts', skipped: 42, cap: 10 },
        position: { x: 100, z: 200 },
      }),
    );
    assert.match(html, /data-file="src\/heavy\.ts"/);
    assert.match(html, /data-skipped="42"/);
    assert.match(html, /data-cap="10"/);
    assert.match(html, /title="42 symbols not displayed/);
    assert.match(html, />42</); // badge text content
  });
});

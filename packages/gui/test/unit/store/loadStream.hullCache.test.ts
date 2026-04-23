/**
 * DAI-22 Chunk-8 — tests for hull-cache wiring in loadStream.
 *
 * Covers the pure helpers (`worldToAxial`, `buildPlacedForBucketing`,
 * `filterOutDepthZero`) without needing a live fetch or store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  worldToAxial,
  buildPlacedForBucketing,
  filterOutDepthZero,
} from '../../../src/store/loadStream.js';
import { buildRegionTree, type RegionNodeRaw } from '../../../src/store/layoutStore.js';
import { cubeToWorld } from '../../../src/geom/hex.js';
import type { LayoutResult } from '../../../src/layout/types.js';

describe('worldToAxial', () => {
  it('round-trips through cubeToWorld for integer (q, r)', () => {
    const samples: Array<[number, number]> = [
      [0, 0], [1, 0], [0, 1], [3, -2], [-5, 4], [10, 10], [-7, 3],
    ];
    for (const [q, r] of samples) {
      const { x, z } = cubeToWorld(q, r, 3.0);
      const back = worldToAxial(x, z, 3.0);
      assert.equal(back.q, q, `q mismatch for (${q},${r})`);
      assert.equal(back.r, r, `r mismatch for (${q},${r})`);
    }
  });
});

describe('buildPlacedForBucketing', () => {
  it('maps nodes to region ids via byFile and recovers axial coords', () => {
    const tree = buildRegionTree([
      {
        id: 'root',
        depth: 0,
        path: 'src',
        kind: 'folder',
        name: 'src',
        children: [
          { id: 'fileA', depth: 1, path: 'src/a.ts', kind: 'file', name: 'a.ts' },
          { id: 'fileB', depth: 1, path: 'src/b.ts', kind: 'file', name: 'b.ts' },
        ],
      },
    ]);
    const { x: xa, z: za } = cubeToWorld(2, -1, 3.0);
    const { x: xb, z: zb } = cubeToWorld(5, 3, 3.0);
    const layout = {
      nodes: [
        { id: 'n1', type: 'FUNCTION', name: 'n1', file: 'src/a.ts', region: 'src/a.ts', x: xa, z: za, degree: 0 },
        { id: 'n2', type: 'FUNCTION', name: 'n2', file: 'src/b.ts', region: 'src/b.ts', x: xb, z: zb, degree: 0 },
        { id: 'n3', type: 'FUNCTION', name: 'n3', file: 'unknown.ts', region: 'unknown.ts', x: 0, z: 0, degree: 0 },
      ],
      edges: [],
      regions: [],
      typeTable: [],
      edgeTypeTable: [],
    } as unknown as LayoutResult;

    const placed = buildPlacedForBucketing(layout, tree);
    // n3 has a region path not in byFile → dropped defensively.
    assert.equal(placed.length, 2);
    const a = placed.find((p) => p.regionId === 'fileA');
    const b = placed.find((p) => p.regionId === 'fileB');
    assert.deepEqual(a, { regionId: 'fileA', q: 2, r: -1 });
    assert.deepEqual(b, { regionId: 'fileB', q: 5, r: 3 });
  });
});

describe('filterOutDepthZero', () => {
  const raw: RegionNodeRaw[] = [
    {
      id: 'root1',
      depth: 0,
      path: 'src',
      kind: 'folder',
      name: 'src',
      children: [
        {
          id: 'd1',
          depth: 1,
          path: 'src/sub',
          kind: 'folder',
          name: 'sub',
          children: [
            { id: 'f1', depth: 2, path: 'src/sub/a.ts', kind: 'file', name: 'a.ts' },
          ],
        },
      ],
    },
  ];

  it('drops depth-0 roots and promotes depth-1 to root-less', () => {
    const tree = buildRegionTree(raw);
    const filtered = filterOutDepthZero(tree);
    assert.ok(!filtered.byId.has('root1'), 'root should be dropped');
    assert.ok(filtered.byId.has('d1'), 'depth-1 survives');
    assert.ok(filtered.byId.has('f1'), 'depth-2 survives');
    const d1 = filtered.byId.get('d1')!;
    assert.equal(d1.parentId, null, 'd1 becomes root-less');
    assert.deepEqual(filtered.roots, ['d1'], 'd1 is new root');
  });

  it('preserves byFile index verbatim (callers still need file lookup)', () => {
    const tree = buildRegionTree(raw);
    const filtered = filterOutDepthZero(tree);
    assert.equal(filtered.byFile, tree.byFile);
  });

  it('leaves deeper parent chains intact (does not flatten)', () => {
    const tree = buildRegionTree(raw);
    const filtered = filterOutDepthZero(tree);
    const f1 = filtered.byId.get('f1')!;
    assert.equal(f1.parentId, 'd1');
  });
});

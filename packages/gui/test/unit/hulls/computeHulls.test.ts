/**
 * Tests for morphological-close hull computation (DAI-22 Chunk-7).
 *
 * Runs under `node --import tsx --test`. No real graph / store / network;
 * every fixture is a tiny synthetic region tree + hand-placed hex cells.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHullsForRegions,
  bucketSymbolsByRegion,
} from '../../../src/hulls/computeHulls.js';
import type {
  RegionTree,
  RegionInfo,
} from '../../../src/store/layoutStore.js';
import type { HexCoord } from '../../../src/geom/hex.js';
import type { Polygon } from '../../../src/hulls/computeHulls.js';

// ---------------------------------------------------------------------------
// Tiny RegionTree builder for fixtures
// ---------------------------------------------------------------------------

interface NodeSpec {
  id: string;
  children?: NodeSpec[];
}

function buildTree(roots: NodeSpec[]): RegionTree {
  const byId = new Map<string, RegionInfo>();
  const byFile = new Map<string, string>();
  const rootIds: string[] = [];
  const walk = (n: NodeSpec, parentId: string | null, depth: number): void => {
    const info: RegionInfo = {
      id: n.id,
      depth,
      path: n.id,
      kind: 'file',
      name: n.id,
      parentId,
      childIds: (n.children ?? []).map((c) => c.id),
    };
    byId.set(n.id, info);
    byFile.set(n.id, n.id);
    for (const c of n.children ?? []) walk(c, n.id, depth + 1);
  };
  for (const r of roots) {
    rootIds.push(r.id);
    walk(r, null, 0);
  }
  return { roots: rootIds, byId, byFile };
}

function uniqueVertexCount(polygon: Polygon): number {
  const seen = new Set<string>();
  for (const v of polygon) seen.add(`${Math.round(v.x * 1000)},${Math.round(v.y * 1000)}`);
  return seen.size;
}

function firstEqLast(polygon: Polygon): boolean {
  if (polygon.length < 2) return false;
  const a = polygon[0];
  const b = polygon[polygon.length - 1];
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeHullsForRegions — policies', () => {
  it('1-cell region produces a single hex polygon (6 unique vertices)', () => {
    const tree = buildTree([{ id: 'R1' }]);
    const symbols = new Map<string, HexCoord[]>([['R1', [{ q: 0, r: 0 }]]]);
    const hulls = computeHullsForRegions(tree, symbols);

    assert.equal(hulls.size, 1);
    const g = hulls.get('R1')!;
    assert.equal(g.polygons.length, 1);
    assert.equal(g.area, 1);
    // 6 unique hex corners; polygon closes so first point is repeated.
    assert.equal(uniqueVertexCount(g.polygons[0]), 6);
    assert.equal(g.polygons[0].length, 7);
    assert.ok(firstEqLast(g.polygons[0]), 'single-hex polygon must close');
  });

  it('2 adjacent cells → merged hull, one polygon, no erosion gap', () => {
    const tree = buildTree([{ id: 'R1' }]);
    // (0,0) and its east neighbour (1,0).
    const symbols = new Map<string, HexCoord[]>([
      ['R1', [{ q: 0, r: 0 }, { q: 1, r: 0 }]],
    ]);
    const hulls = computeHullsForRegions(tree, symbols);
    const g = hulls.get('R1')!;
    assert.equal(g.polygons.length, 1, 'two adjacent cells should merge into one polygon');
    // Morphological close on 2 adjacent cells: dilate keeps the pair, erode
    // removes cells missing any of 6 neighbours → may shrink back to 0 cells;
    // we then re-union with originals, so area ≥ 2. Hole fill may add more.
    assert.ok(g.area >= 2, `area ${g.area} should be >= 2`);
  });

  it('2 cells at distance 3 (disjoint) → 2 polygons per region', () => {
    const tree = buildTree([{ id: 'R1' }]);
    // (0,0) and (3,0): separated by two empty cells in between, gap > 2·r.
    const symbols = new Map<string, HexCoord[]>([
      ['R1', [{ q: 0, r: 0 }, { q: 3, r: 0 }]],
    ]);
    const hulls = computeHullsForRegions(tree, symbols, { radius: 1 });
    const g = hulls.get('R1')!;
    assert.equal(g.polygons.length, 2, 'gap > 2 with r=1 stays disjoint');
  });

  it('3-cell ring (hex flower without centre) → close fills centre, 1 polygon, no inner loop', () => {
    // 6 cells forming a ring around (0,0). Dilation produces the 0-cell's
    // 6 neighbours (the ring) + their neighbours. Erosion keeps cells whose
    // all 6 neighbours are dilated — (0,0) qualifies because each of its 6
    // neighbours is in the ring, so the centre fills. Result: 7-cell hex
    // flower = single convex polygon, 0 inner holes.
    const tree = buildTree([{ id: 'R1' }]);
    const ring: HexCoord[] = [
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ];
    const symbols = new Map<string, HexCoord[]>([['R1', ring]]);
    const hulls = computeHullsForRegions(tree, symbols);
    const g = hulls.get('R1')!;
    assert.equal(g.polygons.length, 1, 'hole-fill must leave a single outer loop');
    // 7 cells = 6 ring + 1 centre; boundary is 12 edges → 12 unique corners.
    assert.equal(g.area, 7, `expected 7 cells, got ${g.area}`);
  });

  it('parent region aggregates descendants cells into one hull', () => {
    //     parent
    //      /  \
    //    f1    f2
    // f1 has (0,0) and (1,0); f2 has (2,0). Parent hull covers all 3.
    const tree = buildTree([
      { id: 'parent', children: [{ id: 'f1' }, { id: 'f2' }] },
    ]);
    const symbols = new Map<string, HexCoord[]>([
      ['f1', [{ q: 0, r: 0 }, { q: 1, r: 0 }]],
      ['f2', [{ q: 2, r: 0 }]],
    ]);
    const hulls = computeHullsForRegions(tree, symbols);
    assert.ok(hulls.has('parent'), 'parent should get a hull from descendants');
    assert.ok(hulls.has('f1'), 'f1 should get its own hull');
    assert.ok(hulls.has('f2'), 'f2 should get its own hull');
    const pg = hulls.get('parent')!;
    // Parent is a connected 3-cell row — close keeps it connected → 1 poly.
    assert.equal(pg.polygons.length, 1);
    assert.ok(pg.area >= 3, `parent area ${pg.area} must cover all 3 cells`);
  });

  it('zero-leaf region → no entry in returned map', () => {
    const tree = buildTree([
      { id: 'empty-folder', children: [{ id: 'empty-file' }] },
      { id: 'filled', children: [] },
    ]);
    const symbols = new Map<string, HexCoord[]>([
      ['filled', [{ q: 0, r: 0 }]],
    ]);
    const hulls = computeHullsForRegions(tree, symbols);
    assert.equal(hulls.has('empty-folder'), false);
    assert.equal(hulls.has('empty-file'), false);
    assert.equal(hulls.has('filled'), true);
  });

  it('deterministic output: same input → identical polygon vertex sequence', () => {
    const tree = buildTree([{ id: 'R1' }]);
    const symbols = new Map<string, HexCoord[]>([
      ['R1', [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 1 }]],
    ]);
    const a = computeHullsForRegions(tree, symbols);
    const b = computeHullsForRegions(tree, symbols);
    const ga = a.get('R1')!;
    const gb = b.get('R1')!;
    assert.equal(ga.polygons.length, gb.polygons.length);
    assert.equal(ga.area, gb.area);
    for (let i = 0; i < ga.polygons.length; i++) {
      assert.deepEqual(ga.polygons[i], gb.polygons[i], `polygon ${i} must be byte-identical`);
    }
  });

  it('radius override: r=2 bridges 2-cell gaps that r=1 leaves disjoint', () => {
    // Two cells at distance 3 remain disjoint at r=1 (tested above) but
    // should merge at r=2 (dilate 2 rings → gap cells join, erode preserves
    // a connected interior).
    const tree = buildTree([{ id: 'R1' }]);
    const symbols = new Map<string, HexCoord[]>([
      ['R1', [{ q: 0, r: 0 }, { q: 3, r: 0 }]],
    ]);
    const r1 = computeHullsForRegions(tree, symbols, { radius: 1 });
    const r2 = computeHullsForRegions(tree, symbols, { radius: 2 });
    assert.equal(r1.get('R1')!.polygons.length, 2);
    assert.equal(r2.get('R1')!.polygons.length, 1, 'r=2 must merge distance-3 cells');
  });
});

describe('bucketSymbolsByRegion', () => {
  it('buckets nodes by regionId, preserving order', () => {
    const placed = [
      { regionId: 'a', q: 0, r: 0 },
      { regionId: 'b', q: 1, r: 0 },
      { regionId: 'a', q: 0, r: 1 },
    ];
    const m = bucketSymbolsByRegion(placed);
    assert.deepEqual(m.get('a'), [
      { q: 0, r: 0 },
      { q: 0, r: 1 },
    ]);
    assert.deepEqual(m.get('b'), [{ q: 1, r: 0 }]);
  });

  it('empty input → empty map', () => {
    const m = bucketSymbolsByRegion([]);
    assert.equal(m.size, 0);
  });
});

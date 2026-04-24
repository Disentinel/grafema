import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterVisibleRoutes,
  isRouteVisibleAtZoom,
} from '../../../src/lod/routeGate.js';
import type { GraphNode } from '../../../src/store/dataStore.js';
import type { Route } from '../../../src/store/routeStore.js';

function node(
  name: string,
  file: string,
  pos: { q: number; r: number } | null,
): GraphNode {
  return { name, file, type: 0, pos } as unknown as GraphNode;
}

function route(id: string, indices: number[]): Route {
  return { id, label: id, color: '#fff', nodeIndices: indices, visible: true };
}

const f2r = (map: Record<string, string>) => (file: string) => map[file];

describe('DAI-22 Chunk-9 — route LOD gate', () => {
  test('both endpoints visible + no intermediates → show', () => {
    const nodes = [node('a', 'fa', { q: 0, r: 0 }), node('b', 'fb', { q: 1, r: 0 })];
    const vis = new Set(['ra', 'rb']);
    assert.equal(
      isRouteVisibleAtZoom(route('r', [0, 1]), nodes, vis, f2r({ fa: 'ra', fb: 'rb' })),
      true,
    );
  });

  test('all intermediates visible → show', () => {
    const nodes = [
      node('a', 'fa', { q: 0, r: 0 }),
      node('b', 'fb', { q: 1, r: 0 }),
      node('c', 'fc', { q: 2, r: 0 }),
    ];
    const vis = new Set(['ra', 'rb', 'rc']);
    assert.equal(
      isRouteVisibleAtZoom(route('r', [0, 1, 2]), nodes, vis, f2r({ fa: 'ra', fb: 'rb', fc: 'rc' })),
      true,
    );
  });

  test('endpoint file-region collapsed → hide', () => {
    const nodes = [node('a', 'fa', { q: 0, r: 0 }), node('b', 'fb', { q: 1, r: 0 })];
    const vis = new Set(['ra']);
    assert.equal(
      isRouteVisibleAtZoom(route('r', [0, 1]), nodes, vis, f2r({ fa: 'ra', fb: 'rb' })),
      false,
    );
  });

  test('endpoint pos=null → hide', () => {
    const nodes = [node('a', 'fa', { q: 0, r: 0 }), node('b', 'fb', null)];
    const vis = new Set(['ra', 'rb']);
    assert.equal(
      isRouteVisibleAtZoom(route('r', [0, 1]), nodes, vis, f2r({ fa: 'ra', fb: 'rb' })),
      false,
    );
  });

  test('intermediate collapsed → hide entire route (no shortcut)', () => {
    const nodes = [
      node('a', 'fa', { q: 0, r: 0 }),
      node('b', 'fb', { q: 1, r: 0 }),
      node('c', 'fc', { q: 2, r: 0 }),
    ];
    const vis = new Set(['ra', 'rc']);
    assert.equal(
      isRouteVisibleAtZoom(route('r', [0, 1, 2]), nodes, vis, f2r({ fa: 'ra', fb: 'rb', fc: 'rc' })),
      false,
    );
  });

  test('route.visible=false in store → hide regardless', () => {
    const nodes = [node('a', 'fa', { q: 0, r: 0 }), node('b', 'fb', { q: 1, r: 0 })];
    const vis = new Set(['ra', 'rb']);
    const r = { ...route('r', [0, 1]), visible: false };
    assert.equal(
      isRouteVisibleAtZoom(r, nodes, vis, f2r({ fa: 'ra', fb: 'rb' })),
      false,
    );
  });

  test('route with <2 nodes → hide', () => {
    const nodes = [node('a', 'fa', { q: 0, r: 0 })];
    const vis = new Set(['ra']);
    assert.equal(
      isRouteVisibleAtZoom(route('r', [0]), nodes, vis, f2r({ fa: 'ra' })),
      false,
    );
  });

  test('unknown file (no region mapping) → hide', () => {
    const nodes = [node('a', 'fa', { q: 0, r: 0 }), node('b', 'missing', { q: 1, r: 0 })];
    const vis = new Set(['ra']);
    assert.equal(
      isRouteVisibleAtZoom(route('r', [0, 1]), nodes, vis, f2r({ fa: 'ra' })),
      false,
    );
  });

  test('filterVisibleRoutes preserves order, filters by gate', () => {
    const nodes = [
      node('a', 'fa', { q: 0, r: 0 }),
      node('b', 'fb', { q: 1, r: 0 }),
      node('c', 'fc', { q: 2, r: 0 }),
      node('d', 'fd', null),
    ];
    const vis = new Set(['ra', 'rb', 'rc']);
    const resolve = f2r({ fa: 'ra', fb: 'rb', fc: 'rc', fd: 'rd' });
    const routes = [
      route('a', [0, 1]),
      route('b', [0, 3]),
      route('c', [1, 2]),
      route('d', [2, 3]),
    ];
    const out = filterVisibleRoutes(routes, nodes, vis, resolve);
    assert.deepEqual(out.map((r) => r.id), ['a', 'c']);
  });
});

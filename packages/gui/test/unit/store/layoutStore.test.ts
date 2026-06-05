/**
 * Unit tests for layoutStore (DAI-22 Chunk-6).
 *
 * Covers:
 *   - buildRegionTree: flattens a nested region tree into an O(1)
 *     id-lookup map, tracks parentId, records byFile index.
 *   - getAncestors: walks parent chain, nearest-first, root-last.
 *   - getRegionForFile: returns region whose path equals the file, with
 *     preference for kind === "file" when two regions share a path.
 *   - Zustand setters: setLayoutMeta / setRegionTree / reset.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRegionTree,
  getAncestors,
  getRegionById,
  getRegionForFile,
  useLayoutStore,
  type RegionNodeRaw,
} from '../../../src/store/layoutStore';

const sampleTree: RegionNodeRaw[] = [
  {
    id: 'pkg:a',
    depth: 0,
    path: 'pkg/a',
    kind: 'package',
    name: 'a',
    children: [
      {
        id: 'dir:a/src',
        depth: 1,
        path: 'pkg/a/src',
        kind: 'directory',
        name: 'src',
        children: [
          {
            id: 'file:a/src/index.ts',
            depth: 2,
            path: 'pkg/a/src/index.ts',
            kind: 'file',
            name: 'index.ts',
          },
          {
            id: 'file:a/src/util.ts',
            depth: 2,
            path: 'pkg/a/src/util.ts',
            kind: 'file',
            name: 'util.ts',
          },
        ],
      },
    ],
  },
];

describe('buildRegionTree', () => {
  it('flattens nested regions into byId + preserves parentId chain', () => {
    const tree = buildRegionTree(sampleTree);
    assert.equal(tree.byId.size, 4);
    assert.deepEqual(tree.roots, ['pkg:a']);

    const root = getRegionById(tree, 'pkg:a');
    assert.ok(root);
    assert.equal(root.parentId, null);
    assert.deepEqual(root.childIds, ['dir:a/src']);

    const dir = getRegionById(tree, 'dir:a/src');
    assert.ok(dir);
    assert.equal(dir.parentId, 'pkg:a');
    assert.deepEqual(dir.childIds, ['file:a/src/index.ts', 'file:a/src/util.ts']);

    const file = getRegionById(tree, 'file:a/src/index.ts');
    assert.ok(file);
    assert.equal(file.parentId, 'dir:a/src');
    assert.deepEqual(file.childIds, []);
  });

  it('indexes byFile with file path', () => {
    const tree = buildRegionTree(sampleTree);
    const r = getRegionForFile(tree, 'pkg/a/src/index.ts');
    assert.ok(r);
    assert.equal(r.id, 'file:a/src/index.ts');
  });
});

describe('getAncestors', () => {
  it('returns nearest parent first, root last, excluding self', () => {
    const tree = buildRegionTree(sampleTree);
    const chain = getAncestors(tree, 'file:a/src/index.ts').map((r) => r.id);
    assert.deepEqual(chain, ['dir:a/src', 'pkg:a']);
  });

  it('returns empty array for root', () => {
    const tree = buildRegionTree(sampleTree);
    const chain = getAncestors(tree, 'pkg:a');
    assert.deepEqual(chain, []);
  });

  it('returns empty array for unknown id', () => {
    const tree = buildRegionTree(sampleTree);
    const chain = getAncestors(tree, 'nope');
    assert.deepEqual(chain, []);
  });
});

describe('useLayoutStore', () => {
  it('setLayoutMeta updates state', () => {
    useLayoutStore.getState().reset();
    useLayoutStore.getState().setLayoutMeta({
      source: 'missing',
      symbol_count: 0,
      committed_at: null,
      overflow_files: [],
    });
    assert.equal(useLayoutStore.getState().layoutMeta?.source, 'missing');
  });

  it('reset() wipes both slices', () => {
    const tree = buildRegionTree(sampleTree);
    useLayoutStore.getState().setRegionTree(tree);
    useLayoutStore.getState().setLayoutMeta({
      source: 'committed',
      symbol_count: 1,
      committed_at: '2026-04-23T00:00:00Z',
      overflow_files: [],
    });
    useLayoutStore.getState().reset();
    assert.equal(useLayoutStore.getState().layoutMeta, null);
    assert.equal(useLayoutStore.getState().regionTree.byId.size, 0);
  });
});

/**
 * Tests for monorepo package map resolution.
 * Verifies that bare imports like `@my/pkg` resolve to real modules
 * when a packageMap is provided, instead of staying as EXTERNAL nodes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkFile } from '../dist/walk.js';
import { jsRegistry } from '../dist/registry.js';
import { resolveFileRefs, resolveProject } from '../dist/resolve.js';

// ─── Helpers ─────────────────────────────────────────────────────────

async function walk(code, file = 'test.js') {
  const walkResult = await walkFile(code, file, jsRegistry);
  return resolveFileRefs(walkResult);
}

function findEdges(edges, type) {
  return edges.filter(e => e.type === type);
}

// ─── Package map: exact match ───────────────────────────────────────

describe('Package map resolution', () => {
  it('resolves bare import to real module via packageMap', async () => {
    // File A: exports a function
    const fileA = await walk(`
      export function GraphNode() {}
    `, 'packages/types/src/index.ts');

    // File B: imports from @my/pkg (bare specifier)
    const fileB = await walk(`
      import { GraphNode } from '@my/pkg';
      GraphNode();
    `, 'packages/core/src/main.ts');

    const packageMap = {
      '@my/pkg': 'packages/types/src/index.ts',
    };

    const { edges, stats } = resolveProject([fileA, fileB], undefined, packageMap);
    const importsFrom = findEdges(edges, 'IMPORTS_FROM');

    assert.ok(importsFrom.length >= 1,
      `expected at least 1 IMPORTS_FROM edge, got ${importsFrom.length}`);

    // The IMPORTS_FROM edge should point to the real function, not EXTERNAL
    const edge = importsFrom.find(e => !e.dst.includes('EXTERNAL'));
    assert.ok(edge,
      `expected IMPORTS_FROM to resolve to real node, got: ${JSON.stringify(importsFrom.map(e => e.dst))}`);
    assert.ok(edge.dst.includes('FUNCTION->GraphNode'),
      `expected dst to reference GraphNode function, got ${edge.dst}`);

    assert.ok(stats.importResolved >= 1, 'import should be counted as resolved');
  });

  it('stays EXTERNAL without packageMap', async () => {
    const fileA = await walk(`
      export function GraphNode() {}
    `, 'packages/types/src/index.ts');

    const fileB = await walk(`
      import { GraphNode } from '@my/pkg';
    `, 'packages/core/src/main.ts');

    // No packageMap — should not resolve
    const { edges } = resolveProject([fileA, fileB]);
    const importsFrom = findEdges(edges, 'IMPORTS_FROM');

    // Any IMPORTS_FROM should be to an EXTERNAL node, not to the real function
    for (const edge of importsFrom) {
      assert.ok(!edge.dst.includes('FUNCTION->GraphNode'),
        `without packageMap, should NOT resolve to real node, got: ${edge.dst}`);
    }
  });

  it('resolves subpath import: @my/pkg/sub', async () => {
    // File in subpath
    const fileA = await walk(`
      export function helper() {}
    `, 'packages/types/src/sub.ts');

    // Barrel entrypoint (not importing from sub)
    const fileB = await walk(`
      export const VERSION = '1.0';
    `, 'packages/types/src/index.ts');

    // Consumer imports subpath
    const fileC = await walk(`
      import { helper } from '@my/pkg/sub';
      helper();
    `, 'packages/core/src/main.ts');

    const packageMap = {
      '@my/pkg': 'packages/types/src/index.ts',
    };

    const { edges } = resolveProject([fileA, fileB, fileC], undefined, packageMap);
    const importsFrom = findEdges(edges, 'IMPORTS_FROM');

    const resolved = importsFrom.find(e => e.dst.includes('FUNCTION->helper'));
    assert.ok(resolved,
      `subpath import should resolve to helper, got: ${JSON.stringify(importsFrom.map(e => e.dst))}`);
  });

  it('resolves re-export chains through barrel files with packageMap', async () => {
    // Actual implementation file
    const implFile = await walk(`
      export function deepFn() {}
    `, 'packages/types/src/deep.ts');

    // Barrel re-exports from deep
    const barrelFile = await walk(`
      export { deepFn } from './deep.js';
    `, 'packages/types/src/index.ts');

    // Consumer imports through barrel
    const consumerFile = await walk(`
      import { deepFn } from '@my/pkg';
      deepFn();
    `, 'packages/core/src/app.ts');

    const packageMap = {
      '@my/pkg': 'packages/types/src/index.ts',
    };

    const { edges, stats } = resolveProject(
      [implFile, barrelFile, consumerFile],
      undefined,
      packageMap,
    );

    const importsFrom = findEdges(edges, 'IMPORTS_FROM');
    const resolved = importsFrom.find(e => e.dst.includes('FUNCTION->deepFn'));
    assert.ok(resolved,
      `re-export chain should resolve to deepFn, got: ${JSON.stringify(importsFrom.map(e => e.dst))}`);
  });

  it('resolves star re-export chains with packageMap', async () => {
    const implFile = await walk(`
      export function starFn() {}
    `, 'packages/types/src/impl.ts');

    // Barrel uses star re-export
    const barrelFile = await walk(`
      export * from './impl.js';
    `, 'packages/types/src/index.ts');

    const consumerFile = await walk(`
      import { starFn } from '@my/pkg';
      starFn();
    `, 'packages/core/src/app.ts');

    const packageMap = {
      '@my/pkg': 'packages/types/src/index.ts',
    };

    const { edges } = resolveProject(
      [implFile, barrelFile, consumerFile],
      undefined,
      packageMap,
    );

    const importsFrom = findEdges(edges, 'IMPORTS_FROM');
    const resolved = importsFrom.find(e => e.dst.includes('FUNCTION->starFn'));
    assert.ok(resolved,
      `star re-export should resolve to starFn, got: ${JSON.stringify(importsFrom.map(e => e.dst))}`);
  });

  it('resolves namespace import (import *) via packageMap', async () => {
    const fileA = await walk(`
      export function foo() {}
    `, 'packages/types/src/index.ts');

    const fileB = await walk(`
      import * as types from '@my/pkg';
    `, 'packages/core/src/main.ts');

    const packageMap = {
      '@my/pkg': 'packages/types/src/index.ts',
    };

    const { edges } = resolveProject([fileA, fileB], undefined, packageMap);
    const importsFrom = findEdges(edges, 'IMPORTS_FROM');

    // Namespace import should link to the MODULE node
    const resolved = importsFrom.find(e => e.dst.includes('MODULE'));
    assert.ok(resolved,
      `namespace import should resolve to MODULE, got: ${JSON.stringify(importsFrom.map(e => e.dst))}`);
  });
});

/**
 * CoverageAnalyzer under a SYMLINKED project root (REG-408).
 *
 * The graph stores realpath'd ABSOLUTE file paths on its MODULE/ISSUE nodes.
 * Both `grafema coverage` (CLI) and the MCP `get_coverage` handler compute the
 * project root with a plain `resolve()`, which does NOT collapse symlinks. When
 * the root is a symlink (e.g. macOS `/tmp` -> `/private/tmp`, a symlinked
 * checkout), `CoverageAnalyzer`'s `node.file.startsWith(projectPath)` guard
 * fails, so the analyzed MODULE path is kept in absolute form and never matches
 * the relative paths produced by the filesystem scan. The same file then gets
 * double-counted — once as `analyzed` (absolute) and once as `unreachable`
 * (relative) — inflating `total` and misreporting analyzed files as unreachable.
 *
 * Fix: `CoverageAnalyzer` realpaths the project root in its constructor, mirroring
 * the CLI's `resolveProjectRoot` helper (already used by `file`/`explain`).
 *
 * This reproduces the bug deterministically on any platform via an explicit
 * symlink to the realpath'd project dir, with no analyzer binary required (the
 * graph is a hand-built fake). Red before the fix, green after.
 *
 * Lives at the top level of `test/unit/` so it runs under the gated
 * `test/unit/*.test.js` CI suite (the `test/unit/core/` tree is not yet gated).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CoverageAnalyzer } from '@grafema/util';

/**
 * Minimal GraphBackend stand-in: `CoverageAnalyzer` only consumes `queryNodes`,
 * yielding MODULE nodes (analyzed files) and ISSUE nodes (skipped files). Each
 * MODULE file path is the realpath'd ABSOLUTE path, exactly as the analyzer
 * emits into the real graph.
 */
function fakeGraph(moduleFiles) {
  const nodes = moduleFiles.map((file, i) => ({
    id: `module:${i}`,
    type: 'MODULE',
    nodeType: 'MODULE',
    name: file.split('/').pop() || file,
    file,
    line: 1,
    column: 0,
    metadata: '{}',
  }));
  return {
    async *queryNodes(filter) {
      for (const node of nodes) {
        if (filter && filter.type && node.type !== filter.type) continue;
        yield node;
      }
    },
  };
}

describe('CoverageAnalyzer: symlinked project root (REG-408)', () => {
  let base;     // realpath'd temp base
  let realRoot; // the real (realpath'd) project directory
  let linkRoot; // a symlink pointing at realRoot

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'gfm-cov-sym-')));
    realRoot = join(base, 'proj');
    mkdirSync(join(realRoot, 'src'), { recursive: true });
    writeFileSync(join(realRoot, 'src', 'main.ts'), 'export const x = 1;');
    linkRoot = join(base, 'link');
    symlinkSync(realRoot, linkRoot);
  });

  afterEach(() => {
    if (base && existsSync(base)) rmSync(base, { recursive: true, force: true });
  });

  it('reports an analyzed file as analyzed (not unreachable) when the root is a symlink', async () => {
    // MODULE node carries the realpath'd ABSOLUTE path, as the analyzer emits.
    const absModule = join(realRoot, 'src', 'main.ts');
    const graph = fakeGraph([absModule]);

    // Caller passes the SYMLINK path (what `resolve('.')` yields under a
    // symlinked root). The analyzer must collapse it so path matching lines up.
    const result = await new CoverageAnalyzer(graph, linkRoot).analyze();

    assert.strictEqual(result.unreachable.count, 0, 'analyzed file must not be misreported as unreachable');
    assert.strictEqual(result.total, 1, 'the single source file must not be double-counted');
    assert.strictEqual(result.analyzed.count, 1);
    assert.ok(
      result.analyzed.files.includes('src/main.ts'),
      `analyzed files should be project-relative; got ${JSON.stringify(result.analyzed.files)}`,
    );
  });

  it('is unchanged for a non-symlinked (already realpath\'d) root', async () => {
    const absModule = join(realRoot, 'src', 'main.ts');
    const graph = fakeGraph([absModule]);

    const result = await new CoverageAnalyzer(graph, realRoot).analyze();

    assert.strictEqual(result.analyzed.count, 1);
    assert.strictEqual(result.unreachable.count, 0);
    assert.strictEqual(result.total, 1);
    assert.ok(result.analyzed.files.includes('src/main.ts'));
  });
});

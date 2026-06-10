/**
 * Regression: CoverageAnalyzer must normalize a symlinked project root.
 *
 * REG-408 class (realpath-vs-symlink): the graph stores realpath'd ABSOLUTE
 * file paths, but `grafema coverage` / the MCP `get_coverage` handler pass the
 * raw project root (`resolve(options.project)` / `getProjectPath()` /
 * `args.path`) WITHOUT collapsing symlinks. REG-408 fixed this for the `file`
 * and `explain` commands via `resolveProjectRoot` (realpath), but coverage was
 * missed in both packages.
 *
 * Under a symlinked root (e.g. macOS `/tmp` -> `/private/tmp`, or any explicit
 * symlink), an absolute MODULE path never `startsWith` the symlink root, so
 * CoverageAnalyzer keeps it absolute while `scanProjectFiles()` emits relative
 * paths. The SAME file then matches neither set the other way: it is counted as
 * `analyzed` (it has a MODULE node) AND as `unreachable` (its scanned relative
 * path is not in the analyzed set), double-inflating `total`.
 *
 * This test reproduces the double-count with an explicit symlink and a fake
 * graph holding canonical absolute MODULE paths. It is hermetic — no analyzer
 * binary, no `grafema analyze`, no rfdb server.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { CoverageAnalyzer } from '@grafema/util';

/**
 * Minimal GraphBackend stand-in: yields the MODULE/ISSUE nodes the
 * CoverageAnalyzer queries (`queryNodes({ type })`). Mirrors how the real
 * analyzer stores file paths — here we feed canonical ABSOLUTE MODULE paths,
 * which is the case that exposes the symlink bug.
 */
class FakeGraph {
  constructor(moduleAbsoluteFiles) {
    this.moduleFiles = moduleAbsoluteFiles;
  }

  async *queryNodes(filter) {
    if (filter && filter.type === 'MODULE') {
      for (const file of this.moduleFiles) {
        yield {
          id: `module:${file}`,
          type: 'MODULE',
          nodeType: 'MODULE',
          name: file.split('/').pop() || file,
          file,
          line: 1,
          column: 0,
          metadata: '{}',
        };
      }
    }
    // No ISSUE nodes in this fixture.
  }
}

describe('CoverageAnalyzer — symlinked project root (REG-408 class)', () => {
  let realRoot; // canonical (realpath'd) directory the files actually live in
  let linkRoot; // symlink pointing at realRoot — the un-normalized "project root"

  beforeEach(() => {
    // Canonicalize first: tmpdir() itself may be a symlink (macOS), and we want
    // realRoot to be the canonical target so the symlink delta is purely ours.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cov-real-')));
    realRoot = base;
    mkdirSync(join(realRoot, 'src'), { recursive: true });
    writeFileSync(join(realRoot, 'src', 'index.ts'), 'export const x = 1;');

    linkRoot = join(dirname(realRoot), `cov-link-${process.pid}-${Date.now()}`);
    symlinkSync(realRoot, linkRoot, 'dir');
  });

  afterEach(() => {
    if (linkRoot && existsSync(linkRoot)) rmSync(linkRoot, { force: true });
    if (realRoot && existsSync(realRoot)) rmSync(realRoot, { recursive: true, force: true });
  });

  it('does not double-count a file when the root is a symlink', async () => {
    // Graph stores the canonical ABSOLUTE module path (what the analyzer emits).
    const graph = new FakeGraph([join(realRoot, 'src', 'index.ts')]);

    // Caller passes the SYMLINK path un-normalized (as coverage.ts / MCP do).
    const analyzer = new CoverageAnalyzer(graph, linkRoot);
    const result = await analyzer.analyze();

    // The single file is analyzed exactly once, never also unreachable.
    assert.strictEqual(result.analyzed.count, 1, 'file should be counted as analyzed once');
    assert.strictEqual(result.unreachable.count, 0, 'analyzed file must not also be unreachable');
    assert.strictEqual(result.total, 1, 'total must not be inflated by double-counting');
    assert.ok(
      result.analyzed.files.includes('src/index.ts'),
      'analyzed file should be reported as the project-relative path',
    );
  });
});

/**
 * Regression: CoverageAnalyzer must treat `.mts`/`.cts` as supported JS/TS files.
 *
 * The orchestrator's authoritative `is_js_ts_file`
 * (`packages/grafema-orchestrator/src/analyzer.rs:325`) indexes EIGHT JS/TS
 * extensions:
 *
 *   js | jsx | ts | tsx | mjs | cjs | mts | cts
 *
 * but CoverageAnalyzer's `JS_SUPPORTED` listed only six, omitting `.mts`/`.cts`.
 * Because `CODE_EXTENSIONS` (the disk-scan filter) derives from `JS_SUPPORTED`,
 * a `.mts`/`.cts` file present on disk but NOT in the graph — the `unreachable`
 * category — was never scanned, so it vanished from `total` entirely. That
 * silently INFLATES the reported coverage percentage: the very files Grafema
 * failed to analyze are the ones it should be surfacing as a coverage gap.
 *
 * This test is hermetic — no analyzer binary, no `grafema analyze`, no rfdb
 * server. It feeds a fake graph (mirroring how the symlink-root regression test
 * does) and real on-disk fixture files.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CoverageAnalyzer } from '@grafema/util';

/**
 * Minimal GraphBackend stand-in yielding MODULE/ISSUE nodes the analyzer queries
 * via `queryNodes({ type })`. MODULE file paths are canonical ABSOLUTE paths,
 * matching what the real analyzer emits.
 */
class FakeGraph {
  constructor(moduleAbsoluteFiles = []) {
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
    // No ISSUE nodes in these fixtures.
  }
}

describe('CoverageAnalyzer — .mts/.cts are supported JS/TS extensions', () => {
  let root;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cov-mts-')));
    mkdirSync(join(root, 'src'), { recursive: true });
  });

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('reports on-disk .mts/.cts files not in the graph as unreachable', async () => {
    // Three supported source files on disk, none in the graph.
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;'); // control
    writeFileSync(join(root, 'src', 'esm.mts'), 'export const y = 2;');
    writeFileSync(join(root, 'src', 'cjs.cts'), 'export const z = 3;');

    const analyzer = new CoverageAnalyzer(new FakeGraph(), root);
    const result = await analyzer.analyze();

    assert.strictEqual(result.total, 3, 'all three supported files must be counted');
    assert.strictEqual(result.unreachable.count, 3, 'all three are supported-but-not-in-graph');
    assert.strictEqual(result.unsupported.count, 0, '.mts/.cts must not be reported as unsupported');
    assert.ok(
      result.unreachable.byExtension['.mts'],
      '.mts must appear in the unreachable extension breakdown',
    );
    assert.ok(
      result.unreachable.byExtension['.cts'],
      '.cts must appear in the unreachable extension breakdown',
    );
  });

  it('does not inflate coverage % by dropping an unreachable .mts file', async () => {
    // One analyzed .ts (MODULE node) + one .mts on disk that was NOT analyzed.
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;');
    writeFileSync(join(root, 'src', 'esm.mts'), 'export const y = 2;');

    const graph = new FakeGraph([join(root, 'src', 'index.ts')]);
    const analyzer = new CoverageAnalyzer(graph, root);
    const result = await analyzer.analyze();

    assert.strictEqual(result.analyzed.count, 1, 'the .ts file is analyzed');
    assert.strictEqual(result.unreachable.count, 1, 'the unreachable .mts must be counted');
    assert.strictEqual(result.total, 2, 'both files contribute to total');
    assert.strictEqual(
      result.percentages.analyzed,
      50,
      'coverage must be 50%, not inflated to 100% by dropping the .mts file',
    );
  });
});

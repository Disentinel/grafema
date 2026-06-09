/**
 * Regression: CoverageAnalyzer must treat `.mts` / `.cts` as supported JS/TS
 * extensions, because the Rust orchestrator's `is_js_ts_file`
 * (`packages/grafema-orchestrator/src/analyzer.rs`) analyzes and indexes them:
 *
 * ```rust
 * matches!(ext, "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts")
 * ```
 *
 * CoverageAnalyzer's `JS_SUPPORTED` list omitted `.mts`/`.cts`. That list feeds
 * BOTH `SUPPORTED_EXTENSIONS` (the unsupported-vs-unreachable classifier) AND
 * `CODE_EXTENSIONS` (the on-disk file scanner). Consequence: an `.mts`/`.cts`
 * source file that the orchestrator WOULD analyze but is missing from the graph
 * was not even scanned — it vanished from coverage entirely (not in `total`,
 * not `unreachable`, not `unsupported`), so the reported coverage percentage
 * silently ignored real source files.
 *
 * Hermetic: a fake graph + a temp directory on disk, no analyzer binary / rfdb.
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

/** Minimal GraphBackend stand-in yielding the given MODULE files (absolute). */
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

describe('CoverageAnalyzer — .mts/.cts are supported extensions', () => {
  let root;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cov-mtscts-')));
    mkdirSync(join(root, 'src'), { recursive: true });
  });

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('classifies an unanalyzed .mts file as unreachable, not dropped from coverage', async () => {
    // One analyzed .ts file (in graph) + one .mts file on disk that the graph
    // does NOT know about (the orchestrator supports .mts, so a missing one is a
    // real coverage gap = unreachable, never silently omitted).
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;');
    writeFileSync(join(root, 'src', 'mod.mts'), 'export const y = 2;');

    const graph = new FakeGraph([join(root, 'src', 'index.ts')]);
    const result = await new CoverageAnalyzer(graph, root).analyze();

    assert.strictEqual(result.analyzed.count, 1, 'the .ts file is analyzed');
    assert.strictEqual(
      result.unreachable.count,
      1,
      'the on-disk .mts file the graph lacks must be reported as unreachable',
    );
    assert.ok(
      result.unreachable.files.includes('src/mod.mts'),
      'the .mts file must appear in the unreachable list',
    );
    assert.ok(
      !('.mts' in result.unsupported.byExtension),
      '.mts must not be reported as an unsupported language',
    );
    assert.strictEqual(result.total, 2, 'both files must be counted in total');
  });

  it('classifies an unanalyzed .cts file as unreachable, not dropped from coverage', async () => {
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;');
    writeFileSync(join(root, 'src', 'legacy.cts'), 'export = 3;');

    const graph = new FakeGraph([join(root, 'src', 'index.ts')]);
    const result = await new CoverageAnalyzer(graph, root).analyze();

    assert.strictEqual(result.unreachable.count, 1, 'the .cts file is unreachable');
    assert.ok(
      result.unreachable.files.includes('src/legacy.cts'),
      'the .cts file must appear in the unreachable list',
    );
    assert.ok(
      !('.cts' in result.unsupported.byExtension),
      '.cts must not be reported as an unsupported language',
    );
    assert.strictEqual(result.total, 2, 'both files must be counted in total');
  });

  it('counts an analyzed .mts file (MODULE node present) as analyzed', async () => {
    writeFileSync(join(root, 'src', 'mod.mts'), 'export const y = 2;');

    const graph = new FakeGraph([join(root, 'src', 'mod.mts')]);
    const result = await new CoverageAnalyzer(graph, root).analyze();

    assert.strictEqual(result.analyzed.count, 1, 'the .mts file is analyzed');
    assert.ok(result.analyzed.files.includes('src/mod.mts'));
    assert.strictEqual(result.unreachable.count, 0);
    assert.strictEqual(result.total, 1);
  });
});

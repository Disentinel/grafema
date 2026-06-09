/**
 * Regression: CoverageAnalyzer must treat `.mts` / `.cts` as supported JS/TS
 * extensions, matching the orchestrator's authoritative `is_js_ts_file`
 * (`packages/grafema-orchestrator/src/analyzer.rs` — `js | jsx | ts | tsx |
 * mjs | cjs | mts | cts`).
 *
 * Before this fix, `JS_SUPPORTED` in `packages/util/src/core/CoverageAnalyzer.ts`
 * was `['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']` — it omitted `.mts` and
 * `.cts`. Because `CODE_EXTENSIONS` (the scan whitelist) is built by spreading
 * `JS_SUPPORTED`, a `.mts` / `.cts` source file was not even recognized as a
 * code file during `scanProjectFiles()`. The consequence: an UNANALYZED
 * `.mts` / `.cts` file (one the orchestrator did NOT turn into a MODULE node)
 * was completely invisible to `grafema coverage` / the MCP `get_coverage`
 * handler — not counted in `total`, never reported as `unreachable`. Coverage
 * silently under-reported the very gap it exists to surface.
 *
 * This test is hermetic — a mock graph backend + a temp dir, no analyzer
 * binary, no `grafema analyze`, no rfdb server.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';

import { CoverageAnalyzer } from '@grafema/util';

/**
 * Minimal GraphBackend stand-in that yields MODULE nodes for the given files.
 * Mirrors the mock used by the existing CoverageAnalyzer tests; only the
 * `queryNodes` async generator is exercised by the analyzer.
 */
class MockGraphBackend {
  constructor(moduleFiles = []) {
    this.nodes = new Map();
    for (const file of moduleFiles) {
      const id = `module:${file}`;
      this.nodes.set(id, {
        id,
        type: 'MODULE',
        nodeType: 'MODULE',
        name: file.split('/').pop() || file,
        file,
        line: 1,
        column: 0,
        metadata: '{}',
      });
    }
  }

  async *queryNodes(filter) {
    for (const node of this.nodes.values()) {
      if (filter.type && node.type !== filter.type) continue;
      if (filter.nodeType && node.nodeType !== filter.nodeType) continue;
      yield node;
    }
  }
}

describe('CoverageAnalyzer .mts/.cts support', () => {
  let testDir;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'grafema-coverage-mtscts-'));
    mkdirSync(join(testDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('classifies an UNANALYZED .mts source file as unreachable, not invisible', async () => {
    writeFileSync(join(testDir, 'src', 'config.mts'), 'export const x = 1;');

    // Empty graph: the file was never analyzed.
    const graph = new MockGraphBackend([]);

    const analyzer = new CoverageAnalyzer(graph, testDir);
    const result = await analyzer.analyze();

    // Before the fix: total === 0 and unreachable.count === 0 (file dropped).
    assert.strictEqual(result.total, 1, '.mts file must be counted in total');
    assert.strictEqual(result.unreachable.count, 1, '.mts file must be unreachable');
    assert.ok(
      result.unreachable.byExtension['.mts'],
      '.mts must be grouped under a supported (unreachable) extension'
    );
    assert.strictEqual(
      result.unsupported.count,
      0,
      '.mts must NOT be classified as unsupported'
    );
  });

  it('classifies an UNANALYZED .cts source file as unreachable, not invisible', async () => {
    writeFileSync(join(testDir, 'src', 'legacy.cts'), 'export = {};');

    const graph = new MockGraphBackend([]);

    const analyzer = new CoverageAnalyzer(graph, testDir);
    const result = await analyzer.analyze();

    assert.strictEqual(result.total, 1, '.cts file must be counted in total');
    assert.strictEqual(result.unreachable.count, 1, '.cts file must be unreachable');
    assert.ok(
      result.unreachable.byExtension['.cts'],
      '.cts must be grouped under a supported (unreachable) extension'
    );
    assert.strictEqual(result.unsupported.count, 0);
  });

  it('counts an ANALYZED .mts file (MODULE node) as analyzed', async () => {
    writeFileSync(join(testDir, 'src', 'config.mts'), 'export const x = 1;');

    const rel = relative(testDir, join(testDir, 'src', 'config.mts'));
    const graph = new MockGraphBackend([rel]);

    const analyzer = new CoverageAnalyzer(graph, testDir);
    const result = await analyzer.analyze();

    assert.strictEqual(result.analyzed.count, 1, '.mts MODULE node must be analyzed');
    assert.strictEqual(result.unreachable.count, 0);
    assert.strictEqual(result.percentages.analyzed, 100);
  });
});

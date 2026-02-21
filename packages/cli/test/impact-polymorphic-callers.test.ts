/**
 * Tests for `grafema impact` with polymorphic/hierarchy-aware caller detection - REG-543
 *
 * Problem: `grafema impact "addNode"` shows 0 callers when the method is called
 * through an abstract/interface-typed receiver (e.g., a function parameter typed as
 * the base class or interface). MethodCallResolver cannot resolve these calls, so no
 * CALLS edge exists. The fix expands the target set via CHA (Class Hierarchy Analysis)
 * and falls back to findByAttr for unresolved CALL nodes.
 *
 * Test scenarios:
 * 1. JS class hierarchy: subclass method called via untyped parameter
 * 2. Unresolved call fallback: no hierarchy, bare method name match via findByAttr
 * 3. Known false positives: unrelated classes with same method name (documented behavior)
 * 4. Regression: CLASS target (`grafema impact "GraphBackend"`) still works
 *
 * Pattern matches: impact-class.test.ts (same project)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../dist/cli.js');

/**
 * Helper to run CLI command and capture output.
 * Uses spawnSync for simplicity (matches impact-class.test.ts pattern).
 */
function runCli(
  args: string[],
  cwd: string
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * Helper: create a project directory with package.json, run init + analyze.
 * Returns the temp directory path.
 */
function initAndAnalyze(tempDir: string): void {
  writeFileSync(
    join(tempDir, 'package.json'),
    JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/index.js' })
  );

  const initResult = runCli(['init'], tempDir);
  assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

  const analyzeResult = runCli(['analyze', '--auto-start'], tempDir);
  assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
}

// =============================================================================
// TESTS: grafema impact for polymorphic/hierarchy-aware callers (REG-543)
// =============================================================================

describe('grafema impact: polymorphic caller detection (REG-543)', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gfm-poly-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // Test 1: JS class hierarchy -- primary REG-543 fix
  //
  // Scenario: RFDBServerBackend extends GraphBackend, both define addNode().
  // A service function calls graph.addNode() where `graph` is an untyped
  // parameter. MethodCallResolver cannot resolve this call (no INSTANCE_OF
  // for parameter-typed receivers), so no CALLS edge exists.
  //
  // Expected behavior after fix:
  // - expandTargetSet walks DERIVES_FROM from RFDBServerBackend to GraphBackend
  // - findByAttr({ nodeType: 'CALL', method: 'addNode' }) catches the
  //   unresolved call site in useGraph
  // - useGraph appears as a direct caller
  // ===========================================================================

  describe('JS class hierarchy with untyped parameter calls', () => {
    async function setupHierarchyProject(): Promise<void> {
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);

      // Base class with addNode method
      writeFileSync(
        join(srcDir, 'base.js'),
        `
class GraphBackend {
  addNode(node) {
    return node;
  }
}

module.exports = { GraphBackend };
`
      );

      // Subclass overriding addNode
      writeFileSync(
        join(srcDir, 'impl.js'),
        `
const { GraphBackend } = require('./base');

class RFDBServerBackend extends GraphBackend {
  addNode(node) {
    return { ...node, stored: true };
  }
}

module.exports = { RFDBServerBackend };
`
      );

      // Service calling addNode on an untyped parameter
      writeFileSync(
        join(srcDir, 'service.js'),
        `
function useGraph(graph) {
  graph.addNode({ id: '1', type: 'FUNCTION' });
}

module.exports = { useGraph };
`
      );

      // Entry point so JSModuleIndexer follows imports to all fixture files
      writeFileSync(
        join(srcDir, 'index.js'),
        `require('./impl');\nrequire('./service');\n`
      );

      initAndAnalyze(tempDir);
    }

    it('should find useGraph as a caller of addNode (not 0 direct callers)', async () => {
      await setupHierarchyProject();

      const result = runCli(['impact', 'addNode'], tempDir);

      assert.strictEqual(result.status, 0, `impact command failed: ${result.stderr}`);

      const output = result.stdout;

      // Core assertion: must NOT show 0 direct callers
      assert.ok(
        !output.includes('0 direct callers'),
        `Should NOT show 0 direct callers. Got:\n${output}`
      );

      // Should show at least 1 direct caller
      const match = output.match(/(\d+)\s+direct\s+callers/);
      assert.ok(match, `Should show direct callers count. Got:\n${output}`);

      const count = parseInt(match![1], 10);
      assert.ok(
        count >= 1,
        `Should have at least 1 direct caller (got ${count})`
      );

      // useGraph should appear somewhere in the output
      assert.ok(
        output.includes('useGraph'),
        `useGraph should appear as a caller. Got:\n${output}`
      );
    });

    it('should find useGraph in JSON output', async () => {
      await setupHierarchyProject();

      const result = runCli(['impact', 'addNode', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `impact --json failed: ${result.stderr}`);

      let parsed: any;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(result.stdout);
      }, `Output should be valid JSON. Got: ${result.stdout}`);

      assert.ok(
        parsed.directCallers > 0,
        `JSON directCallers should be > 0 (got ${parsed.directCallers})`
      );

      // Verify call chains mention useGraph
      const allChainNames = (parsed.callChains || []).flat();
      assert.ok(
        allChainNames.includes('useGraph') || result.stdout.includes('useGraph'),
        `useGraph should appear in call chains or output. Got: ${result.stdout}`
      );
    });
  });

  // ===========================================================================
  // Test 2: Unresolved call fallback -- no hierarchy
  //
  // Scenario: A single class with addNode, and a function calling addNode on
  // an untyped parameter. No class hierarchy exists (no DERIVES_FROM edges).
  // expandTargetSet returns only the original target. The findByAttr fallback
  // must find the unresolved CALL node by bare method name.
  // ===========================================================================

  describe('Unresolved call fallback without class hierarchy', () => {
    async function setupNoHierarchyProject(): Promise<void> {
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);

      // Single class with addNode
      writeFileSync(
        join(srcDir, 'backend.js'),
        `
class GraphBackend {
  addNode(node) {
    return node;
  }
}

module.exports = { GraphBackend };
`
      );

      // Service calling addNode on an untyped parameter (no INSTANCE_OF)
      writeFileSync(
        join(srcDir, 'service.js'),
        `
function useGraph(graph) {
  graph.addNode({ id: '1' });
}

module.exports = { useGraph };
`
      );

      // Entry point so JSModuleIndexer follows imports to all fixture files
      writeFileSync(
        join(srcDir, 'index.js'),
        `require('./backend');\nrequire('./service');\n`
      );

      initAndAnalyze(tempDir);
    }

    it('should find useGraph via findByAttr fallback even without hierarchy', async () => {
      await setupNoHierarchyProject();

      const result = runCli(['impact', 'addNode'], tempDir);

      assert.strictEqual(result.status, 0, `impact command failed: ${result.stderr}`);

      const output = result.stdout;

      // useGraph should appear as caller via findByAttr fallback
      assert.ok(
        output.includes('useGraph'),
        `useGraph should appear as caller via findByAttr. Got:\n${output}`
      );

      assert.ok(
        !output.includes('0 direct callers'),
        `Should NOT show 0 direct callers. Got:\n${output}`
      );
    });
  });

  // ===========================================================================
  // Test 3: Known false positives -- documented behavior
  //
  // Scenario: Two unrelated classes (TreeBackend, GraphBackend) both define
  // addNode(). A function useTree() calls tree.addNode(). When analyzing
  // impact of "addNode" (targeting GraphBackend.addNode), findByAttr matches
  // ALL CALL nodes with method="addNode", including the one in useTree.
  //
  // This is EXPECTED and DOCUMENTED behavior. The findByAttr fallback is
  // intentionally broad (sound but imprecise). We do NOT assert that useTree
  // is absent -- it WILL appear. We only verify the command doesn't crash
  // and produces output.
  // ===========================================================================

  describe('Known false positives from unrelated classes (documented behavior)', () => {
    async function setupCrossClassProject(): Promise<void> {
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);

      // Two unrelated classes with same method name
      writeFileSync(
        join(srcDir, 'tree.js'),
        `
class TreeBackend {
  addNode(node) {
    return node;
  }
}

module.exports = { TreeBackend };
`
      );

      writeFileSync(
        join(srcDir, 'graph.js'),
        `
class GraphBackend {
  addNode(node) {
    return node;
  }
}

module.exports = { GraphBackend };
`
      );

      // Only useTree calls addNode -- on a TreeBackend, not GraphBackend
      writeFileSync(
        join(srcDir, 'service.js'),
        `
function useTree(tree) {
  tree.addNode({ id: '1' });
}

module.exports = { useTree };
`
      );

      // Entry point so JSModuleIndexer follows imports to all fixture files
      writeFileSync(
        join(srcDir, 'index.js'),
        `require('./tree');\nrequire('./graph');\nrequire('./service');\n`
      );

      initAndAnalyze(tempDir);
    }

    it('should not crash and should produce output (false positives are acceptable)', async () => {
      await setupCrossClassProject();

      const result = runCli(['impact', 'addNode'], tempDir);

      assert.strictEqual(result.status, 0, `impact command failed: ${result.stderr}`);

      const output = result.stdout;

      // Verify we get valid output (not an error or empty)
      assert.ok(
        output.includes('direct callers') || output.includes('addNode'),
        `Should produce valid impact output. Got:\n${output}`
      );

      // NOTE: useTree WILL appear as a caller because findByAttr matches by
      // bare method name only (not by class). This is expected and documented.
      // The findByAttr fallback is intentionally conservative (sound but imprecise).
      // Do NOT add: assert.ok(!output.includes('useTree'), ...)
    });

    it('should produce valid JSON with false positives included', async () => {
      await setupCrossClassProject();

      const result = runCli(['impact', 'addNode', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `impact --json failed: ${result.stderr}`);

      let parsed: any;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(result.stdout);
      }, `Output should be valid JSON. Got: ${result.stdout}`);

      // directCallers should be a valid number
      assert.ok(
        typeof parsed.directCallers === 'number',
        `directCallers should be a number. Got: ${typeof parsed.directCallers}`
      );

      // NOTE: parsed.directCallers may include useTree as a false positive.
      // This is expected behavior.
    });
  });

  // ===========================================================================
  // Test 4: Regression -- CLASS target still works
  //
  // Verify that `grafema impact "GraphBackend"` (targeting a class, not a
  // method) still works correctly. The fix only modifies the non-CLASS
  // target path; CLASS targets should continue using the existing
  // getClassMethods aggregation logic unchanged.
  // ===========================================================================

  describe('Regression: CLASS target still works', () => {
    async function setupClassTargetProject(): Promise<void> {
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);

      // Class with methods
      writeFileSync(
        join(srcDir, 'backend.js'),
        `
class GraphBackend {
  addNode(node) {
    return node;
  }

  removeNode(id) {
    return true;
  }
}

module.exports = { GraphBackend };
`
      );

      // Service that uses GraphBackend via direct instantiation
      writeFileSync(
        join(srcDir, 'service.js'),
        `
const { GraphBackend } = require('./backend');

function buildGraph() {
  const backend = new GraphBackend();
  backend.addNode({ id: '1' });
  backend.removeNode('2');
}

module.exports = { buildGraph };
`
      );

      // Entry point so JSModuleIndexer follows imports to all fixture files
      writeFileSync(
        join(srcDir, 'index.js'),
        `require('./service');\n`
      );

      initAndAnalyze(tempDir);
    }

    it('should find callers when targeting class name with "class" prefix', async () => {
      await setupClassTargetProject();

      const result = runCli(['impact', 'class GraphBackend'], tempDir);

      assert.strictEqual(result.status, 0, `impact command failed: ${result.stderr}`);

      const output = result.stdout;

      // Should show the class name in output
      assert.ok(
        output.includes('GraphBackend'),
        `Should reference GraphBackend in output. Got:\n${output}`
      );

      // Should show direct callers section
      assert.ok(
        output.includes('direct callers'),
        `Should show direct callers section. Got:\n${output}`
      );
    });

    it('should produce valid JSON for class target', async () => {
      await setupClassTargetProject();

      const result = runCli(['impact', 'class GraphBackend', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `impact --json failed: ${result.stderr}`);

      let parsed: any;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(result.stdout);
      }, `Output should be valid JSON. Got: ${result.stdout}`);

      // Target should be GraphBackend
      assert.ok(
        parsed.target.name === 'GraphBackend' || parsed.target.name.includes('GraphBackend'),
        `Target should be GraphBackend. Got: ${parsed.target.name}`
      );

      // Should have valid structure
      assert.ok(
        typeof parsed.directCallers === 'number',
        `directCallers should be a number. Got: ${typeof parsed.directCallers}`
      );
      assert.ok(
        typeof parsed.transitiveCallers === 'number',
        `transitiveCallers should be a number. Got: ${typeof parsed.transitiveCallers}`
      );
    });

    it('should still aggregate method callers for class target', async () => {
      await setupClassTargetProject();

      const result = runCli(['impact', 'class GraphBackend', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `impact --json failed: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as any;

      // buildGraph calls both addNode and removeNode on GraphBackend
      // and instantiates it. CLASS target aggregation should capture this.
      // At minimum, buildGraph should appear as a caller.
      assert.ok(
        parsed.directCallers >= 1,
        `Should have at least 1 direct caller (buildGraph). Got: ${parsed.directCallers}`
      );
    });
  });

  // ===========================================================================
  // Test 5: Qualified method name targeting
  //
  // Verify that `grafema impact "RFDBServerBackend.addNode"` or just "addNode"
  // both work with the hierarchy expansion. The extractMethodName helper should
  // correctly parse both "RFDBServerBackend.addNode" -> "addNode" and
  // "addNode" -> "addNode".
  // ===========================================================================

  describe('Method name resolution with qualified names', () => {
    async function setupQualifiedNameProject(): Promise<void> {
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);

      writeFileSync(
        join(srcDir, 'base.js'),
        `
class GraphBackend {
  addNode(node) {
    return node;
  }
}

module.exports = { GraphBackend };
`
      );

      writeFileSync(
        join(srcDir, 'impl.js'),
        `
const { GraphBackend } = require('./base');

class RFDBServerBackend extends GraphBackend {
  addNode(node) {
    return { ...node, stored: true };
  }
}

module.exports = { RFDBServerBackend };
`
      );

      writeFileSync(
        join(srcDir, 'service.js'),
        `
function useGraph(graph) {
  graph.addNode({ id: '1' });
}

module.exports = { useGraph };
`
      );

      // Entry point so JSModuleIndexer follows imports to all fixture files
      writeFileSync(
        join(srcDir, 'index.js'),
        `require('./impl');\nrequire('./service');\n`
      );

      initAndAnalyze(tempDir);
    }

    it('should work with bare method name "addNode"', async () => {
      await setupQualifiedNameProject();

      const result = runCli(['impact', 'addNode'], tempDir);

      assert.strictEqual(result.status, 0, `impact command failed: ${result.stderr}`);

      const output = result.stdout;

      // Should find callers regardless of how method name is specified
      assert.ok(
        !output.includes('0 direct callers'),
        `Should find callers with bare method name. Got:\n${output}`
      );
    });

    it('should work with "function addNode" pattern', async () => {
      await setupQualifiedNameProject();

      const result = runCli(['impact', 'function addNode'], tempDir);

      assert.strictEqual(result.status, 0, `impact command failed: ${result.stderr}`);

      const output = result.stdout;

      // When specifying "function addNode", findTarget searches FUNCTION nodes
      // and should find one of the addNode methods. Hierarchy expansion should
      // then find callers.
      assert.ok(
        output.includes('addNode'),
        `Should reference addNode in output. Got:\n${output}`
      );
    });
  });

  // ===========================================================================
  // Test 6: No callers at all (method exists but nobody calls it)
  //
  // Verify that a method with no callers and no hierarchy still correctly
  // shows 0 direct callers (no false expansion).
  // ===========================================================================

  describe('Method with no callers shows 0 correctly', () => {
    it('should show 0 direct callers when nobody calls the method', async () => {
      const srcDir = join(tempDir, 'src');
      mkdirSync(srcDir);

      writeFileSync(
        join(srcDir, 'backend.js'),
        `
class Backend {
  unusedMethod() {
    return 42;
  }
}

module.exports = { Backend };
`
      );

      // Entry point so JSModuleIndexer follows imports to all fixture files
      writeFileSync(
        join(srcDir, 'index.js'),
        `require('./backend');\n`
      );

      initAndAnalyze(tempDir);

      const result = runCli(['impact', 'unusedMethod'], tempDir);

      assert.strictEqual(result.status, 0, `impact command failed: ${result.stderr}`);

      const output = result.stdout;

      // Should show 0 callers -- no false positives from hierarchy expansion
      assert.ok(
        output.includes('0 direct callers'),
        `Should show 0 direct callers for unused method. Got:\n${output}`
      );
    });
  });
});

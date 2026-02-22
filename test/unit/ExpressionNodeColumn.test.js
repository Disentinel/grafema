/**
 * ExpressionNodeColumn Tests (REG-548)
 *
 * Verifies that EXPRESSION nodes store the correct column number
 * (from node.loc.start.column), NOT the absolute byte offset (node.start).
 *
 * Bug: JSASTAnalyzer used `initExpression.start` (byte offset) as column,
 * producing values like 200-600 instead of the real column (~10).
 *
 * Fix: Replace `initExpression.start ?? 0` with `getColumn(initExpression)`
 * at all 10 expression-handling locations.
 *
 * Test design: A padding block of variable declarations pushes byte offsets
 * well above 200 while the actual expressions sit at column 10 (0-based).
 * With the bug, column values would be > 200; after the fix, they are 10.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(cleanupAllTestDatabases);

import { createTestOrchestrator, analyzeProject } from '../helpers/createTestOrchestrator.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('EXPRESSION node column values (REG-548)', () => {
  let testCounter = 0;

  async function setupTest(files) {
    const testDir = join(tmpdir(), `navi-test-expr-col-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'expr-column-test',
      version: '1.0.0'
    }));

    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(testDir, name), content);
    }

    const db = await createTestDatabase();
    const backend = db.backend;

    await analyzeProject(backend, testDir);
    await backend.flush();

    return { backend, testDir };
  }

  async function cleanup(backend, testDir) {
    await backend.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  /**
   * Helper: find all EXPRESSION nodes of a given expressionType.
   */
  async function findExpressionNodes(backend, expressionType) {
    const results = [];
    for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
      if (node.expressionType === expressionType) {
        results.push(node);
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Fixture: padding lines push byte offsets past 200, expressions at column 10
  // ---------------------------------------------------------------------------
  //
  // The fixture starts with variable declarations that consume bytes but keep
  // our target expressions on short lines with predictable column positions.
  //
  // Each expression line has the form:
  //   const X = <expression>;
  //   0123456789|
  //             ^ column 10 (0-based)
  //
  // So every expression starts at column 10.
  //
  // The padding ensures the first expression's byte offset (node.start) is > 200.

  const FIXTURE = [
    // Padding: 10 variable declarations to push byte offset past 200
    'const pad1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
    'const pad2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";',
    'const pad3 = "cccccccccccccccccccccccccccccc";',
    'const pad4 = "dddddddddddddddddddddddddddddd";',
    'const pad5 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeee";',
    '',
    // Source variables used in expressions
    'const obj = { prop: 1 };',
    'const x = 1;',
    'const y = 2;',
    'const flag = true;',
    '',
    // Expression lines — each expression starts at column 10
    // MemberExpression: "obj.prop" starts at column 10
    'const m = obj.prop;',
    // BinaryExpression: "x + y" starts at column 10
    'const b = x + y;',
    // LogicalExpression: "x && y" starts at column 10
    'const l = x && y;',
    // ConditionalExpression: "x ? y : flag" starts at column 10
    'const c = x ? y : flag;',
    // UnaryExpression: "!flag" starts at column 10
    'const u = !flag;',
    // TemplateLiteral: "`${x} hello`" starts at column 10
    'const t = `${x} hello`;',
    // OptionalMemberExpression: "obj?.prop" starts at column 10
    'const o = obj?.prop;',
  ].join('\n');

  // Expected column for ALL expressions: 10 (0-based)
  const EXPECTED_COLUMN = 10;

  describe('MemberExpression column', () => {
    it('should have column 10, not absolute byte offset', async () => {
      const { backend, testDir } = await setupTest({ 'index.js': FIXTURE });

      try {
        const nodes = await findExpressionNodes(backend, 'MemberExpression');
        // Filter to the non-optional one (obj.prop, not obj?.prop)
        const node = nodes.find(n => n.name === 'obj.prop' && !n.id.includes('OptionalMemberExpression'));
        assert.ok(node, 'Should find MemberExpression EXPRESSION node for obj.prop');
        assert.strictEqual(node.column, EXPECTED_COLUMN,
          `MemberExpression column should be ${EXPECTED_COLUMN} (0-based), got ${node.column}`);
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('BinaryExpression column', () => {
    it('should have column 10, not absolute byte offset', async () => {
      const { backend, testDir } = await setupTest({ 'index.js': FIXTURE });

      try {
        const nodes = await findExpressionNodes(backend, 'BinaryExpression');
        assert.ok(nodes.length >= 1, 'Should find BinaryExpression EXPRESSION node');
        const node = nodes[0];
        assert.strictEqual(node.column, EXPECTED_COLUMN,
          `BinaryExpression column should be ${EXPECTED_COLUMN} (0-based), got ${node.column}`);
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('LogicalExpression column', () => {
    it('should have column 10, not absolute byte offset', async () => {
      const { backend, testDir } = await setupTest({ 'index.js': FIXTURE });

      try {
        const nodes = await findExpressionNodes(backend, 'LogicalExpression');
        assert.ok(nodes.length >= 1, 'Should find LogicalExpression EXPRESSION node');
        const node = nodes[0];
        assert.strictEqual(node.column, EXPECTED_COLUMN,
          `LogicalExpression column should be ${EXPECTED_COLUMN} (0-based), got ${node.column}`);
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('ConditionalExpression column', () => {
    it('should have column 10, not absolute byte offset', async () => {
      const { backend, testDir } = await setupTest({ 'index.js': FIXTURE });

      try {
        const nodes = await findExpressionNodes(backend, 'ConditionalExpression');
        assert.ok(nodes.length >= 1, 'Should find ConditionalExpression EXPRESSION node');
        const node = nodes[0];
        assert.strictEqual(node.column, EXPECTED_COLUMN,
          `ConditionalExpression column should be ${EXPECTED_COLUMN} (0-based), got ${node.column}`);
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('UnaryExpression column', () => {
    it('should have column 10, not absolute byte offset', async () => {
      const { backend, testDir } = await setupTest({ 'index.js': FIXTURE });

      try {
        const nodes = await findExpressionNodes(backend, 'UnaryExpression');
        assert.ok(nodes.length >= 1, 'Should find UnaryExpression EXPRESSION node');
        const node = nodes[0];
        assert.strictEqual(node.column, EXPECTED_COLUMN,
          `UnaryExpression column should be ${EXPECTED_COLUMN} (0-based), got ${node.column}`);
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('TemplateLiteral column', () => {
    it('should have column 10, not absolute byte offset', async () => {
      const { backend, testDir } = await setupTest({ 'index.js': FIXTURE });

      try {
        const nodes = await findExpressionNodes(backend, 'TemplateLiteral');
        assert.ok(nodes.length >= 1, 'Should find TemplateLiteral EXPRESSION node');
        const node = nodes[0];
        assert.strictEqual(node.column, EXPECTED_COLUMN,
          `TemplateLiteral column should be ${EXPECTED_COLUMN} (0-based), got ${node.column}`);
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('OptionalMemberExpression column', () => {
    it('should have column 10, not absolute byte offset', async () => {
      const { backend, testDir } = await setupTest({ 'index.js': FIXTURE });

      try {
        // OptionalMemberExpression may be stored as MemberExpression with optional flag
        // or as its own type — check both
        let node = null;
        const optNodes = await findExpressionNodes(backend, 'OptionalMemberExpression');
        if (optNodes.length > 0) {
          node = optNodes[0];
        } else {
          // Babel may parse obj?.prop as MemberExpression with optional: true
          const memberNodes = await findExpressionNodes(backend, 'MemberExpression');
          node = memberNodes.find(n => n.name === 'obj?.prop' || (n.object === 'obj' && n.property === 'prop' && n.id !== memberNodes[0]?.id));
          // If there are two MemberExpression nodes, the second one is the optional one
          if (!node && memberNodes.length >= 2) {
            node = memberNodes[1];
          }
        }

        assert.ok(node, 'Should find OptionalMemberExpression EXPRESSION node for obj?.prop');
        assert.strictEqual(node.column, EXPECTED_COLUMN,
          `OptionalMemberExpression column should be ${EXPECTED_COLUMN} (0-based), got ${node.column}`);
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('Column in node ID', () => {
    it('should embed correct column in EXPRESSION node IDs', async () => {
      const { backend, testDir } = await setupTest({ 'index.js': FIXTURE });

      try {
        // Collect all EXPRESSION nodes and verify their IDs contain the correct column
        const allExpressions = [];
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          allExpressions.push(node);
        }

        assert.ok(allExpressions.length >= 7,
          `Should find at least 7 EXPRESSION nodes, got ${allExpressions.length}`);

        // Every EXPRESSION node ID should end with :line:column where column is small
        // ID format: {file}:EXPRESSION:{type}:{line}:{column}
        for (const node of allExpressions) {
          const parts = node.id.split(':');
          const idColumn = parseInt(parts[parts.length - 1], 10);
          assert.ok(idColumn < 100,
            `EXPRESSION node ID should contain a column < 100, ` +
            `got ${idColumn} in ID "${node.id}" — this suggests byte offset was used instead of column`);
          // Also verify consistency: id column should match node.column
          assert.strictEqual(idColumn, node.column,
            `ID column (${idColumn}) should match node.column (${node.column}) for ${node.expressionType}`);
        }
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });
});

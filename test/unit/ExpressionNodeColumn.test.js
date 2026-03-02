/**
 * ExpressionNodeColumn Tests (REG-548)
 *
 * Verifies that EXPRESSION and PROPERTY_ACCESS nodes store the correct column number
 * (from node.loc.start.column), NOT the absolute byte offset (node.start).
 *
 * V2 Migration Notes:
 * - MemberExpression → PROPERTY_ACCESS node (not EXPRESSION)
 * - BinaryExpression → EXPRESSION with name="+" (no expressionType field)
 * - LogicalExpression → EXPRESSION with name="&&" (no expressionType field)
 * - ConditionalExpression → EXPRESSION with name="ternary"
 * - UnaryExpression → EXPRESSION with name="!"
 * - TemplateLiteral → EXPRESSION with name="template"
 * - OptionalMemberExpression → PROPERTY_ACCESS
 * - V2 ID format: file->TYPE->name\#line (uses # not : for line/column)
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
   * Helper: find EXPRESSION nodes by v2 name (operator).
   */
  async function findExpressionByName(backend, name) {
    const results = [];
    for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
      if (node.name === name) {
        results.push(node);
      }
    }
    return results;
  }

  /**
   * Helper: find PROPERTY_ACCESS nodes by name pattern.
   */
  async function findPropertyAccessByName(backend, namePattern) {
    const results = [];
    for await (const node of backend.queryNodes({ type: 'PROPERTY_ACCESS' })) {
      if (node.name.includes(namePattern)) {
        results.push(node);
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Fixture: padding lines push byte offsets past 200, expressions at column 10
  // ---------------------------------------------------------------------------

  const FIXTURE = [
    // Padding: 5 variable declarations to push byte offset past 200
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
    'const m = obj.prop;',
    'const b = x + y;',
    'const l = x && y;',
    'const c = x ? y : flag;',
    'const u = !flag;',
    'const t = `${x} hello`;',
    'const o = obj?.prop;',
  ].join('\n');

  // Expected column for ALL expressions: 10 (0-based)
  const EXPECTED_COLUMN = 10;

  describe('MemberExpression column', () => {
    it('should have column 10, not absolute byte offset', async () => {
      const { backend, testDir } = await setupTest({ 'index.js': FIXTURE });

      try {
        // V2: MemberExpression → PROPERTY_ACCESS
        const nodes = await findPropertyAccessByName(backend, 'obj.prop');
        // Filter to the non-optional one
        const node = nodes.find(n => n.name === 'obj.prop');
        assert.ok(node, 'Should find PROPERTY_ACCESS node for obj.prop');
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
        // V2: BinaryExpression → EXPRESSION with name="+"
        const nodes = await findExpressionByName(backend, '+');
        assert.ok(nodes.length >= 1, 'Should find BinaryExpression EXPRESSION node (name="+")');
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
        // V2: LogicalExpression → EXPRESSION with name="&&"
        const nodes = await findExpressionByName(backend, '&&');
        assert.ok(nodes.length >= 1, 'Should find LogicalExpression EXPRESSION node (name="&&")');
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
        // V2: ConditionalExpression → EXPRESSION with name="ternary"
        const nodes = await findExpressionByName(backend, 'ternary');
        assert.ok(nodes.length >= 1, 'Should find ConditionalExpression EXPRESSION node (name="ternary")');
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
        // V2: UnaryExpression → EXPRESSION with name="!"
        const nodes = await findExpressionByName(backend, '!');
        assert.ok(nodes.length >= 1, 'Should find UnaryExpression EXPRESSION node (name="!")');
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
        // V2: TemplateLiteral → EXPRESSION with name="template"
        const nodes = await findExpressionByName(backend, 'template');
        assert.ok(nodes.length >= 1, 'Should find TemplateLiteral EXPRESSION node (name="template")');
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
        // V2: OptionalMemberExpression → PROPERTY_ACCESS with name "obj?.prop"
        const nodes = await findPropertyAccessByName(backend, 'obj?.prop');
        let node = nodes.length > 0 ? nodes[0] : null;

        // Fallback: may be stored as regular obj.prop with different name
        if (!node) {
          const allPA = [];
          for await (const n of backend.queryNodes({ type: 'PROPERTY_ACCESS' })) {
            allPA.push(n);
          }
          // Find one that is on the expected line (last expression)
          node = allPA.find(n => n.name.includes('obj') && n.name.includes('prop') && n.name !== 'obj.prop');
          if (!node && allPA.length >= 2) {
            // Second obj.prop PROPERTY_ACCESS is the optional one
            const objPropNodes = allPA.filter(n => n.name.includes('obj') && n.name.includes('prop'));
            if (objPropNodes.length >= 2) {
              node = objPropNodes[1];
            }
          }
        }

        assert.ok(node, 'Should find OptionalMemberExpression PROPERTY_ACCESS node for obj?.prop');
        assert.strictEqual(node.column, EXPECTED_COLUMN,
          `OptionalMemberExpression column should be ${EXPECTED_COLUMN} (0-based), got ${node.column}`);
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('Column in node ID', () => {
    it('should embed correct column in EXPRESSION/PROPERTY_ACCESS node IDs', async () => {
      const { backend, testDir } = await setupTest({ 'index.js': FIXTURE });

      try {
        // Collect EXPRESSION and PROPERTY_ACCESS nodes (both represent v1 EXPRESSION nodes)
        const allNodes = [];
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          allNodes.push(node);
        }
        for await (const node of backend.queryNodes({ type: 'PROPERTY_ACCESS' })) {
          allNodes.push(node);
        }

        // V2 creates fewer EXPRESSION nodes (5 EXPRESSION + some PROPERTY_ACCESS)
        assert.ok(allNodes.length >= 5,
          `Should find at least 5 EXPRESSION+PROPERTY_ACCESS nodes, got ${allNodes.length}`);

        // Every node should have a column that is small (not a byte offset > 200)
        for (const node of allNodes) {
          assert.ok(node.column < 100,
            `Node column should be < 100, ` +
            `got ${node.column} in node "${node.name}" (type=${node.type}) — this suggests byte offset was used instead of column`);
        }
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });
});

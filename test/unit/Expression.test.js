/**
 * Expression Node Tests
 *
 * Tests for EXPRESSION node creation and DERIVES_FROM edges for data flow tracking.
 * Covers: MemberExpression, BinaryExpression, ConditionalExpression, LogicalExpression
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { RFDBServerBackend } from '@grafema/core';
import { createTestOrchestrator, analyzeProject } from '../helpers/createTestOrchestrator.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Expression Node Tests', () => {
  let testCounter = 0;

  async function setupTest(files) {
    const testDir = join(tmpdir(), `navi-test-expression-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    // Write package.json (required for project discovery)
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'expression-test',
      version: '1.0.0'
    }));

    // Write test files
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(testDir, name), content);
    }

    const backend = new RFDBServerBackend({ dbPath: join(testDir, 'test.db') });
    await backend.connect();

    // Run analysis
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

  describe('MemberExpression without call', () => {
    it('should create EXPRESSION node for const m = obj.method', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { method: () => {} };
const m = obj.method;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'MemberExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for MemberExpression');
        assert.strictEqual(expressionNode.object, 'obj', 'Should have object attribute');
        assert.strictEqual(expressionNode.property, 'method', 'Should have property attribute');

        console.log('MemberExpression creates EXPRESSION node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM edge from VARIABLE to EXPRESSION', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { method: () => {} };
const m = obj.method;
`
      });

      try {
        // Find variable 'm'
        let varM = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'm') {
            varM = node;
            break;
          }
        }

        assert.ok(varM, 'Should find variable m');

        // Get outgoing ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(varM.id, ['ASSIGNED_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have one ASSIGNED_FROM edge');

        // Verify it points to EXPRESSION
        const targetNode = await backend.getNode(edges[0].dst);
        assert.strictEqual(targetNode.type, 'EXPRESSION', 'Should point to EXPRESSION node');

        console.log('ASSIGNED_FROM edge created correctly for MemberExpression');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create DERIVES_FROM edge from EXPRESSION to object variable', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { method: () => {} };
const m = obj.method;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'MemberExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should find EXPRESSION node');

        // Get DERIVES_FROM edges
        const edges = await backend.getOutgoingEdges(expressionNode.id, ['DERIVES_FROM']);
        assert.strictEqual(edges.length, 1, 'Should have one DERIVES_FROM edge');

        // Verify it points to obj variable
        const targetNode = await backend.getNode(edges[0].dst);
        assert.strictEqual(targetNode.name, 'obj', 'Should derive from obj variable');

        console.log('DERIVES_FROM edge created correctly for MemberExpression');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should handle computed property access', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { key: 'value' };
const key = 'someKey';
const val = obj[key];
`
      });

      try {
        // Find EXPRESSION node with computed access
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'MemberExpression' && node.computed) {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for computed property');
        assert.strictEqual(expressionNode.computed, true, 'Should have computed=true');
        assert.strictEqual(expressionNode.property, '<computed>', 'Property should be <computed>');

        console.log('Computed property access handled correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('BinaryExpression', () => {
    it('should create EXPRESSION node for const x = a + b', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 1;
const b = 2;
const x = a + b;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'BinaryExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for BinaryExpression');
        assert.strictEqual(expressionNode.operator, '+', 'Should have operator attribute');

        console.log('BinaryExpression creates EXPRESSION node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create DERIVES_FROM edges for both operands', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 1;
const b = 2;
const x = a + b;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'BinaryExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should find EXPRESSION node');

        // Get DERIVES_FROM edges
        const edges = await backend.getOutgoingEdges(expressionNode.id, ['DERIVES_FROM']);
        assert.strictEqual(edges.length, 2, 'Should have two DERIVES_FROM edges');

        // Get target names
        const targetNames = [];
        for (const edge of edges) {
          const target = await backend.getNode(edge.dst);
          targetNames.push(target.name);
        }

        assert.ok(targetNames.includes('a'), 'Should derive from a');
        assert.ok(targetNames.includes('b'), 'Should derive from b');

        console.log('DERIVES_FROM edges created correctly for BinaryExpression');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('ConditionalExpression', () => {
    it('should create EXPRESSION node for const x = cond ? a : b', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const cond = true;
const a = 1;
const b = 2;
const x = cond ? a : b;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'ConditionalExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for ConditionalExpression');

        console.log('ConditionalExpression creates EXPRESSION node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create DERIVES_FROM edges for both branches (not condition)', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const cond = true;
const a = 1;
const b = 2;
const x = cond ? a : b;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'ConditionalExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should find EXPRESSION node');

        // Get DERIVES_FROM edges
        const edges = await backend.getOutgoingEdges(expressionNode.id, ['DERIVES_FROM']);
        assert.strictEqual(edges.length, 2, 'Should have two DERIVES_FROM edges (consequent and alternate)');

        // Get target names
        const targetNames = [];
        for (const edge of edges) {
          const target = await backend.getNode(edge.dst);
          targetNames.push(target.name);
        }

        assert.ok(targetNames.includes('a'), 'Should derive from consequent (a)');
        assert.ok(targetNames.includes('b'), 'Should derive from alternate (b)');
        assert.ok(!targetNames.includes('cond'), 'Should NOT derive from condition (cond)');

        console.log('DERIVES_FROM edges created correctly for ConditionalExpression');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('LogicalExpression', () => {
    it('should create EXPRESSION node for const x = a || b', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = null;
const b = 'default';
const x = a || b;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'LogicalExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for LogicalExpression');
        assert.strictEqual(expressionNode.operator, '||', 'Should have operator attribute');

        console.log('LogicalExpression creates EXPRESSION node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should handle && operator', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = true;
const b = 'value';
const x = a && b;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'LogicalExpression' && node.operator === '&&') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for && operator');

        console.log('&& operator handled correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('Datalog queries for data flow', () => {
    it('should find EXPRESSION nodes via Datalog', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 1;
const b = 2;
const x = a + b;
`
      });

      try {
        // Simple Datalog query to find EXPRESSION nodes
        const results = await backend.checkGuarantee(`
          % Find all EXPRESSION nodes (should find one BinaryExpression)
          violation(X) :- node(X, "EXPRESSION").
        `);

        // Should find one EXPRESSION (the a + b)
        assert.strictEqual(results.length, 1, 'Should find one EXPRESSION node');

        console.log('Datalog EXPRESSION query works correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('Alias tracking via EXPRESSION', () => {
    it('should enable alias tracking via Datalog', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { method: function() {} };
const m = obj.method;
`
      });

      try {
        // Datalog query to find aliases
        // aliasTarget(Var, Object, Property) - Var is an alias for Object.Property
        const results = await backend.checkGuarantee(`
          aliasTarget(Var, Obj, Prop) :-
            node(Var, "VARIABLE"),
            edge(Var, Expr, "ASSIGNED_FROM"),
            node(Expr, "EXPRESSION"),
            attr(Expr, "expressionType", "MemberExpression"),
            attr(Expr, "object", Obj),
            attr(Expr, "property", Prop).

          violation(X) :- aliasTarget(X, _, _).
        `);

        // m should be identified as an alias
        assert.strictEqual(results.length, 1, 'Should find one alias');

        const nodeId = results[0].bindings.find(b => b.name === 'X')?.value;
        const node = await backend.getNode(nodeId);
        assert.strictEqual(node?.name, 'm', 'Alias should be variable m');

        console.log('Alias tracking via EXPRESSION works correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('LogicalExpression', () => {
    it('should create EXPRESSION node for const x = a || b', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 'first';
const b = 'second';
const x = a || b;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'LogicalExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for LogicalExpression');
        assert.strictEqual(expressionNode.operator, '||', 'Should have || operator');

        console.log('LogicalExpression creates EXPRESSION node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM edges for both branches', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 'first';
const b = 'second';
const x = a || b;
`
      });

      try {
        // Find x variable
        let xVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'x') {
            xVar = node;
            break;
          }
        }
        // Also check CONSTANT
        if (!xVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'x') {
              xVar = node;
              break;
            }
          }
        }

        assert.ok(xVar, 'Should find variable x');

        // Get ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(xVar.id, ['ASSIGNED_FROM']);

        // Should have edges to both a and b (via EXPRESSION or directly)
        // At minimum 2: one for EXPRESSION, one for each branch
        assert.ok(edges.length >= 2, `Should have at least 2 ASSIGNED_FROM edges, got ${edges.length}`);

        console.log('LogicalExpression ASSIGNED_FROM edges created correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should handle && operator', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 'first';
const b = 'second';
const x = a && b;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'LogicalExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for && LogicalExpression');
        assert.strictEqual(expressionNode.operator, '&&', 'Should have && operator');

        console.log('LogicalExpression && creates EXPRESSION node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('TemplateLiteral', () => {
    it('should create EXPRESSION node for template literal with expressions', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const table = 'users';
const query = \`SELECT * FROM \${table}\`;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'TemplateLiteral') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for TemplateLiteral');
        assert.strictEqual(expressionNode.name, '<template>', 'Should have <template> as name');

        console.log('TemplateLiteral creates EXPRESSION node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM edges from template to expressions', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const table = 'users';
const id = 42;
const query = \`SELECT * FROM \${table} WHERE id = \${id}\`;
`
      });

      try {
        // Find query variable
        let queryVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'query') {
            queryVar = node;
            break;
          }
        }
        // Also check CONSTANT
        if (!queryVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'query') {
              queryVar = node;
              break;
            }
          }
        }

        assert.ok(queryVar, 'Should find variable query');

        // Get ASSIGNED_FROM edges
        const edges = await backend.getOutgoingEdges(queryVar.id, ['ASSIGNED_FROM']);

        // Should have edges to EXPRESSION and to each template expression (table, id)
        assert.ok(edges.length >= 2, `Should have at least 2 ASSIGNED_FROM edges, got ${edges.length}`);

        console.log('TemplateLiteral ASSIGNED_FROM edges created correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create DERIVES_FROM edges from EXPRESSION to source variables', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const table = 'users';
const id = 42;
const query = \`SELECT * FROM \${table} WHERE id = \${id}\`;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'TemplateLiteral') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should find EXPRESSION node');

        // Get DERIVES_FROM edges
        const edges = await backend.getOutgoingEdges(expressionNode.id, ['DERIVES_FROM']);

        // Should have edges to both table and id variables
        assert.strictEqual(edges.length, 2, 'Should have two DERIVES_FROM edges');

        // Get target names
        const targetNames = [];
        for (const edge of edges) {
          const target = await backend.getNode(edge.dst);
          targetNames.push(target.name);
        }

        assert.ok(targetNames.includes('table'), 'Should derive from table');
        assert.ok(targetNames.includes('id'), 'Should derive from id');

        console.log('TemplateLiteral DERIVES_FROM edges created correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should NOT create EXPRESSION node for simple template without expressions', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const query = \`SELECT * FROM users\`;
`
      });

      try {
        // Find EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'TemplateLiteral') {
            expressionNode = node;
            break;
          }
        }

        // Simple template without expressions should be treated as LITERAL, not EXPRESSION
        assert.ok(!expressionNode, 'Should NOT create EXPRESSION node for simple template');

        console.log('Simple template literal handled as LITERAL correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });
});

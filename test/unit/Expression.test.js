/**
 * Expression Node Tests
 *
 * Tests for EXPRESSION node creation and DERIVES_FROM edges for data flow tracking.
 * Covers: MemberExpression, BinaryExpression, ConditionalExpression, LogicalExpression
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator, analyzeProject } from '../helpers/createTestOrchestrator.js';
import { DataFlowValidator } from '@grafema/core';
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

    const db = await createTestDatabase();
    const backend = db.backend;

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

    it('should use readable name format "a || b" for LogicalExpression', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 'first';
const b = 'second';
const x = a || b;
`
      });

      try {
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'LogicalExpression' && node.operator === '||') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for LogicalExpression');
        assert.strictEqual(expressionNode.name, 'a || b', 'Name should be "a || b" not "<LogicalExpression>"');

        console.log('LogicalExpression || name format is correct:', expressionNode.name);
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create EXPRESSION node for ?? (nullish coalescing) with readable name', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 'first';
const b = 'second';
const x = a ?? b;
`
      });

      try {
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'LogicalExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for ?? LogicalExpression');
        assert.strictEqual(expressionNode.operator, '??', 'Should have ?? operator');
        assert.strictEqual(expressionNode.name, 'a ?? b', 'Name should be "a ?? b"');

        console.log('LogicalExpression ?? creates EXPRESSION node correctly:', expressionNode.name);
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should use readable name format "a && b" for LogicalExpression', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 'first';
const b = 'second';
const x = a && b;
`
      });

      try {
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'LogicalExpression' && node.operator === '&&') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for && LogicalExpression');
        assert.strictEqual(expressionNode.name, 'a && b', 'Name should be "a && b"');

        console.log('LogicalExpression && name format is correct:', expressionNode.name);
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should use fallback "…" for non-Identifier operands in LogicalExpression name', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { timeout: 5000 };
const x = obj.timeout || 10;
`
      });

      try {
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'LogicalExpression' && node.operator === '||') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for LogicalExpression with non-Identifier operands');
        assert.ok(expressionNode.name.includes('||'), 'Name should contain the || operator');
        assert.ok(expressionNode.name.includes('\u2026'), 'Name should contain "…" (U+2026) for non-Identifier operands');
        assert.ok(!expressionNode.name.includes('<LogicalExpression>'), 'Name should NOT be generic "<LogicalExpression>"');

        console.log('LogicalExpression fallback name format is correct:', expressionNode.name);
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create EXPRESSION node with ASSIGNED_FROM and DERIVES_FROM for logical expression', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 'first';
const b = 'second';
const x = a || b;
`
      });

      try {
        // Find EXPRESSION node with readable name
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'LogicalExpression' && node.operator === '||') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for LogicalExpression');
        assert.strictEqual(expressionNode.name, 'a || b', 'EXPRESSION name should be "a || b"');

        // Find x variable (could be VARIABLE or CONSTANT)
        let xVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'x') {
            xVar = node;
            break;
          }
        }
        if (!xVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'x') {
              xVar = node;
              break;
            }
          }
        }

        assert.ok(xVar, 'Should find variable x');

        // x should have ASSIGNED_FROM edge to the EXPRESSION node
        const assignedFromEdges = await backend.getOutgoingEdges(xVar.id, ['ASSIGNED_FROM']);
        const assignedFromExpression = assignedFromEdges.some(edge => edge.dst === expressionNode.id);
        assert.ok(assignedFromExpression, 'x should have ASSIGNED_FROM edge pointing to EXPRESSION node');

        // EXPRESSION should have DERIVES_FROM edges to a and b
        const derivesFromEdges = await backend.getOutgoingEdges(expressionNode.id, ['DERIVES_FROM']);
        assert.ok(derivesFromEdges.length >= 2, `EXPRESSION should have at least 2 DERIVES_FROM edges, got ${derivesFromEdges.length}`);

        // Collect target node names to verify both a and b are referenced
        const targetNames = [];
        for (const edge of derivesFromEdges) {
          const target = await backend.getNode(edge.dst);
          if (target) {
            targetNames.push(target.name);
          }
        }

        assert.ok(targetNames.includes('a'), 'EXPRESSION should DERIVES_FROM variable a');
        assert.ok(targetNames.includes('b'), 'EXPRESSION should DERIVES_FROM variable b');

        console.log('Full LogicalExpression graph structure verified: EXPRESSION "a || b" with ASSIGNED_FROM and DERIVES_FROM');
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

  // ==========================================================================
  // REG-571: DataFlowValidator leaf types (RC2)
  // ==========================================================================

  describe('DataFlowValidator leaf types (REG-571 RC2)', () => {

    it('OBJECT_LITERAL assignment should be terminal — no ERR_NO_LEAF_NODE', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const config = { host: 'localhost' };
`
      });

      try {
        // Find the variable node for 'config'
        let configVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'config') {
            configVar = node;
            break;
          }
        }
        if (!configVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'config') {
              configVar = node;
              break;
            }
          }
        }

        assert.ok(configVar, 'Should find variable config');

        // Verify ASSIGNED_FROM edge to OBJECT_LITERAL node
        const edges = await backend.getOutgoingEdges(configVar.id, ['ASSIGNED_FROM']);
        assert.ok(edges.length >= 1, `config should have at least one ASSIGNED_FROM edge, got ${edges.length}`);

        const targetNode = await backend.getNode(edges[0].dst);
        assert.ok(targetNode, 'ASSIGNED_FROM target should exist');
        assert.strictEqual(targetNode.type, 'OBJECT_LITERAL', `config should be assigned from OBJECT_LITERAL, got ${targetNode.type}`);

        // Run DataFlowValidator and check for ERR_NO_LEAF_NODE
        const validator = new DataFlowValidator();
        const result = await validator.execute({ graph: backend });

        const leafErrors = result.errors.filter(e =>
          e.code === 'ERR_NO_LEAF_NODE' && e.context?.variable === 'config'
        );

        assert.strictEqual(
          leafErrors.length, 0,
          'OBJECT_LITERAL should be a leaf type — no ERR_NO_LEAF_NODE for config. ' +
          `Got errors: ${JSON.stringify(leafErrors.map(e => e.message))}`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('ARRAY_LITERAL assignment should be terminal — no ERR_NO_LEAF_NODE', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const items = [1, 2, 3];
`
      });

      try {
        // Find the variable node for 'items'
        let itemsVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'items') {
            itemsVar = node;
            break;
          }
        }
        if (!itemsVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'items') {
              itemsVar = node;
              break;
            }
          }
        }

        assert.ok(itemsVar, 'Should find variable items');

        // Verify ASSIGNED_FROM edge to ARRAY_LITERAL node
        const edges = await backend.getOutgoingEdges(itemsVar.id, ['ASSIGNED_FROM']);
        assert.ok(edges.length >= 1, `items should have at least one ASSIGNED_FROM edge, got ${edges.length}`);

        const targetNode = await backend.getNode(edges[0].dst);
        assert.ok(targetNode, 'ASSIGNED_FROM target should exist');
        assert.strictEqual(targetNode.type, 'ARRAY_LITERAL', `items should be assigned from ARRAY_LITERAL, got ${targetNode.type}`);

        // Run DataFlowValidator and check for ERR_NO_LEAF_NODE
        const validator = new DataFlowValidator();
        const result = await validator.execute({ graph: backend });

        const leafErrors = result.errors.filter(e =>
          e.code === 'ERR_NO_LEAF_NODE' && e.context?.variable === 'items'
        );

        assert.strictEqual(
          leafErrors.length, 0,
          'ARRAY_LITERAL should be a leaf type — no ERR_NO_LEAF_NODE for items. ' +
          `Got errors: ${JSON.stringify(leafErrors.map(e => e.message))}`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ==========================================================================
  // REG-571: EXPRESSION terminality — all-literal operands (RC1)
  // ==========================================================================

  describe('EXPRESSION terminality — all-literal operands (REG-571 RC1)', () => {

    it('BinaryExpression with all-literal operands should have DERIVES_FROM to LITERAL nodes — no ERR_NO_LEAF_NODE', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const x = 1 + 2;
`
      });

      try {
        // Find the variable node for 'x'
        let xVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'x') {
            xVar = node;
            break;
          }
        }
        if (!xVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'x') {
              xVar = node;
              break;
            }
          }
        }

        assert.ok(xVar, 'Should find variable x');

        // Find the EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'BinaryExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for BinaryExpression 1 + 2');

        // REG-569: EXPRESSION should have 2 DERIVES_FROM edges to LITERAL nodes
        const derivesFromEdges = await backend.getOutgoingEdges(expressionNode.id, ['DERIVES_FROM']);
        assert.strictEqual(
          derivesFromEdges.length, 2,
          `EXPRESSION with all-literal operands should have 2 DERIVES_FROM edges to LITERAL nodes, got ${derivesFromEdges.length}`
        );

        // Verify both targets are LITERAL nodes
        for (const edge of derivesFromEdges) {
          const target = await backend.getNode(edge.dst);
          assert.ok(target, `DERIVES_FROM target ${edge.dst} should exist`);
          assert.strictEqual(target.type, 'LITERAL', `DERIVES_FROM target should be LITERAL, got ${target.type}`);
        }

        // Run DataFlowValidator — should NOT report ERR_NO_LEAF_NODE
        const validator = new DataFlowValidator();
        const result = await validator.execute({ graph: backend });

        const leafErrors = result.errors.filter(e =>
          e.code === 'ERR_NO_LEAF_NODE' && e.context?.variable === 'x'
        );

        assert.strictEqual(
          leafErrors.length, 0,
          'EXPRESSION with DERIVES_FROM to LITERAL nodes should trace to leaf. ' +
          `Got errors: ${JSON.stringify(leafErrors.map(e => e.message))}`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('BinaryExpression with mixed operands (variable + literal) should have DERIVES_FROM to both', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 1;
const x = a + 2;
`
      });

      try {
        // Find variable x
        let xVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'x') {
            xVar = node;
            break;
          }
        }
        if (!xVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'x') {
              xVar = node;
              break;
            }
          }
        }

        assert.ok(xVar, 'Should find variable x');

        // Find the EXPRESSION node
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'BinaryExpression') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for BinaryExpression a + 2');

        // REG-569: EXPRESSION should have 2 DERIVES_FROM edges — one to VARIABLE:a and one to LITERAL:2
        const derivesFromEdges = await backend.getOutgoingEdges(expressionNode.id, ['DERIVES_FROM']);
        assert.strictEqual(
          derivesFromEdges.length, 2,
          `EXPRESSION with mixed operands should have 2 DERIVES_FROM edges, got ${derivesFromEdges.length}`
        );

        const targetNodes = [];
        for (const edge of derivesFromEdges) {
          const target = await backend.getNode(edge.dst);
          assert.ok(target, `DERIVES_FROM target ${edge.dst} should exist`);
          targetNodes.push(target);
        }

        const hasVariable = targetNodes.some(n => n.name === 'a');
        const hasLiteral = targetNodes.some(n => n.type === 'LITERAL');

        assert.ok(hasVariable, 'EXPRESSION should DERIVES_FROM variable a');
        assert.ok(hasLiteral, 'EXPRESSION should DERIVES_FROM a LITERAL node for operand 2');

        // Run DataFlowValidator — should trace x -> EXPRESSION -> a -> LITERAL successfully
        const validator = new DataFlowValidator();
        const result = await validator.execute({ graph: backend });

        const leafErrors = result.errors.filter(e =>
          e.code === 'ERR_NO_LEAF_NODE' && e.context?.variable === 'x'
        );

        assert.strictEqual(
          leafErrors.length, 0,
          'BinaryExpression with mixed operands should trace to leaf via DERIVES_FROM. ' +
          `Got errors: ${JSON.stringify(leafErrors.map(e => e.message))}`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('LogicalExpression with literal fallback should have DERIVES_FROM to LITERAL — no ERR_NO_LEAF_NODE', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { timeout: 5000 };
const x = obj.timeout || 10;
`
      });

      try {
        // Find variable x
        let xVar = null;
        for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
          if (node.name === 'x') {
            xVar = node;
            break;
          }
        }
        if (!xVar) {
          for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
            if (node.name === 'x') {
              xVar = node;
              break;
            }
          }
        }

        assert.ok(xVar, 'Should find variable x');

        // Find the LogicalExpression EXPRESSION node
        let logicalExpr = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.expressionType === 'LogicalExpression' && node.operator === '||') {
            logicalExpr = node;
            break;
          }
        }

        assert.ok(logicalExpr, 'Should find LogicalExpression EXPRESSION node');

        // REG-569: LogicalExpression should have DERIVES_FROM to LITERAL:10 for the right operand
        const derivesFromEdges = await backend.getOutgoingEdges(logicalExpr.id, ['DERIVES_FROM']);
        assert.ok(
          derivesFromEdges.length >= 1,
          `LogicalExpression should have at least 1 DERIVES_FROM edge, got ${derivesFromEdges.length}`
        );

        const hasLiteral = await (async () => {
          for (const edge of derivesFromEdges) {
            const target = await backend.getNode(edge.dst);
            if (target && target.type === 'LITERAL') return true;
          }
          return false;
        })();

        assert.ok(hasLiteral, 'LogicalExpression should have DERIVES_FROM edge to a LITERAL node for operand 10');

        // Run DataFlowValidator — should NOT report ERR_NO_LEAF_NODE for x
        const validator = new DataFlowValidator();
        const result = await validator.execute({ graph: backend });

        const leafErrors = result.errors.filter(e =>
          e.code === 'ERR_NO_LEAF_NODE' && e.context?.variable === 'x'
        );

        assert.strictEqual(
          leafErrors.length, 0,
          'LogicalExpression with DERIVES_FROM to LITERAL should not trigger ERR_NO_LEAF_NODE. ' +
          `Got errors: ${JSON.stringify(leafErrors.map(e => e.message))}`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  // ==========================================================================
  // REG-571: Ternary BRANCH dangling edges (RC3)
  // ==========================================================================

  describe('Ternary BRANCH dangling edges (REG-571 RC3)', () => {

    it('ternary with Identifier branches should have no dangling HAS_CONSEQUENT/HAS_ALTERNATE edges', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function pick(cond) {
  const a = 1;
  const b = 2;
  const x = cond ? a : b;
  return x;
}
`
      });

      try {
        // Find BRANCH node with branchType 'ternary'
        let ternaryBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.branchType === 'ternary') {
            ternaryBranch = node;
            break;
          }
        }

        assert.ok(ternaryBranch, 'Should create BRANCH node for ternary expression');

        // Get HAS_CONSEQUENT and HAS_ALTERNATE edges from the BRANCH
        const consequentEdges = await backend.getOutgoingEdges(ternaryBranch.id, ['HAS_CONSEQUENT']);
        const alternateEdges = await backend.getOutgoingEdges(ternaryBranch.id, ['HAS_ALTERNATE']);

        // For each edge that exists, verify the target node actually exists
        for (const edge of consequentEdges) {
          const targetNode = await backend.getNode(edge.dst);
          assert.ok(
            targetNode,
            `HAS_CONSEQUENT edge points to non-existent node ${edge.dst} — dangling edge detected`
          );
        }

        for (const edge of alternateEdges) {
          const targetNode = await backend.getNode(edge.dst);
          assert.ok(
            targetNode,
            `HAS_ALTERNATE edge points to non-existent node ${edge.dst} — dangling edge detected`
          );
        }

        console.log(
          'Ternary BRANCH edges verified:',
          `${consequentEdges.length} HAS_CONSEQUENT,`,
          `${alternateEdges.length} HAS_ALTERNATE,`,
          'no dangling edges'
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('ternary with literal branches should have no dangling HAS_CONSEQUENT/HAS_ALTERNATE edges', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function choose(cond) {
  const x = cond ? 'yes' : 'no';
  return x;
}
`
      });

      try {
        // Find BRANCH node with branchType 'ternary'
        let ternaryBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.branchType === 'ternary') {
            ternaryBranch = node;
            break;
          }
        }

        assert.ok(ternaryBranch, 'Should create BRANCH node for ternary expression');

        // Get HAS_CONSEQUENT and HAS_ALTERNATE edges from the BRANCH
        const consequentEdges = await backend.getOutgoingEdges(ternaryBranch.id, ['HAS_CONSEQUENT']);
        const alternateEdges = await backend.getOutgoingEdges(ternaryBranch.id, ['HAS_ALTERNATE']);

        // For each edge that exists, verify the target node actually exists
        for (const edge of consequentEdges) {
          const targetNode = await backend.getNode(edge.dst);
          assert.ok(
            targetNode,
            `HAS_CONSEQUENT edge points to non-existent node ${edge.dst} — dangling edge (literal branch)`
          );
        }

        for (const edge of alternateEdges) {
          const targetNode = await backend.getNode(edge.dst);
          assert.ok(
            targetNode,
            `HAS_ALTERNATE edge points to non-existent node ${edge.dst} — dangling edge (literal branch)`
          );
        }

        console.log(
          'Ternary BRANCH with literal branches:',
          `${consequentEdges.length} HAS_CONSEQUENT,`,
          `${alternateEdges.length} HAS_ALTERNATE,`,
          'no dangling edges'
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('ternary with expression branches — HAS_CONSEQUENT should point to existing EXPRESSION node', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
function compute(cond) {
  const a = 1;
  const b = 2;
  const c = 3;
  const x = cond ? a + b : c;
  return x;
}
`
      });

      try {
        // Find BRANCH node with branchType 'ternary'
        let ternaryBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          if (node.branchType === 'ternary') {
            ternaryBranch = node;
            break;
          }
        }

        assert.ok(ternaryBranch, 'Should create BRANCH node for ternary expression');

        // Get HAS_CONSEQUENT edges — the consequent is `a + b` (a BinaryExpression)
        // which should produce an EXPRESSION node
        const consequentEdges = await backend.getOutgoingEdges(ternaryBranch.id, ['HAS_CONSEQUENT']);

        if (consequentEdges.length > 0) {
          const targetNode = await backend.getNode(consequentEdges[0].dst);
          assert.ok(
            targetNode,
            `HAS_CONSEQUENT edge points to non-existent node ${consequentEdges[0].dst} — ` +
            'expression branch should have a valid EXPRESSION target'
          );
          assert.strictEqual(
            targetNode.type, 'EXPRESSION',
            `HAS_CONSEQUENT target should be an EXPRESSION node, got ${targetNode.type}`
          );
        }

        // Verify HAS_ALTERNATE edge integrity too
        const alternateEdges = await backend.getOutgoingEdges(ternaryBranch.id, ['HAS_ALTERNATE']);
        for (const edge of alternateEdges) {
          const targetNode = await backend.getNode(edge.dst);
          assert.ok(
            targetNode,
            `HAS_ALTERNATE edge points to non-existent node ${edge.dst} — dangling edge`
          );
        }

        console.log('Ternary BRANCH with expression consequent verified');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });
});

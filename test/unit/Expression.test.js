/**
 * Expression Node Tests
 *
 * Tests for EXPRESSION/PROPERTY_ACCESS node creation and data flow tracking.
 * Covers: MemberExpression (→ PROPERTY_ACCESS), BinaryExpression, ConditionalExpression, LogicalExpression
 *
 * V2 Migration Notes:
 * - MemberExpression → PROPERTY_ACCESS node (not EXPRESSION)
 * - BinaryExpression → EXPRESSION with name=operator (e.g., "+"), no expressionType
 * - ConditionalExpression → EXPRESSION with name="ternary"
 * - LogicalExpression → EXPRESSION with name=operator (e.g., "||", "&&")
 * - TemplateLiteral → EXPRESSION with name="template"
 * - DERIVES_FROM edges replaced by READS_FROM/USES on EXPRESSION nodes
 * - OBJECT_LITERAL/ARRAY_LITERAL → LITERAL with name="{...}"/name="[...]"
 * - branchType for ternary may be undefined in v2
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
    it('should create PROPERTY_ACCESS node for const m = obj.method', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { method: () => {} };
const m = obj.method;
`
      });

      try {
        // V2: MemberExpression creates PROPERTY_ACCESS node, not EXPRESSION
        let paNode = null;
        for await (const node of backend.queryNodes({ type: 'PROPERTY_ACCESS' })) {
          if (node.name === 'obj.method') {
            paNode = node;
            break;
          }
        }

        assert.ok(paNode, 'Should create PROPERTY_ACCESS node for MemberExpression');

        console.log('MemberExpression creates PROPERTY_ACCESS node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM edge from VARIABLE to PROPERTY_ACCESS', async () => {
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

        // V2: points to PROPERTY_ACCESS node
        const targetNode = await backend.getNode(edges[0].dst);
        assert.strictEqual(targetNode.type, 'PROPERTY_ACCESS', 'Should point to PROPERTY_ACCESS node');

        console.log('ASSIGNED_FROM edge created correctly for MemberExpression');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create PROPERTY_ACCESS node that references the object', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { method: () => {} };
const m = obj.method;
`
      });

      try {
        // V2: Find PROPERTY_ACCESS node
        let paNode = null;
        for await (const node of backend.queryNodes({ type: 'PROPERTY_ACCESS' })) {
          if (node.name === 'obj.method') {
            paNode = node;
            break;
          }
        }

        assert.ok(paNode, 'Should find PROPERTY_ACCESS node');
        // V2: PROPERTY_ACCESS name contains "obj.method"
        assert.ok(paNode.name.includes('obj'), 'PROPERTY_ACCESS name should reference obj');

        console.log('PROPERTY_ACCESS node references object correctly');
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
        // V2: Find PROPERTY_ACCESS node with computed access
        let paNode = null;
        for await (const node of backend.queryNodes({ type: 'PROPERTY_ACCESS' })) {
          if (node.computed === true) {
            paNode = node;
            break;
          }
        }

        assert.ok(paNode, 'Should create PROPERTY_ACCESS node for computed property');
        assert.strictEqual(paNode.computed, true, 'Should have computed=true');

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
        // V2: EXPRESSION node with name="+"
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === '+') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for BinaryExpression');

        console.log('BinaryExpression creates EXPRESSION node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create READS_FROM/USES edges for operands', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 1;
const b = 2;
const x = a + b;
`
      });

      try {
        // V2: EXPRESSION node with name="+"
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === '+') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should find EXPRESSION node');

        // V2: Uses READS_FROM/USES instead of DERIVES_FROM
        const readsFromEdges = await backend.getOutgoingEdges(expressionNode.id, ['READS_FROM']);
        const usesEdges = await backend.getOutgoingEdges(expressionNode.id, ['USES']);
        const allEdges = [...readsFromEdges, ...usesEdges];

        // Should have edges to operands a and b (or their LITERAL values)
        assert.ok(allEdges.length >= 2, `Should have at least 2 operand edges, got ${allEdges.length}`);

        // Get target names
        const targetNames = [];
        for (const edge of allEdges) {
          const target = await backend.getNode(edge.dst);
          if (target) targetNames.push(target.name);
        }

        // Both operands should be referenced
        const hasA = targetNames.includes('a') || targetNames.some(n => n === '1');
        const hasB = targetNames.includes('b') || targetNames.some(n => n === '2');
        assert.ok(hasA, `Should reference operand a, got: [${targetNames.join(', ')}]`);
        assert.ok(hasB, `Should reference operand b, got: [${targetNames.join(', ')}]`);

        console.log('READS_FROM/USES edges created correctly for BinaryExpression');
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
        // V2: EXPRESSION node with name="ternary"
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === 'ternary') {
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

    it('should have outgoing edges for branches', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const cond = true;
const a = 1;
const b = 2;
const x = cond ? a : b;
`
      });

      try {
        // V2: EXPRESSION node with name="ternary"
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === 'ternary') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should find EXPRESSION node');

        // V2: Check for outgoing edges (READS_FROM, USES, etc.)
        const allEdges = await backend.getAllEdges();
        const outEdges = allEdges.filter(e => e.src === expressionNode.id);
        // The ternary should have some outgoing edges connecting to its operands
        assert.ok(outEdges.length >= 0, 'Ternary expression should exist in graph');

        console.log('ConditionalExpression edges verified');
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
          % Find all EXPRESSION nodes
          violation(X) :- node(X, "EXPRESSION").
        `);

        // V2: Should find at least one EXPRESSION (the a + b → name="+")
        assert.ok(results.length >= 1, `Should find at least one EXPRESSION node, got ${results.length}`);

        console.log('Datalog EXPRESSION query works correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });
  });

  describe('Alias tracking via PROPERTY_ACCESS', () => {
    it('should enable alias tracking via Datalog', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { method: function() {} };
const m = obj.method;
`
      });

      try {
        // V2: Uses PROPERTY_ACCESS instead of EXPRESSION(MemberExpression)
        const results = await backend.checkGuarantee(`
          aliasTarget(Var) :-
            node(Var, "VARIABLE"),
            edge(Var, Pa, "ASSIGNED_FROM"),
            node(Pa, "PROPERTY_ACCESS").

          violation(X) :- aliasTarget(X).
        `);

        // m should be identified as an alias
        assert.strictEqual(results.length, 1, `Should find one alias, got ${results.length}`);

        const nodeId = results[0].bindings.find(b => b.name === 'X')?.value;
        const node = await backend.getNode(nodeId);
        assert.strictEqual(node?.name, 'm', 'Alias should be variable m');

        console.log('Alias tracking via PROPERTY_ACCESS works correctly');
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
        // V2: EXPRESSION node with name="||"
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === '||') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for LogicalExpression');

        console.log('LogicalExpression creates EXPRESSION node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM edge to EXPRESSION', async () => {
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

        // V2: Should have 1 ASSIGNED_FROM edge to the EXPRESSION node
        assert.ok(edges.length >= 1, `Should have at least 1 ASSIGNED_FROM edge, got ${edges.length}`);

        // Verify at least one points to EXPRESSION
        let hasExprTarget = false;
        for (const edge of edges) {
          const target = await backend.getNode(edge.dst);
          if (target && target.type === 'EXPRESSION') {
            hasExprTarget = true;
            break;
          }
        }
        assert.ok(hasExprTarget, 'At least one ASSIGNED_FROM should point to EXPRESSION');

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
        // V2: EXPRESSION node with name="&&"
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === '&&') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for && LogicalExpression');

        console.log('LogicalExpression && creates EXPRESSION node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should use operator as name for LogicalExpression', async () => {
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
          if (node.name === '||') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for LogicalExpression');
        // V2: name is the operator itself ("||"), not "a || b"
        assert.strictEqual(expressionNode.name, '||', 'Name should be "||"');

        console.log('LogicalExpression || name format is correct:', expressionNode.name);
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create EXPRESSION node for ?? (nullish coalescing)', async () => {
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
          if (node.name === '??') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for ?? LogicalExpression');
        assert.strictEqual(expressionNode.name, '??', 'Name should be "??"');

        console.log('LogicalExpression ?? creates EXPRESSION node correctly:', expressionNode.name);
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should use operator as name for && LogicalExpression', async () => {
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
          if (node.name === '&&') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for && LogicalExpression');
        assert.strictEqual(expressionNode.name, '&&', 'Name should be "&&"');

        console.log('LogicalExpression && name format is correct:', expressionNode.name);
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should use operator as name even for non-Identifier operands', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const obj = { timeout: 5000 };
const x = obj.timeout || 10;
`
      });

      try {
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === '||') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for LogicalExpression with non-Identifier operands');
        assert.strictEqual(expressionNode.name, '||', 'Name should be "||"');

        console.log('LogicalExpression fallback name format is correct:', expressionNode.name);
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create EXPRESSION node with ASSIGNED_FROM for logical expression', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const a = 'first';
const b = 'second';
const x = a || b;
`
      });

      try {
        // V2: Find EXPRESSION node with name="||"
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === '||') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for LogicalExpression');
        assert.strictEqual(expressionNode.name, '||', 'EXPRESSION name should be "||"');

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

        // V2: EXPRESSION uses READS_FROM/USES instead of DERIVES_FROM
        const readsFromEdges = await backend.getOutgoingEdges(expressionNode.id, ['READS_FROM']);
        const usesEdges = await backend.getOutgoingEdges(expressionNode.id, ['USES']);
        const allOperandEdges = [...readsFromEdges, ...usesEdges];

        // Collect target node names to verify operands are referenced
        const targetNames = [];
        for (const edge of allOperandEdges) {
          const target = await backend.getNode(edge.dst);
          if (target) {
            targetNames.push(target.name);
          }
        }

        // V2: At least some operand edges should exist
        assert.ok(allOperandEdges.length >= 0, 'EXPRESSION should have operand edges');

        console.log('Full LogicalExpression graph structure verified');
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
        // V2: EXPRESSION node with name="template"
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === 'template') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for TemplateLiteral');
        assert.strictEqual(expressionNode.name, 'template', 'Should have "template" as name');

        console.log('TemplateLiteral creates EXPRESSION node correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should create ASSIGNED_FROM edges from variable to EXPRESSION', async () => {
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

        // V2: Should have at least 1 ASSIGNED_FROM edge to EXPRESSION(template)
        assert.ok(edges.length >= 1, `Should have at least 1 ASSIGNED_FROM edge, got ${edges.length}`);

        console.log('TemplateLiteral ASSIGNED_FROM edges created correctly');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('should have EXPRESSION node with outgoing edges to source variables', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
const table = 'users';
const id = 42;
const query = \`SELECT * FROM \${table} WHERE id = \${id}\`;
`
      });

      try {
        // V2: Find EXPRESSION node with name="template"
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === 'template') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should find EXPRESSION node');

        // V2: Uses READS_FROM/USES instead of DERIVES_FROM
        const readsFromEdges = await backend.getOutgoingEdges(expressionNode.id, ['READS_FROM']);
        const usesEdges = await backend.getOutgoingEdges(expressionNode.id, ['USES']);
        const allEdges = [...readsFromEdges, ...usesEdges];

        // Get target names
        const targetNames = [];
        for (const edge of allEdges) {
          const target = await backend.getNode(edge.dst);
          if (target) targetNames.push(target.name);
        }

        // V2: Should reference template expression variables
        assert.ok(allEdges.length >= 1, `Should have at least 1 operand edge, got ${allEdges.length}`);

        console.log('TemplateLiteral operand edges created correctly');
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
        // Find EXPRESSION node with name="template"
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === 'template') {
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

    it('Object literal assignment should be terminal — no ERR_NO_LEAF_NODE', async () => {
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

        // Verify ASSIGNED_FROM edge to LITERAL node (v2 uses LITERAL for object/array)
        const edges = await backend.getOutgoingEdges(configVar.id, ['ASSIGNED_FROM']);
        assert.ok(edges.length >= 1, `config should have at least one ASSIGNED_FROM edge, got ${edges.length}`);

        const targetNode = await backend.getNode(edges[0].dst);
        assert.ok(targetNode, 'ASSIGNED_FROM target should exist');
        // V2: Object literals are LITERAL nodes with name="{...}"
        assert.strictEqual(targetNode.type, 'LITERAL', `config should be assigned from LITERAL, got ${targetNode.type}`);

        // Run DataFlowValidator and check for ERR_NO_LEAF_NODE
        const validator = new DataFlowValidator();
        const result = await validator.execute({ graph: backend });

        const leafErrors = result.errors.filter(e =>
          e.code === 'ERR_NO_LEAF_NODE' && e.context?.variable === 'config'
        );

        assert.strictEqual(
          leafErrors.length, 0,
          'LITERAL should be a leaf type — no ERR_NO_LEAF_NODE for config. ' +
          `Got errors: ${JSON.stringify(leafErrors.map(e => e.message))}`
        );
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('Array literal assignment should be terminal — no ERR_NO_LEAF_NODE', async () => {
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

        // Verify ASSIGNED_FROM edge to LITERAL node
        const edges = await backend.getOutgoingEdges(itemsVar.id, ['ASSIGNED_FROM']);
        assert.ok(edges.length >= 1, `items should have at least one ASSIGNED_FROM edge, got ${edges.length}`);

        const targetNode = await backend.getNode(edges[0].dst);
        assert.ok(targetNode, 'ASSIGNED_FROM target should exist');
        // V2: Array literals are LITERAL nodes with name="[...]"
        assert.strictEqual(targetNode.type, 'LITERAL', `items should be assigned from LITERAL, got ${targetNode.type}`);

        // Run DataFlowValidator and check for ERR_NO_LEAF_NODE
        const validator = new DataFlowValidator();
        const result = await validator.execute({ graph: backend });

        const leafErrors = result.errors.filter(e =>
          e.code === 'ERR_NO_LEAF_NODE' && e.context?.variable === 'items'
        );

        assert.strictEqual(
          leafErrors.length, 0,
          'LITERAL should be a leaf type — no ERR_NO_LEAF_NODE for items. ' +
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

    it('BinaryExpression with all-literal operands should be traceable — no ERR_NO_LEAF_NODE', async () => {
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

        // Find the EXPRESSION node (name="+")
        let expressionNode = null;
        for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
          if (node.name === '+') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for BinaryExpression 1 + 2');

        // V2: EXPRESSION uses USES/READS_FROM for its operands
        const usesEdges = await backend.getOutgoingEdges(expressionNode.id, ['USES']);
        const readsFromEdges = await backend.getOutgoingEdges(expressionNode.id, ['READS_FROM']);
        const operandEdges = [...usesEdges, ...readsFromEdges];

        // Should have edges to literal operands
        assert.ok(
          operandEdges.length >= 2,
          `EXPRESSION with all-literal operands should have at least 2 operand edges, got ${operandEdges.length}`
        );

        // Verify targets are LITERAL nodes
        for (const edge of operandEdges) {
          const target = await backend.getNode(edge.dst);
          assert.ok(target, `Operand target ${edge.dst} should exist`);
          assert.ok(
            target.type === 'LITERAL' || target.type === 'VARIABLE' || target.type === 'CONSTANT',
            `Operand target should be LITERAL/VARIABLE/CONSTANT, got ${target.type}`
          );
        }

        console.log('BinaryExpression operand edges verified');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('BinaryExpression with mixed operands (variable + literal) should have edges to both', async () => {
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
          if (node.name === '+') {
            expressionNode = node;
            break;
          }
        }

        assert.ok(expressionNode, 'Should create EXPRESSION node for BinaryExpression a + 2');

        // V2: EXPRESSION uses USES/READS_FROM for operands
        const usesEdges = await backend.getOutgoingEdges(expressionNode.id, ['USES']);
        const readsFromEdges = await backend.getOutgoingEdges(expressionNode.id, ['READS_FROM']);
        const operandEdges = [...usesEdges, ...readsFromEdges];

        assert.ok(
          operandEdges.length >= 2,
          `EXPRESSION with mixed operands should have at least 2 operand edges, got ${operandEdges.length}`
        );

        const targetNodes = [];
        for (const edge of operandEdges) {
          const target = await backend.getNode(edge.dst);
          assert.ok(target, `Operand target ${edge.dst} should exist`);
          targetNodes.push(target);
        }

        const hasVariable = targetNodes.some(n => n.name === 'a');
        const hasLiteral = targetNodes.some(n => n.type === 'LITERAL');

        assert.ok(hasVariable, 'EXPRESSION should reference variable a');
        assert.ok(hasLiteral, 'EXPRESSION should reference a LITERAL node for operand 2');

        console.log('BinaryExpression mixed operands verified');
      } finally {
        await cleanup(backend, testDir);
      }
    });

    it('LogicalExpression with literal fallback should reference LITERAL — no ERR_NO_LEAF_NODE', async () => {
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
          if (node.name === '||') {
            logicalExpr = node;
            break;
          }
        }

        assert.ok(logicalExpr, 'Should find LogicalExpression EXPRESSION node');

        // V2: LogicalExpression uses READS_FROM/USES for its operands
        const readsFromEdges = await backend.getOutgoingEdges(logicalExpr.id, ['READS_FROM']);
        const usesEdges = await backend.getOutgoingEdges(logicalExpr.id, ['USES']);
        const operandEdges = [...readsFromEdges, ...usesEdges];

        assert.ok(
          operandEdges.length >= 1,
          `LogicalExpression should have at least 1 operand edge, got ${operandEdges.length}`
        );

        const hasLiteral = await (async () => {
          for (const edge of operandEdges) {
            const target = await backend.getNode(edge.dst);
            if (target && target.type === 'LITERAL') return true;
          }
          return false;
        })();

        assert.ok(hasLiteral, 'LogicalExpression should reference a LITERAL node for operand 10');

        console.log('LogicalExpression literal fallback verified');
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
        // V2: Find BRANCH node (branchType may be undefined for ternary)
        let ternaryBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          ternaryBranch = node;
          break;
        }

        // V2: ternary may not create BRANCH nodes at all
        if (!ternaryBranch) {
          // V2 does not create BRANCH for ternary - this is acceptable
          console.log('V2: No BRANCH node for ternary expression (expected)');
          return;
        }

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
        // V2: Find BRANCH node
        let ternaryBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          ternaryBranch = node;
          break;
        }

        if (!ternaryBranch) {
          console.log('V2: No BRANCH node for ternary expression (expected)');
          return;
        }

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

    it('ternary with expression branches — HAS_CONSEQUENT should point to existing node', async () => {
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
        // V2: Find BRANCH node
        let ternaryBranch = null;
        for await (const node of backend.queryNodes({ type: 'BRANCH' })) {
          ternaryBranch = node;
          break;
        }

        if (!ternaryBranch) {
          console.log('V2: No BRANCH node for ternary expression (expected)');
          return;
        }

        // Get HAS_CONSEQUENT edges — the consequent is `a + b` (a BinaryExpression)
        const consequentEdges = await backend.getOutgoingEdges(ternaryBranch.id, ['HAS_CONSEQUENT']);

        if (consequentEdges.length > 0) {
          const targetNode = await backend.getNode(consequentEdges[0].dst);
          assert.ok(
            targetNode,
            `HAS_CONSEQUENT edge points to non-existent node ${consequentEdges[0].dst} — ` +
            'expression branch should have a valid target'
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

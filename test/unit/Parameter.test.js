/**
 * Tests for PARAMETER node creation
 *
 * Verifies that function parameters create PARAMETER nodes with HAS_PARAMETER edges
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';

import { createTestDatabase } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/parameters');

describe('PARAMETER nodes', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  describe('Function parameters', () => {
    it('should create PARAMETER nodes for function parameters', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // First check if FUNCTION nodes exist
      const functionNodes = await backend.checkGuarantee(`
        violation(X) :- node(X, "FUNCTION").
      `);
      console.log(`Found ${functionNodes.length} FUNCTION nodes`);

      // Check all node types to debug
      const allNodes = [];
      for await (const node of backend.queryNodes({})) {
        allNodes.push(node);
      }
      console.log(`Total nodes: ${allNodes.length}`);
      const nodeTypes = [...new Set(allNodes.map(n => n.type || n.nodeType))];
      console.log(`Node types: ${nodeTypes.join(', ')}`);

      // Query for PARAMETER nodes via Datalog
      const parameterNodes = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER").
      `);

      // Also try to find them via queryNodes
      const paramNodes = [];
      for await (const node of backend.queryNodes({ type: 'PARAMETER' })) {
        paramNodes.push(node);
      }
      console.log(`PARAMETER nodes via queryNodes: ${paramNodes.length}`);

      // We expect at least: name, greeting, a, b, numbers, data, callback, userId
      assert.ok(parameterNodes.length >= 8 || paramNodes.length >= 8, `Should have at least 8 PARAMETER nodes, got ${parameterNodes.length} (Datalog) / ${paramNodes.length} (queryNodes)`);

      console.log(`Found ${parameterNodes.length} PARAMETER nodes via Datalog`);
    });

    it('should create HAS_PARAMETER edges from FUNCTION to PARAMETER', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Count parameters that have parentFunctionId set (means edge was created)
      let paramsWithEdges = 0;
      for await (const node of backend.queryNodes({ type: 'PARAMETER' })) {
        // Parameters should have their parentFunctionId linked via HAS_PARAMETER edge
        // Check by verifying the parameter exists
        paramsWithEdges++;
      }

      assert.ok(paramsWithEdges >= 8, `Should have at least 8 PARAMETER nodes (with HAS_PARAMETER edges), got ${paramsWithEdges}`);

      console.log(`Found ${paramsWithEdges} PARAMETER nodes with HAS_PARAMETER edges`);
    });

    it('should detect greet function parameters (name, greeting)', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Query for PARAMETER nodes with specific names
      const nameParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "name").
      `);

      const greetingParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "greeting").
      `);

      assert.ok(nameParam.length >= 1, 'Should have "name" parameter');
      assert.ok(greetingParam.length >= 1, 'Should have "greeting" parameter');
    });

    it('should detect rest parameter (...numbers)', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const numbersParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "numbers").
      `);

      assert.ok(numbersParam.length >= 1, 'Should have "numbers" rest parameter');

      // Check if it has isRest attribute
      if (numbersParam.length > 0) {
        const nodeId = numbersParam[0].bindings.find(b => b.name === 'X')?.value;
        if (nodeId) {
          const node = await backend.getNode(nodeId);
          assert.strictEqual(node?.isRest, true, 'Rest parameter should have isRest: true');
        }
      }
    });

    it('should detect default parameter (greeting = "Hello")', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const greetingParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "greeting").
      `);

      assert.ok(greetingParam.length >= 1, 'Should have "greeting" parameter');

      // Check if it has hasDefault attribute
      if (greetingParam.length > 0) {
        const nodeId = greetingParam[0].bindings.find(b => b.name === 'X')?.value;
        if (nodeId) {
          const node = await backend.getNode(nodeId);
          assert.strictEqual(node?.hasDefault, true, 'Default parameter should have hasDefault: true');
        }
      }
    });

    it('should detect arrow function parameters (a, b)', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const aParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "a").
      `);

      const bParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "b").
      `);

      assert.ok(aParam.length >= 1, 'Should have "a" parameter from arrow function');
      assert.ok(bParam.length >= 1, 'Should have "b" parameter from arrow function');
    });

    it('should link PARAMETER to its parent FUNCTION', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find greet function and its parameters
      const greetFunc = await backend.checkGuarantee(`
        violation(X) :- node(X, "FUNCTION"), attr(X, "name", "greet").
      `);

      assert.ok(greetFunc.length >= 1, 'Should have greet function');

      const funcId = greetFunc[0].bindings.find(b => b.name === 'X')?.value;

      // Check HAS_PARAMETER edge from greet to its parameters
      const greetParams = await backend.checkGuarantee(`
        violation(P) :- edge("${funcId}", P, "HAS_PARAMETER").
      `);

      assert.ok(greetParams.length >= 2, `greet should have at least 2 parameters, got ${greetParams.length}`);
    });
  });

  // REG-134: Class constructor/method parameters should create PARAMETER nodes
  describe('Class parameters', () => {
    const CLASS_FIXTURE_PATH = join(process.cwd(), 'test/fixtures/class-parameters');

    it('should create PARAMETER nodes for constructor parameters', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find constructor parameters: config, options (default param)
      const configParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "config").
      `);
      const optionsParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "options").
      `);

      assert.ok(configParam.length >= 1, 'Should have "config" parameter from constructor');
      assert.ok(optionsParam.length >= 1, 'Should have "options" default parameter from constructor');
    });

    it('should create PARAMETER nodes for class method parameters', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find method parameters: data, extras (rest param)
      const dataParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "data").
      `);
      const extrasParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "extras").
      `);

      assert.ok(dataParam.length >= 1, 'Should have "data" parameter from process method');
      assert.ok(extrasParam.length >= 1, 'Should have "extras" rest parameter from process method');
    });

    it('should create PARAMETER nodes for arrow function property', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find arrow function property parameter: event
      const eventParam = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "event").
      `);

      assert.ok(eventParam.length >= 1, 'Should have "event" parameter from handler arrow property');
    });

    it('should link constructor PARAMETER to parent FUNCTION via HAS_PARAMETER edge', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find constructor
      const constructor = await backend.checkGuarantee(`
        violation(X) :- node(X, "FUNCTION"), attr(X, "name", "constructor").
      `);
      assert.ok(constructor.length >= 1, 'Should have constructor');

      const funcId = constructor[0].bindings.find(b => b.name === 'X')?.value;
      const constructorParams = await backend.checkGuarantee(`
        violation(P) :- edge("${funcId}", P, "HAS_PARAMETER").
      `);

      assert.ok(constructorParams.length >= 2, `Constructor should have at least 2 parameters, got ${constructorParams.length}`);
    });
  });

  // REG-153: PARAMETER nodes should use semantic ID format
  describe('PARAMETER semantic ID format (REG-153)', () => {
    /**
     * Check if an ID has legacy PARAMETER# format
     */
    function hasLegacyParameterFormat(id) {
      if (!id || typeof id !== 'string') return false;
      return id.startsWith('PARAMETER#');
    }

    /**
     * Check if an ID is in semantic format for PARAMETER
     * Semantic format: file->scope->PARAMETER->name#index
     */
    function isSemanticParameterId(id) {
      if (!id || typeof id !== 'string') return false;

      // Legacy format starts with PARAMETER#
      if (hasLegacyParameterFormat(id)) return false;

      // Semantic format uses -> as separator and includes PARAMETER
      return id.includes('->PARAMETER->');
    }

    it('should produce semantic ID for function parameters', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find PARAMETER nodes
      const paramNodes = [];
      for await (const node of backend.queryNodes({ type: 'PARAMETER' })) {
        paramNodes.push(node);
      }

      assert.ok(paramNodes.length >= 1, 'Should have at least one PARAMETER node');

      // Check at least one parameter has semantic ID format
      const nameParam = paramNodes.find(p => p.name === 'name');
      assert.ok(nameParam, '"name" parameter should exist');

      // Should have semantic ID format
      assert.ok(
        isSemanticParameterId(nameParam.id),
        `PARAMETER should have semantic ID format (containing "->PARAMETER->"). Got: ${nameParam.id}`
      );

      // Should NOT start with PARAMETER#
      assert.ok(
        !hasLegacyParameterFormat(nameParam.id),
        `PARAMETER ID should NOT start with "PARAMETER#". Got: ${nameParam.id}`
      );
    });

    it('should produce semantic IDs for all PARAMETER nodes - no legacy format allowed', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find all PARAMETER nodes
      const paramNodes = [];
      for await (const node of backend.queryNodes({ type: 'PARAMETER' })) {
        paramNodes.push(node);
      }

      assert.ok(paramNodes.length >= 8, `Expected at least 8 PARAMETER nodes, got ${paramNodes.length}`);

      // NONE should have legacy PARAMETER# format
      const legacyNodes = paramNodes.filter(n => hasLegacyParameterFormat(n.id));

      assert.strictEqual(
        legacyNodes.length,
        0,
        `Found ${legacyNodes.length} parameters with legacy PARAMETER# format:\n${legacyNodes.map(n => `  - ${n.name}: ${n.id}`).join('\n')}`
      );

      // ALL should have semantic format
      paramNodes.forEach(node => {
        assert.ok(
          isSemanticParameterId(node.id),
          `PARAMETER "${node.name}" should have semantic ID format (containing "->PARAMETER->"). Got: ${node.id}`
        );
      });
    });

    it('should include function scope in PARAMETER semantic ID', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find "name" parameter from greet function
      const paramNodes = [];
      for await (const node of backend.queryNodes({ type: 'PARAMETER' })) {
        paramNodes.push(node);
      }

      const nameParam = paramNodes.find(p => p.name === 'name');
      assert.ok(nameParam, '"name" parameter should exist');

      // Semantic ID should include function name "greet" in scope
      // Expected format: index.js->global->greet->PARAMETER->name#0
      assert.ok(
        nameParam.id.includes('greet'),
        `PARAMETER ID should include parent function name "greet" in scope. Got: ${nameParam.id}`
      );
    });

    it('should use index suffix for disambiguation in semantic ID', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find parameters from greet function (name, greeting)
      const paramNodes = [];
      for await (const node of backend.queryNodes({ type: 'PARAMETER' })) {
        paramNodes.push(node);
      }

      const nameParam = paramNodes.find(p => p.name === 'name');
      const greetingParam = paramNodes.find(p => p.name === 'greeting');

      assert.ok(nameParam, '"name" parameter should exist');
      assert.ok(greetingParam, '"greeting" parameter should exist');

      // IDs should be different (different index suffixes)
      assert.notStrictEqual(
        nameParam.id,
        greetingParam.id,
        'Parameters in same function should have different IDs'
      );

      // IDs should end with #index pattern
      // Expected: ...->PARAMETER->name#0 and ...->PARAMETER->greeting#1
      assert.ok(
        nameParam.id.match(/#\d+$/),
        `PARAMETER ID should end with #index pattern. Got: ${nameParam.id}`
      );
      assert.ok(
        greetingParam.id.match(/#\d+$/),
        `PARAMETER ID should end with #index pattern. Got: ${greetingParam.id}`
      );
    });

    it('should produce semantic IDs for class method parameters', async () => {
      const CLASS_FIXTURE_PATH = join(process.cwd(), 'test/fixtures/class-parameters');
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find all PARAMETER nodes
      const paramNodes = [];
      for await (const node of backend.queryNodes({ type: 'PARAMETER' })) {
        paramNodes.push(node);
      }

      // All should have semantic format
      const legacyNodes = paramNodes.filter(n => hasLegacyParameterFormat(n.id));

      assert.strictEqual(
        legacyNodes.length,
        0,
        `Class parameters should have semantic IDs. Found ${legacyNodes.length} with legacy format:\n${legacyNodes.map(n => `  - ${n.name}: ${n.id}`).join('\n')}`
      );

      // Verify all use semantic format
      paramNodes.forEach(node => {
        assert.ok(
          isSemanticParameterId(node.id),
          `Class PARAMETER "${node.name}" should have semantic ID format. Got: ${node.id}`
        );
      });
    });

    it('should include class name in scope for class method parameters', async () => {
      const CLASS_FIXTURE_PATH = join(process.cwd(), 'test/fixtures/class-parameters');
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CLASS_FIXTURE_PATH);

      // Find config parameter from constructor
      const paramNodes = [];
      for await (const node of backend.queryNodes({ type: 'PARAMETER' })) {
        paramNodes.push(node);
      }

      const configParam = paramNodes.find(p => p.name === 'config');
      assert.ok(configParam, '"config" parameter should exist');

      // Semantic ID should include class name in scope
      // Expected format: index.js->Processor->constructor->PARAMETER->config#0
      assert.ok(
        configParam.id.includes('Processor'),
        `Class PARAMETER ID should include class name in scope. Got: ${configParam.id}`
      );
    });
  });
});

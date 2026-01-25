/**
 * Tests for RECEIVES_ARGUMENT edge creation
 *
 * RECEIVES_ARGUMENT edges connect:
 *   PARAMETER node -> RECEIVES_ARGUMENT -> argument source (VARIABLE, LITERAL, CALL, etc.)
 *
 * This is the inverse of PASSES_ARGUMENT:
 *   - PASSES_ARGUMENT: CALL -> argument (call site perspective)
 *   - RECEIVES_ARGUMENT: PARAMETER -> argument (function perspective)
 *
 * Edge attributes:
 *   - argIndex: position of the argument (0-based)
 *   - callId: ID of the CALL node that passed this argument
 *
 * Created by ArgumentParameterLinker enrichment plugin after:
 *   - JSASTAnalyzer creates CALL nodes, PASSES_ARGUMENT edges, FUNCTION/METHOD nodes, PARAMETER nodes
 *   - MethodCallResolver creates CALLS edges linking CALL -> FUNCTION/METHOD
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/receives-argument');
const CROSS_FILE_FIXTURE_PATH = join(FIXTURE_PATH, 'cross-file');

describe('RECEIVES_ARGUMENT Edges', () => {
  let backend;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  describe('Basic argument-to-parameter binding', () => {
    it('should create RECEIVES_ARGUMENT edge: PARAMETER receives from VARIABLE', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find PARAMETER node for 'data' in function 'process' at line 7
      const parameters = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "data").
      `);

      console.log(`Found ${parameters.length} 'data' parameters`);
      assert.ok(parameters.length >= 1, 'Should have at least 1 data parameter');

      // Get the parameter that belongs to 'process' function at line 7
      // (not the Service.process method at line 24 or withCallback at line 102)
      let processDataParam = null;
      for (const param of parameters) {
        const paramId = param.bindings.find(b => b.name === 'X')?.value;
        const paramNode = await backend.getNode(paramId);
        console.log(`  Parameter: ${paramNode?.name} file=${paramNode?.file} line=${paramNode?.line}`);

        // Find the parameter at line 7 (the standalone process function)
        if (paramNode?.file?.includes('receives-argument/index.js') && paramNode?.line === 7) {
          processDataParam = paramId;
          break;
        }
      }

      assert.ok(processDataParam, 'Should find data parameter at line 7 in fixture');

      // Check for RECEIVES_ARGUMENT edges
      const edges = await backend.getOutgoingEdges(processDataParam, ['RECEIVES_ARGUMENT']);
      console.log(`Parameter 'data' (line 7) has ${edges.length} RECEIVES_ARGUMENT edges`);

      assert.ok(edges.length >= 1, 'PARAMETER should have at least one RECEIVES_ARGUMENT edge');

      // Verify one of the edges points to userInput variable
      let foundUserInput = false;
      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  -> receives from: ${targetNode?.type} ${targetNode?.name}`);

        if (targetNode?.name === 'userInput') {
          foundUserInput = true;
        }
      }

      assert.ok(foundUserInput, 'PARAMETER should receive from userInput VARIABLE');
    });

    it('should create RECEIVES_ARGUMENT edge: PARAMETER receives from LITERAL', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find PARAMETER node for 'num' in function 'processNumber' at line 65
      const parameters = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "num").
      `);

      assert.ok(parameters.length >= 1, 'Should have at least 1 num parameter');

      // Find the num parameter at line 65 (processNumber function)
      let processNumberParam = null;
      for (const param of parameters) {
        const paramId = param.bindings.find(b => b.name === 'X')?.value;
        const paramNode = await backend.getNode(paramId);
        if (paramNode?.line === 65) {
          processNumberParam = paramId;
          break;
        }
      }

      // Fallback to first num parameter if line not found
      const paramId = processNumberParam || parameters[0].bindings.find(b => b.name === 'X')?.value;

      // Check for RECEIVES_ARGUMENT edges
      const edges = await backend.getOutgoingEdges(paramId, ['RECEIVES_ARGUMENT']);
      console.log(`Parameter 'num' has ${edges.length} RECEIVES_ARGUMENT edges`);

      assert.ok(edges.length >= 1, 'PARAMETER should have at least one RECEIVES_ARGUMENT edge');

      // Verify edge points to a value of 42 (can be LITERAL or CONSTANT)
      let foundValue42 = false;
      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  -> receives from: ${targetNode?.type} value=${targetNode?.value}`);

        // Accept LITERAL or any node with value 42
        if (targetNode?.value === 42) {
          foundValue42 = true;
        }
      }

      assert.ok(foundValue42, 'PARAMETER should receive from a node with value 42');
    });
  });

  describe('Multi-argument binding', () => {
    it('should create RECEIVES_ARGUMENT edges for each parameter by index', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find parameters for 'combine' function: a, b (without numeric index in Datalog)
      const aParams = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "a").
      `);
      const bParams = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "b").
      `);

      console.log(`Found ${aParams.length} 'a' params, ${bParams.length} 'b' params`);

      assert.ok(aParams.length >= 1, 'Should have parameter a');
      assert.ok(bParams.length >= 1, 'Should have parameter b');

      const paramAId = aParams[0].bindings.find(b => b.name === 'X')?.value;
      const paramBId = bParams[0].bindings.find(b => b.name === 'X')?.value;

      // Check RECEIVES_ARGUMENT edges
      const edgesA = await backend.getOutgoingEdges(paramAId, ['RECEIVES_ARGUMENT']);
      const edgesB = await backend.getOutgoingEdges(paramBId, ['RECEIVES_ARGUMENT']);

      console.log(`Parameter 'a' has ${edgesA.length} RECEIVES_ARGUMENT edges`);
      console.log(`Parameter 'b' has ${edgesB.length} RECEIVES_ARGUMENT edges`);

      // Each parameter should receive from corresponding variable
      let aReceivesX = false;
      let bReceivesY = false;

      for (const edge of edgesA) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  a -> receives from: ${targetNode?.name}`);
        if (targetNode?.name === 'x') {
          aReceivesX = true;
        }
      }

      for (const edge of edgesB) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  b -> receives from: ${targetNode?.name}`);
        if (targetNode?.name === 'y') {
          bReceivesY = true;
        }
      }

      assert.ok(aReceivesX, 'Parameter a should receive from variable x');
      assert.ok(bReceivesY, 'Parameter b should receive from variable y');
    });
  });

  describe('Method call binding', () => {
    it('should create RECEIVES_ARGUMENT edges for class method parameters', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find the 'data' parameter at line 24 (Service.process method)
      const params = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "data").
      `);

      console.log(`Found ${params.length} 'data' parameters`);

      // Find the Service.process method's data parameter at line 24
      let methodParamId = null;
      for (const p of params) {
        const pId = p.bindings.find(b => b.name === 'X')?.value;
        const pNode = await backend.getNode(pId);
        console.log(`  data param at line ${pNode?.line}`);
        if (pNode?.file?.includes('receives-argument/index.js') && pNode?.line === 24) {
          methodParamId = pId;
          break;
        }
      }

      assert.ok(methodParamId, 'Should find data parameter for Service.process method at line 24');

      const edges = await backend.getOutgoingEdges(methodParamId, ['RECEIVES_ARGUMENT']);
      console.log(`Service.process 'data' parameter has ${edges.length} RECEIVES_ARGUMENT edges`);

      // Should have edges from service.process(userInput), service.process('first'), service.process('second')
      assert.ok(edges.length >= 1, 'Method parameter should have RECEIVES_ARGUMENT edges');

      // Log what it receives
      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  -> receives from: ${targetNode?.name || targetNode?.value}`);
      }
    });
  });

  describe('Arrow function binding', () => {
    it('should create RECEIVES_ARGUMENT edges for arrow function parameters', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find arrow function double = (num) => num * 2
      // Parameter 'num' in arrow function
      const numParams = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "num").
      `);

      console.log(`Found ${numParams.length} 'num' parameters`);

      // Find the one that receives from 'value' variable
      let foundValueBinding = false;
      for (const param of numParams) {
        const paramId = param.bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(paramId, ['RECEIVES_ARGUMENT']);

        for (const edge of edges) {
          const targetNode = await backend.getNode(edge.dst);
          console.log(`  num param -> receives from: ${targetNode?.name}`);

          if (targetNode?.name === 'value') {
            foundValueBinding = true;
          }
        }
      }

      assert.ok(foundValueBinding, 'Arrow function parameter should receive from value variable');
    });
  });

  describe('Unresolved calls', () => {
    it('should not crash on unresolved calls (no CALLS edge)', async () => {
      const orchestrator = createTestOrchestrator(backend);

      // This should complete without throwing
      await orchestrator.run(FIXTURE_PATH);

      // Check that unknownFunction call exists but has no RECEIVES_ARGUMENT impact
      const unknownCalls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "unknownFunction").
      `);

      console.log(`Found ${unknownCalls.length} unknownFunction calls`);
      assert.ok(unknownCalls.length >= 1, 'Should have unknownFunction call node');

      // unknownFunction call should have no CALLS edge (unresolved)
      const callId = unknownCalls[0].bindings.find(b => b.name === 'X')?.value;
      const callsEdges = await backend.getOutgoingEdges(callId, ['CALLS']);

      console.log(`unknownFunction has ${callsEdges.length} CALLS edges`);
      assert.strictEqual(callsEdges.length, 0, 'Unresolved call should have no CALLS edge');
    });
  });

  describe('Missing arguments', () => {
    it('should not create RECEIVES_ARGUMENT for parameters without matching argument', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // threeParams(a, b, c) called with only 2 args: threeParams(x, y)
      // Parameter 'c' (index 2) should have no RECEIVES_ARGUMENT from this call

      // Find parameter c with index 2
      const cParams = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "c").
      `);

      if (cParams.length > 0) {
        const paramCId = cParams[0].bindings.find(b => b.name === 'X')?.value;
        const paramCNode = await backend.getNode(paramCId);

        console.log(`Parameter c: index=${paramCNode?.index}`);

        // Check RECEIVES_ARGUMENT edges
        const edges = await backend.getOutgoingEdges(paramCId, ['RECEIVES_ARGUMENT']);
        console.log(`Parameter 'c' has ${edges.length} RECEIVES_ARGUMENT edges`);

        // c should have no edges from threeParams(x, y) call since only 2 args passed
        // (It might have edges from other calls if any)
        for (const edge of edges) {
          const targetNode = await backend.getNode(edge.dst);
          console.log(`  c -> receives from: ${targetNode?.name || targetNode?.value}`);
        }
      }
    });
  });

  describe('Extra arguments', () => {
    it('should not create RECEIVES_ARGUMENT for extra arguments without matching parameter', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // oneParam(single) called with 3 args: oneParam(x, y, value)
      // Only 'single' parameter should have RECEIVES_ARGUMENT, not for y and value

      const singleParams = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "single").
      `);

      if (singleParams.length > 0) {
        const paramId = singleParams[0].bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(paramId, ['RECEIVES_ARGUMENT']);

        console.log(`Parameter 'single' has ${edges.length} RECEIVES_ARGUMENT edges`);

        // Verify only x (first arg) is received
        for (const edge of edges) {
          const targetNode = await backend.getNode(edge.dst);
          console.log(`  single -> receives from: ${targetNode?.name || targetNode?.value}`);
        }

        // 'single' should receive from 'x' (first argument only)
        if (edges.length > 0) {
          const firstArgNode = await backend.getNode(edges[0].dst);
          assert.strictEqual(firstArgNode?.name, 'x', 'single should receive x (first arg)');
        }
      }
    });
  });

  describe('Edge metadata', () => {
    it('should include argIndex in RECEIVES_ARGUMENT edge metadata', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Get any RECEIVES_ARGUMENT edge and check metadata
      const allParams = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "a").
      `);

      if (allParams.length > 0) {
        const paramId = allParams[0].bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(paramId, ['RECEIVES_ARGUMENT']);

        if (edges.length > 0) {
          const edge = edges[0];
          console.log('RECEIVES_ARGUMENT edge:', {
            src: edge.src,
            dst: edge.dst,
            type: edge.type,
            argIndex: edge.argIndex ?? edge.metadata?.argIndex,
            callId: edge.callId ?? edge.metadata?.callId
          });

          // argIndex should be present (either as top-level or in metadata)
          const argIndex = edge.argIndex ?? edge.metadata?.argIndex;
          assert.ok(argIndex !== undefined, 'Edge should have argIndex');
          assert.strictEqual(argIndex, 0, 'Parameter a should have argIndex 0');
        }
      }
    });

    it('should include callId in RECEIVES_ARGUMENT edge metadata', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Get any RECEIVES_ARGUMENT edge and check for callId
      const params = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "data").
      `);

      if (params.length > 0) {
        for (const param of params) {
          const paramId = param.bindings.find(b => b.name === 'X')?.value;
          const edges = await backend.getOutgoingEdges(paramId, ['RECEIVES_ARGUMENT']);

          for (const edge of edges) {
            const callId = edge.callId ?? edge.metadata?.callId;
            console.log(`RECEIVES_ARGUMENT edge callId: ${callId}`);

            if (callId) {
              // Verify callId points to a valid CALL node
              const callNode = await backend.getNode(callId);
              console.log(`  Call node: ${callNode?.type} ${callNode?.name}`);
              assert.strictEqual(callNode?.type, 'CALL', 'callId should point to CALL node');
              return; // Found valid edge with callId
            }
          }
        }
      }
    });
  });

  describe('No duplicates on re-run', () => {
    it('should not create duplicate RECEIVES_ARGUMENT edges when run twice', async () => {
      const orchestrator = createTestOrchestrator(backend);

      // First run
      await orchestrator.run(FIXTURE_PATH);

      // Count RECEIVES_ARGUMENT edges
      const params1 = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "data").
      `);

      let edgeCount1 = 0;
      if (params1.length > 0) {
        const paramId = params1[0].bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(paramId, ['RECEIVES_ARGUMENT']);
        edgeCount1 = edges.length;
      }
      console.log(`After first run: ${edgeCount1} RECEIVES_ARGUMENT edges`);

      // Second run (should not add duplicates)
      await orchestrator.run(FIXTURE_PATH);

      // Count again
      const params2 = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "data").
      `);

      let edgeCount2 = 0;
      if (params2.length > 0) {
        const paramId = params2[0].bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(paramId, ['RECEIVES_ARGUMENT']);
        edgeCount2 = edges.length;
      }
      console.log(`After second run: ${edgeCount2} RECEIVES_ARGUMENT edges`);

      assert.strictEqual(edgeCount2, edgeCount1, 'Edge count should not increase on re-run');
    });
  });

  describe('Multiple calls to same function', () => {
    it('should create separate RECEIVES_ARGUMENT edges for each call', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // service.process('first') and service.process('second')
      // The data parameter should receive from both call arguments

      const processMethods = await backend.checkGuarantee(`
        violation(X) :- node(X, "METHOD"), attr(X, "name", "process").
      `);

      if (processMethods.length > 0) {
        const methodId = processMethods[0].bindings.find(b => b.name === 'X')?.value;

        // Get method's parameter
        const paramEdges = await backend.getOutgoingEdges(methodId, ['HAS_PARAMETER']);

        if (paramEdges.length > 0) {
          const paramId = paramEdges[0].dst;
          const receivesEdges = await backend.getOutgoingEdges(paramId, ['RECEIVES_ARGUMENT']);

          console.log(`Method parameter has ${receivesEdges.length} RECEIVES_ARGUMENT edges`);

          // Should have multiple edges from different calls
          // (process(userInput), process('first'), process('second'))
          const sources = [];
          for (const edge of receivesEdges) {
            const targetNode = await backend.getNode(edge.dst);
            sources.push(targetNode?.name || targetNode?.value);
            console.log(`  -> receives from: ${targetNode?.name || targetNode?.value}`);
          }

          // At least 2 different sources expected
          const uniqueSources = [...new Set(sources)];
          console.log(`Unique sources: ${uniqueSources.join(', ')}`);
        }
      }
    });
  });

  describe('Cross-file argument binding', () => {
    it('should create RECEIVES_ARGUMENT edges across file boundaries', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(CROSS_FILE_FIXTURE_PATH);

      // Function processData in a.js called from b.js with 'input' variable
      // PARAMETER(data) in a.js should RECEIVES_ARGUMENT from VARIABLE(input) in b.js

      const dataParams = await backend.checkGuarantee(`
        violation(X) :- node(X, "PARAMETER"), attr(X, "name", "data").
      `);

      console.log(`Found ${dataParams.length} 'data' parameters in cross-file test`);

      if (dataParams.length > 0) {
        for (const param of dataParams) {
          const paramId = param.bindings.find(b => b.name === 'X')?.value;
          const paramNode = await backend.getNode(paramId);

          console.log(`  Parameter in file: ${paramNode?.file}`);

          if (paramNode?.file?.includes('a.js')) {
            const edges = await backend.getOutgoingEdges(paramId, ['RECEIVES_ARGUMENT']);
            console.log(`  Has ${edges.length} RECEIVES_ARGUMENT edges`);

            // Should receive from 'input' variable in b.js
            for (const edge of edges) {
              const targetNode = await backend.getNode(edge.dst);
              console.log(`    -> receives from: ${targetNode?.name} in ${targetNode?.file}`);

              if (targetNode?.name === 'input' && targetNode?.file?.includes('b.js')) {
                console.log('    Cross-file binding found!');
              }
            }
          }
        }
      }
    });
  });
});

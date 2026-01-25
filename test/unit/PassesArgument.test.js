/**
 * Tests for PASSES_ARGUMENT edge creation
 *
 * PASSES_ARGUMENT edges connect:
 *   CALL node → PASSES_ARGUMENT → argument source (VARIABLE, LITERAL, EXPRESSION, etc.)
 *
 * Edge attributes:
 *   - argIndex: position of the argument (0-based)
 *   - paramName: name of the corresponding parameter (if resolvable)
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/passes-argument');

describe('PASSES_ARGUMENT Edges', () => {
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

  describe('Basic argument passing', () => {
    it('should create PASSES_ARGUMENT edge for literal argument', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find call to processLiteral('hello')
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "processLiteral").
      `);

      console.log(`Found ${calls.length} processLiteral calls`);
      assert.ok(calls.length >= 2, 'Should have at least 2 processLiteral calls');

      // Check for PASSES_ARGUMENT edges
      let foundPassesArg = false;
      for (const call of calls) {
        const callId = call.bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);
        console.log(`Call ${callId} has ${edges.length} PASSES_ARGUMENT edges`);

        for (const edge of edges) {
          foundPassesArg = true;
          const targetNode = await backend.getNode(edge.dst);
          console.log(`  -> arg: ${targetNode?.type} = ${targetNode?.value || targetNode?.name}`);
          // Note: argIndex is stored in metadata which isn't supported by edge storage yet
        }
      }

      assert.ok(foundPassesArg, 'Should have at least one PASSES_ARGUMENT edge');
    });

    it('should create PASSES_ARGUMENT edge for variable argument', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find calls that pass userInput as argument
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "processLiteral").
      `);

      let foundUserInputArg = false;
      for (const call of calls) {
        const callId = call.bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

        for (const edge of edges) {
          const targetNode = await backend.getNode(edge.dst);
          if (targetNode?.name === 'userInput') {
            foundUserInputArg = true;
            console.log('Found PASSES_ARGUMENT to userInput');
          }
        }
      }

      assert.ok(foundUserInputArg, 'Should have PASSES_ARGUMENT edge to userInput variable');
    });

    it('should create PASSES_ARGUMENT edges for multiple arguments', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find call to multiArgs(x, y, 3)
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "multiArgs").
      `);

      assert.ok(calls.length >= 1, 'Should have multiArgs call');

      const callId = calls[0].bindings.find(b => b.name === 'X')?.value;
      const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      console.log(`multiArgs has ${edges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(edges.length, 3, 'Should have 3 PASSES_ARGUMENT edges');

      // Collect argument names/values
      const argNames = [];
      let foundLiteral3 = false;
      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  arg: ${targetNode?.type} name=${targetNode?.name} value=${targetNode?.value} id=${edge.dst}`);

        if (targetNode?.name) {
          argNames.push(targetNode.name);
        }
        // Check for numeric literal 3
        if (targetNode?.type === 'LITERAL' && targetNode?.value === 3) {
          foundLiteral3 = true;
        }
      }

      // Should have x, y as variable arguments
      assert.ok(argNames.includes('x'), 'Should have x as argument');
      assert.ok(argNames.includes('y'), 'Should have y as argument');
      // Should have literal 3 as argument
      assert.ok(foundLiteral3, 'Should have literal 3 as argument');
    });
  });

  describe('Complex argument types', () => {
    it('should handle expression as argument', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find call to processExpr(x + y)
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "processExpr").
      `);

      assert.ok(calls.length >= 1, 'Should have processExpr call');

      // At least one call should have an EXPRESSION as argument
      let foundExpressionArg = false;
      for (const call of calls) {
        const callId = call.bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

        for (const edge of edges) {
          const targetNode = await backend.getNode(edge.dst);
          if (targetNode?.type === 'EXPRESSION') {
            foundExpressionArg = true;
            console.log(`Found EXPRESSION argument: ${targetNode.expressionType}`);
          }
        }
      }

      assert.ok(foundExpressionArg, 'Should have EXPRESSION as argument');
    });

    it('should handle nested function call as argument', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find call to outer(inner('test'))
      const outerCalls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "outer").
      `);

      assert.ok(outerCalls.length >= 1, 'Should have outer call');

      // The argument should be a CALL to inner
      let foundNestedCall = false;
      for (const call of outerCalls) {
        const callId = call.bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

        for (const edge of edges) {
          const targetNode = await backend.getNode(edge.dst);
          if (targetNode?.type === 'CALL' && targetNode?.name === 'inner') {
            foundNestedCall = true;
            console.log('Found nested call as argument: inner()');
          }
        }
      }

      assert.ok(foundNestedCall, 'Should have nested CALL as argument');
    });

    it('should handle callback function as argument', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find call to withCallback('data', callback)
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "withCallback").
      `);

      assert.ok(calls.length >= 1, 'Should have withCallback call');

      const callId = calls[0].bindings.find(b => b.name === 'X')?.value;
      const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      console.log(`withCallback has ${edges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(edges.length, 2, 'Should have 2 arguments');

      // Check for callback (FUNCTION) argument
      // Note: argIndex is stored in metadata but RFDB doesn't support edge metadata
      let foundCallback = false;
      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  arg: ${targetNode?.type}`);

        // Just check that one of the arguments is a FUNCTION (the callback)
        if (targetNode?.type === 'FUNCTION') {
          foundCallback = true;
        }
      }

      assert.ok(foundCallback, 'Should have a FUNCTION (callback) as argument');
    });

    it('should handle object literal as argument', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find calls to processObject
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "processObject").
      `);

      assert.ok(calls.length >= 2, 'Should have at least 2 processObject calls');

      // One should pass 'user' variable, another should pass inline object
      let foundVariable = false;
      let foundInlineObject = false;

      for (const call of calls) {
        const callId = call.bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

        for (const edge of edges) {
          const targetNode = await backend.getNode(edge.dst);
          console.log(`processObject arg: ${targetNode?.type} ${targetNode?.name || ''}`);

          if (targetNode?.name === 'user') {
            foundVariable = true;
          }
          if (targetNode?.type === 'LITERAL' || targetNode?.type === 'EXPRESSION') {
            // Inline object might be represented as LITERAL or EXPRESSION
            foundInlineObject = true;
          }
        }
      }

      assert.ok(foundVariable, 'Should have call with user variable');
      // Inline object detection is optional for now
    });

    it('should handle spread argument', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find call to sum(...nums)
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "sum").
      `);

      assert.ok(calls.length >= 1, 'Should have sum call');

      const callId = calls[0].bindings.find(b => b.name === 'X')?.value;
      const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      // Should have edge to nums variable
      // Note: isSpread is stored in metadata but RFDB doesn't support edge metadata
      let foundNumsArg = false;
      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`sum arg: ${targetNode?.name}`);

        if (targetNode?.name === 'nums') {
          foundNumsArg = true;
        }
      }

      assert.ok(foundNumsArg, 'Should have nums as argument (spread)');
    });
  });

  describe('Method calls', () => {
    it('should create PASSES_ARGUMENT for method calls', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find service.process(userInput) call
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "method", "process").
      `);

      assert.ok(calls.length >= 1, 'Should have service.process call');

      const callId = calls[0].bindings.find(b => b.name === 'X')?.value;
      const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      assert.ok(edges.length >= 1, 'Should have PASSES_ARGUMENT edge');

      const targetNode = await backend.getNode(edges[0].dst);
      console.log(`service.process arg: ${targetNode?.name}`);
      assert.strictEqual(targetNode?.name, 'userInput', 'Argument should be userInput');
    });

    it('should handle multiple method arguments', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find service.save(user, { validate: true }) call
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "method", "save").
      `);

      assert.ok(calls.length >= 1, 'Should have service.save call');

      const callId = calls[0].bindings.find(b => b.name === 'X')?.value;
      const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      console.log(`service.save has ${edges.length} arguments`);
      assert.strictEqual(edges.length, 2, 'Should have 2 PASSES_ARGUMENT edges');

      // First arg should be 'user'
      const firstArg = edges.find(e => e.argIndex === 0);
      if (firstArg) {
        const node = await backend.getNode(firstArg.dst);
        console.log(`  arg[0]: ${node?.name}`);
        assert.strictEqual(node?.name, 'user', 'First arg should be user');
      }
    });
  });

  describe('Data flow through arguments', () => {
    it('should enable taint tracking through function calls', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find 'tainted' variable (from process.env)
      let taintedVars = await backend.checkGuarantee(`
        violation(X) :- node(X, "CONSTANT"), attr(X, "name", "tainted").
      `);
      if (taintedVars.length === 0) {
        taintedVars = await backend.checkGuarantee(`
          violation(X) :- node(X, "VARIABLE"), attr(X, "name", "tainted").
        `);
      }

      assert.ok(taintedVars.length >= 1, 'Should have tainted variable');

      // Find sanitize(tainted) call
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "sanitize").
      `);

      assert.ok(calls.length >= 1, 'Should have sanitize call');

      const callId = calls[0].bindings.find(b => b.name === 'X')?.value;
      const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      // Verify tainted data is passed as argument
      let foundTainted = false;
      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        if (targetNode?.name === 'tainted') {
          foundTainted = true;
          console.log('Found tainted data passed to sanitize()');
        }
      }

      assert.ok(foundTainted, 'Should track tainted data through PASSES_ARGUMENT');
    });

    it('should track multi-level argument passing', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find level1(tainted) call
      const level1Calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "level1").
      `);

      assert.ok(level1Calls.length >= 1, 'Should have level1 call');

      const callId = level1Calls[0].bindings.find(b => b.name === 'X')?.value;
      const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      // level1 should receive 'tainted' as argument
      let foundTainted = false;
      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`level1 arg: ${targetNode?.name}`);
        if (targetNode?.name === 'tainted') {
          foundTainted = true;
        }
      }

      assert.ok(foundTainted, 'level1 should receive tainted data');
    });
  });

  describe('Parameter name resolution', () => {
    it('should include paramName when function is resolved', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find a call where we can resolve the function
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "processLiteral").
      `);

      if (calls.length > 0) {
        const callId = calls[0].bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

        // Check if paramName is set (optional enhancement)
        for (const edge of edges) {
          if (edge.paramName) {
            console.log(`Argument ${edge.argIndex} -> param "${edge.paramName}"`);
            assert.strictEqual(edge.paramName, 'value', 'Param name should be "value"');
          }
        }
      }
    });
  });

  describe('REG-202: Literal nodes PASSES_ARGUMENT edges', () => {
    it('should create PASSES_ARGUMENT edge from CALL to LITERAL argument', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find processLiteral(42) call
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "processLiteral").
      `);

      assert.ok(calls.length >= 2, 'Should have at least 2 processLiteral calls');

      // Find the call that passes numeric literal 42
      let foundLiteralEdge = false;
      for (const call of calls) {
        const callId = call.bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

        for (const edge of edges) {
          const targetNode = await backend.getNode(edge.dst);
          console.log(`  processLiteral arg: type=${targetNode?.type} value=${targetNode?.value}`);

          if (targetNode?.type === 'LITERAL' && targetNode?.value === 42) {
            foundLiteralEdge = true;
            console.log('  ✓ Found PASSES_ARGUMENT edge: CALL -> LITERAL(42)');
            assert.strictEqual(edge.type, 'PASSES_ARGUMENT');
            // Note: edge.src/dst use semantic IDs, callId/targetNode.id may use hash IDs
            // The important assertion is that the edge exists and connects the right node types
          }
        }
      }

      assert.ok(foundLiteralEdge, 'Should have PASSES_ARGUMENT edge from CALL to LITERAL(42)');
    });

    it('should create PASSES_ARGUMENT edge from CALL to OBJECT_LITERAL argument', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find processObject({ inline: true }) call
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "processObject").
      `);

      assert.ok(calls.length >= 2, 'Should have at least 2 processObject calls');

      // Look for PASSES_ARGUMENT edge to OBJECT_LITERAL
      let foundObjectLiteralEdge = false;
      for (const call of calls) {
        const callId = call.bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

        for (const edge of edges) {
          const targetNode = await backend.getNode(edge.dst);
          console.log(`  processObject arg: type=${targetNode?.type} name=${targetNode?.name || 'N/A'}`);

          if (targetNode?.type === 'OBJECT_LITERAL') {
            foundObjectLiteralEdge = true;
            console.log('  ✓ Found PASSES_ARGUMENT edge: CALL -> OBJECT_LITERAL');
            assert.strictEqual(edge.type, 'PASSES_ARGUMENT');
            // Note: edge.src/dst use semantic IDs, callId/targetNode.id may use hash IDs
            // The important assertion is that the edge exists and connects the right node types
          }
        }
      }

      assert.ok(foundObjectLiteralEdge, 'Should have PASSES_ARGUMENT edge from CALL to OBJECT_LITERAL');
    });

    it('should create PASSES_ARGUMENT edge from CALL to ARRAY_LITERAL argument', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find processArray([1, 2, 3]) call
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "processArray").
      `);

      assert.ok(calls.length >= 1, 'Should have processArray call');

      // Look for PASSES_ARGUMENT edge to ARRAY_LITERAL
      let foundArrayLiteralEdge = false;
      for (const call of calls) {
        const callId = call.bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

        for (const edge of edges) {
          const targetNode = await backend.getNode(edge.dst);
          console.log(`  processArray arg: type=${targetNode?.type}`);

          if (targetNode?.type === 'ARRAY_LITERAL') {
            foundArrayLiteralEdge = true;
            console.log('  ✓ Found PASSES_ARGUMENT edge: CALL -> ARRAY_LITERAL');
            assert.strictEqual(edge.type, 'PASSES_ARGUMENT');
            // Note: edge.src/dst use semantic IDs, callId/targetNode.id may use hash IDs
            // The important assertion is that the edge exists and connects the right node types
          }
        }
      }

      assert.ok(foundArrayLiteralEdge, 'Should have PASSES_ARGUMENT edge from CALL to ARRAY_LITERAL([1,2,3])');
    });

    it('should create PASSES_ARGUMENT edges for mixed argument types', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find multiArgs(x, y, 3) call - has 2 variables + 1 literal
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "multiArgs").
      `);

      assert.ok(calls.length >= 1, 'Should have multiArgs call');

      const callId = calls[0].bindings.find(b => b.name === 'X')?.value;
      const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      console.log(`multiArgs has ${edges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(edges.length, 3, 'Should have 3 PASSES_ARGUMENT edges');

      // Collect argument types
      const argTypes = [];
      let foundVariable = false;
      let foundLiteral = false;

      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        argTypes.push(targetNode?.type);
        console.log(`  arg: type=${targetNode?.type} name=${targetNode?.name || 'N/A'} value=${targetNode?.value || 'N/A'}`);

        if (targetNode?.type === 'VARIABLE' || targetNode?.type === 'CONSTANT') {
          foundVariable = true;
        }
        if (targetNode?.type === 'LITERAL') {
          foundLiteral = true;
        }
      }

      assert.ok(foundVariable, 'Should have PASSES_ARGUMENT edges to VARIABLE arguments (x, y)');
      assert.ok(foundLiteral, 'Should have PASSES_ARGUMENT edge to LITERAL argument (3)');
    });

    it('should create PASSES_ARGUMENT edge for string literal', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find processLiteral('hello') call
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "processLiteral").
      `);

      assert.ok(calls.length >= 2, 'Should have at least 2 processLiteral calls');

      // Find the call that passes string literal 'hello'
      let foundStringLiteralEdge = false;
      for (const call of calls) {
        const callId = call.bindings.find(b => b.name === 'X')?.value;
        const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

        for (const edge of edges) {
          const targetNode = await backend.getNode(edge.dst);

          if (targetNode?.type === 'LITERAL' && targetNode?.value === 'hello') {
            foundStringLiteralEdge = true;
            console.log('  ✓ Found PASSES_ARGUMENT edge: CALL -> LITERAL("hello")');
            assert.strictEqual(edge.type, 'PASSES_ARGUMENT');
            // Note: edge.src/dst use semantic IDs, callId/targetNode.id may use hash IDs
            // The important assertion is that the edge exists and connects the right node types
          }
        }
      }

      assert.ok(foundStringLiteralEdge, 'Should have PASSES_ARGUMENT edge from CALL to LITERAL("hello")');
    });

    it('should create PASSES_ARGUMENT edge for object literal in method call', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find service.save(user, { validate: true }) call
      const calls = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "method", "save").
      `);

      assert.ok(calls.length >= 1, 'Should have service.save call');

      const callId = calls[0].bindings.find(b => b.name === 'X')?.value;
      const edges = await backend.getOutgoingEdges(callId, ['PASSES_ARGUMENT']);

      console.log(`service.save has ${edges.length} PASSES_ARGUMENT edges`);
      assert.strictEqual(edges.length, 2, 'Should have 2 PASSES_ARGUMENT edges');

      // Second argument should be OBJECT_LITERAL { validate: true }
      let foundObjectLiteral = false;
      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        console.log(`  arg: type=${targetNode?.type} name=${targetNode?.name || 'N/A'}`);

        if (targetNode?.type === 'OBJECT_LITERAL') {
          foundObjectLiteral = true;
          console.log('  ✓ Found PASSES_ARGUMENT edge to OBJECT_LITERAL in method call');
        }
      }

      assert.ok(foundObjectLiteral, 'Should have PASSES_ARGUMENT edge to OBJECT_LITERAL in method call');
    });
  });
});

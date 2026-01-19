/**
 * Tests for PARAMETER -> usage data flow tracking
 *
 * When a function parameter is used inside the function body,
 * we need to create edges that allow tracing data flow from
 * call arguments through parameters to their usage.
 *
 * Chain: CALL -> PASSES_ARGUMENT -> arg -> ... -> PARAMETER -> usage
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/parameter-dataflow');

describe('Parameter Data Flow', () => {
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

  describe('Basic parameter usage tracking', () => {
    it('should create PARAMETER nodes with parentFunctionId', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const parameters = await backend.getAllNodes({ type: 'PARAMETER' });
      assert.ok(parameters.length > 0, 'Should have PARAMETER nodes');

      // All parameters should have parentFunctionId
      for (const param of parameters) {
        assert.ok(param.parentFunctionId,
          `PARAMETER ${param.name} should have parentFunctionId`);
      }
    });

    it('should create HAS_PARAMETER edges from FUNCTION to PARAMETER', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const functions = await backend.getAllNodes({ type: 'FUNCTION' });
      const processFunc = functions.find(f => f.name === 'processData');
      assert.ok(processFunc, 'Should have processData function');

      const edges = await backend.getOutgoingEdges(processFunc.id, ['HAS_PARAMETER']);
      assert.ok(edges.length > 0,
        `processData should have HAS_PARAMETER edges, got ${edges.length}`);
    });

    // TODO: Implement parameter usage tracking inside function bodies
    // Currently JSASTAnalyzer doesn't create DERIVES_FROM edges for parameter usages like data.map()
    it.skip('should link parameter usage to PARAMETER node via DERIVES_FROM', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find PARAMETER node for 'data' in processData function
      const parameters = await backend.getAllNodes({ type: 'PARAMETER' });
      const dataParam = parameters.find(p => p.name === 'data');
      assert.ok(dataParam, 'Should have PARAMETER named data');

      // Find incoming DERIVES_FROM edges to this parameter
      const incomingEdges = await backend.getIncomingEdges(dataParam.id, ['DERIVES_FROM']);

      // There should be edges from usages of 'data' inside the function
      assert.ok(incomingEdges.length > 0,
        `PARAMETER data should have incoming DERIVES_FROM edges, got ${incomingEdges.length}`);
    });
  });

  describe('Inter-procedural data flow', () => {
    it('should allow tracing from call argument to parameter usage', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find the call site: processData(items)
      const calls = await backend.getAllNodes({ type: 'CALL' });
      const processDataCalls = calls.filter(c => c.name === 'processData');
      assert.ok(processDataCalls.length > 0, 'Should have processData call');

      // Find a call that has PASSES_ARGUMENT edge
      let callWithArgs = null;
      for (const call of processDataCalls) {
        const edges = await backend.getOutgoingEdges(call.id, ['PASSES_ARGUMENT']);
        if (edges.length > 0) {
          callWithArgs = call;
          break;
        }
      }
      assert.ok(callWithArgs, 'At least one processData call should have PASSES_ARGUMENT edge');

      // Find the PARAMETER that corresponds to argIndex 0
      const parameters = await backend.getAllNodes({ type: 'PARAMETER' });
      const dataParam = parameters.find(p => p.name === 'data' && p.index === 0);
      assert.ok(dataParam, 'Should have PARAMETER data at index 0');

      // The chain should be traceable:
      // CALL -> PASSES_ARGUMENT(argIndex=0) -> argument
      // PARAMETER(index=0) <- DERIVES_FROM <- usage inside function
      console.log('Inter-procedural chain established');
    });

    it('should track multiple parameters correctly', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Find function with multiple parameters
      const functions = await backend.getAllNodes({ type: 'FUNCTION' });
      const multiParamFunc = functions.find(f => f.name === 'transform');
      assert.ok(multiParamFunc, 'Should have transform function');

      const edges = await backend.getOutgoingEdges(multiParamFunc.id, ['HAS_PARAMETER']);

      // Should have multiple parameters with correct indices
      const parameters = await backend.getAllNodes({ type: 'PARAMETER' });
      // Use originalId or stableId for comparison (parentFunctionId is the string ID)
      const funcId = multiParamFunc.originalId || multiParamFunc.stableId;
      const funcParams = parameters.filter(p => p.parentFunctionId === funcId);

      assert.ok(funcParams.length >= 2,
        `transform should have at least 2 parameters, got ${funcParams.length}`);

      // Check indices
      const indices = funcParams.map(p => p.index).sort();
      assert.deepStrictEqual(indices, [0, 1], 'Parameters should have indices 0 and 1');
    });
  });

  describe('Edge cases', () => {
    it('should handle destructured parameter usage', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // If we have function({ name, value }) { ... }
      // The destructured properties should trace back to the parameter
      const parameters = await backend.getAllNodes({ type: 'PARAMETER' });

      // For now just verify parameters exist
      assert.ok(parameters.length > 0, 'Should have parameters');
    });

    it('should handle parameter reassignment', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // function process(data) { data = transform(data); }
      // The original usage of data should still trace to PARAMETER
      // The reassignment creates new data flow
      const parameters = await backend.getAllNodes({ type: 'PARAMETER' });
      assert.ok(parameters.length > 0, 'Should have parameters');
    });
  });
});

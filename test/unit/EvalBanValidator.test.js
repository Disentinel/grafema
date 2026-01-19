/**
 * Tests for EvalBanValidator
 *
 * Проверяет детекцию:
 * - eval() прямые вызовы
 * - Function() конструктор
 * - obj.eval() method calls
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { EvalBanValidator } from '@grafema/core';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/eval-ban');

describe('EvalBanValidator', () => {
  let backend;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();  // Initialize the Rust engine
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  describe('Direct eval detection', () => {
    it('should detect eval() calls via Datalog', async () => {
      // Analyze the project
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Run Datalog query for eval calls
      const evalViolations = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "eval").
      `);

      assert.ok(evalViolations.length >= 2, `Should detect at least 2 eval calls, got ${evalViolations.length}`);
    });
  });

  describe('Function constructor detection', () => {
    it('should detect Function() calls via Datalog', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const functionViolations = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "Function").
      `);

      // Detects both Function() and new Function():
      // - line 4: new Function('a', 'b', 'return a + b')
      // - line 8: Function('a', 'b', 'return a * b')
      // - line 13: new Function('a', 'b', 'return a / b')
      assert.ok(functionViolations.length >= 3, `Should detect at least 3 Function calls, got ${functionViolations.length}`);
    });
  });

  describe('Method eval detection', () => {
    it('should detect obj.eval() method calls via Datalog', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const methodEvalViolations = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "method", "eval").
      `);

      // method-eval.js has obj.eval() and global.eval()
      assert.ok(methodEvalViolations.length >= 2, `Should have at least 2 eval method calls, got ${methodEvalViolations.length}`);
    });
  });

  describe('Safe code detection', () => {
    it('should not flag JSON.parse as eval', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Verify none of the eval violations are from safe-code.js
      const evalViolations = await backend.checkGuarantee(`
        violation(X) :- node(X, "CALL"), attr(X, "name", "eval").
      `);

      for (const v of evalViolations) {
        const nodeId = v.bindings.find(b => b.name === 'X')?.value;
        if (nodeId) {
          const node = await backend.getNode(nodeId);
          if (node && node.file) {
            assert.ok(!node.file.includes('safe-code.js'), 'safe-code.js should not have eval violations');
          }
        }
      }
    });
  });

  describe('Full validator execution', () => {
    it('should run EvalBanValidator and report issues', async () => {
      // Create validator instance and keep reference
      const validator = new EvalBanValidator();

      // Create orchestrator with the validator
      const orchestrator = createTestOrchestrator(backend, {
        extraPlugins: [validator]
      });

      // Run analysis - this initializes the backend
      await orchestrator.run(FIXTURE_PATH);

      // Now run validator on the already-initialized backend
      const result = await validator.execute({ graph: backend });

      assert.ok(result.success, 'Validator should succeed');
      assert.ok(result.metadata.summary, 'Should have summary');
      assert.ok(result.metadata.summary.totalViolations > 0, `Should detect violations, got ${result.metadata.summary.totalViolations}`);

      // Verify summary calculations
      const expectedTotal = result.metadata.summary.evalCalls +
                           result.metadata.summary.functionCalls +
                           result.metadata.summary.methodEvalCalls +
                           result.metadata.summary.aliasedEvalCalls;
      assert.strictEqual(result.metadata.summary.totalViolations, expectedTotal, 'totalViolations should equal sum');
    });

    it('should include file and line information in issues', async () => {
      const validator = new EvalBanValidator();
      const orchestrator = createTestOrchestrator(backend, {
        extraPlugins: [validator]
      });

      await orchestrator.run(FIXTURE_PATH);
      const result = await validator.execute({ graph: backend });

      assert.ok(result.metadata.issues.length > 0, 'Should have some issues');

      // All issues should have file and severity ERROR
      // Use BigInt-safe serializer for error messages
      const serializeIssue = (obj) => JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? v.toString() : v);
      for (const issue of result.metadata.issues) {
        assert.ok(issue.file, `Issue should have file: ${serializeIssue(issue)}`);
        assert.strictEqual(issue.severity, 'ERROR', `Issue severity should be ERROR: ${issue.severity}`);
        assert.ok(issue.message, 'Issue should have message');
        assert.ok(issue.nodeId, 'Issue should have nodeId');
      }
    });
  });
});

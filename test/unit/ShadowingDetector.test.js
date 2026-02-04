/**
 * Tests for ShadowingDetector
 *
 * Detects two types of shadowing:
 * 1. Cross-file: CLASS in one file, VARIABLE with same name in another
 * 2. Scope-aware: IMPORT shadowed by local VARIABLE inside function
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';

import { createTestDatabase } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { ShadowingDetector } from '@grafema/core';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/shadowing');

describe('ShadowingDetector', () => {
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

  describe('Cross-file shadowing detection', () => {
    it('should detect when VARIABLE shadows CLASS from another file', async () => {
      const validator = new ShadowingDetector();
      const orchestrator = createTestOrchestrator(backend, {
        extraPlugins: [validator]
      });

      await orchestrator.run(FIXTURE_PATH);
      const result = await validator.execute({ graph: backend });

      // cross-file-shadow.js has `const User = {...}` which shadows class User from models.js
      const crossFileIssues = result.metadata.issues.filter(i => i.type === 'CROSS_FILE_SHADOW');

      assert.ok(crossFileIssues.length >= 1,
        `Should detect at least 1 cross-file shadow, got ${crossFileIssues.length}`);

      // Verify that cross-file-shadow.js has shadowing issues
      const crossFileShadowIssues = crossFileIssues.filter(i =>
        i.file && i.file.includes('cross-file-shadow.js') && i.shadowedName === 'User'
      );
      assert.ok(crossFileShadowIssues.length >= 1,
        `cross-file-shadow.js should have User shadowing issues, got ${crossFileShadowIssues.length}`);
    });

    it('should not flag variables with unique names', async () => {
      const validator = new ShadowingDetector();
      const orchestrator = createTestOrchestrator(backend, {
        extraPlugins: [validator]
      });

      await orchestrator.run(FIXTURE_PATH);
      const result = await validator.execute({ graph: backend });

      // userData and orderData should not be flagged
      const uniqueNameIssues = result.metadata.issues.filter(i =>
        i.shadowedName === 'userData' || i.shadowedName === 'orderData'
      );

      assert.strictEqual(uniqueNameIssues.length, 0,
        'userData/orderData should not shadow any class');
    });
  });

  describe('Scope-aware shadowing detection', () => {
    // NOTE: Scope-aware shadowing requires parentScopeId to be properly set
    // for variables inside functions. Currently this is a known limitation -
    // variables inside functions don't get parentScopeId populated.
    // This will be addressed when we implement proper scope tracking.

    it('should have infrastructure for scope shadow detection', async () => {
      const validator = new ShadowingDetector();
      const orchestrator = createTestOrchestrator(backend, {
        extraPlugins: [validator]
      });

      await orchestrator.run(FIXTURE_PATH);
      const result = await validator.execute({ graph: backend });

      // Verify the validator runs and returns proper structure
      assert.ok(result.success, 'Validator should succeed');
      assert.ok(result.metadata.summary.scopeShadows !== undefined,
        'Should have scopeShadows count in summary');

      // Currently scope shadows are 0 due to parentScopeId limitation
      // When fixed, this test should be updated to check for actual detections
      console.log('Scope shadows detected:', result.metadata.summary.scopeShadows);
    });

    it('should only flag scope shadows for variables with parentScopeId', async () => {
      const validator = new ShadowingDetector();
      const orchestrator = createTestOrchestrator(backend, {
        extraPlugins: [validator]
      });

      await orchestrator.run(FIXTURE_PATH);
      const result = await validator.execute({ graph: backend });

      // All scope shadow issues must have scope property
      const scopeIssues = result.metadata.issues.filter(i => i.type === 'SCOPE_SHADOW');

      for (const issue of scopeIssues) {
        assert.ok(issue.scope, `Scope shadow issue should have scope property: ${JSON.stringify(issue)}`);
      }
    });
  });

  describe('Full validator execution', () => {
    it('should run ShadowingDetector and report warnings', async () => {
      const validator = new ShadowingDetector();
      const orchestrator = createTestOrchestrator(backend, {
        extraPlugins: [validator]
      });

      await orchestrator.run(FIXTURE_PATH);
      const result = await validator.execute({ graph: backend });

      assert.ok(result.success, 'Validator should succeed');
      assert.ok(result.metadata.summary, 'Should have summary');
      assert.ok(result.metadata.issues.length > 0,
        `Should detect shadowing issues, got ${result.metadata.issues.length}`);

      // All issues should be WARNING severity (not ERROR like eval)
      for (const issue of result.metadata.issues) {
        assert.strictEqual(issue.severity, 'WARNING',
          `Shadowing should be WARNING, got ${issue.severity}`);
      }
    });

    it('should include shadowed and shadowing info in issues', async () => {
      const validator = new ShadowingDetector();
      const orchestrator = createTestOrchestrator(backend, {
        extraPlugins: [validator]
      });

      await orchestrator.run(FIXTURE_PATH);
      const result = await validator.execute({ graph: backend });

      assert.ok(result.metadata.issues.length > 0, 'Should have issues');

      // Issues should have both the shadowing variable and what it shadows
      for (const issue of result.metadata.issues) {
        assert.ok(issue.shadowingNodeId, 'Issue should have shadowingNodeId');
        assert.ok(issue.shadowedName, 'Issue should have shadowedName');
        assert.ok(issue.file, 'Issue should have file');
        assert.ok(issue.message, 'Issue should have message');
      }
    });

    it('should categorize cross-file and scope shadows separately', async () => {
      const validator = new ShadowingDetector();
      const orchestrator = createTestOrchestrator(backend, {
        extraPlugins: [validator]
      });

      await orchestrator.run(FIXTURE_PATH);
      const result = await validator.execute({ graph: backend });

      const crossFileIssues = result.metadata.issues.filter(i => i.type === 'CROSS_FILE_SHADOW');
      const scopeIssues = result.metadata.issues.filter(i => i.type === 'SCOPE_SHADOW');

      // Summary should have both counts
      assert.strictEqual(result.metadata.summary.crossFileShadows, crossFileIssues.length,
        'crossFileShadows count should match');
      assert.strictEqual(result.metadata.summary.scopeShadows, scopeIssues.length,
        'scopeShadows count should match');

      console.log('Cross-file shadows:', crossFileIssues.length);
      console.log('Scope shadows:', scopeIssues.length);
    });
  });

  describe('Edge cases', () => {
    it('should handle files with no shadowing issues', async () => {
      const validator = new ShadowingDetector();
      const orchestrator = createTestOrchestrator(backend, {
        extraPlugins: [validator]
      });

      await orchestrator.run(FIXTURE_PATH);
      const result = await validator.execute({ graph: backend });

      // no-shadow.js should not contribute any issues
      const noShadowIssues = result.metadata.issues.filter(i =>
        i.file && i.file.includes('no-shadow.js')
      );
      assert.strictEqual(noShadowIssues.length, 0,
        'no-shadow.js should have no shadowing issues');
    });
  });
});

/**
 * Tests for GuaranteeManager
 *
 * Tests:
 * - Creating guarantees
 * - Listing guarantees
 * - Checking guarantees (pass/fail)
 * - Delete guarantees
 * - Export/Import guarantees
 * - Drift detection
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from 'fs';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { GuaranteeManager } from '@grafema/core';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/eval-ban');
const TEST_GUARANTEES_FILE = join(process.cwd(), 'test/fixtures/.rflow-test/guarantees.yaml');

describe('GuaranteeManager', () => {
  let backend;
  let manager;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();

    // Analyze test fixture
    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(FIXTURE_PATH);

    manager = new GuaranteeManager(backend, FIXTURE_PATH);

    // Ensure test directory exists
    const testDir = join(process.cwd(), 'test/fixtures/.rflow-test');
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
    // Cleanup test file
    if (existsSync(TEST_GUARANTEES_FILE)) {
      unlinkSync(TEST_GUARANTEES_FILE);
    }
  });

  describe('create()', () => {
    it('should create a GUARANTEE node', async () => {
      const guarantee = await manager.create({
        id: 'test-guarantee',
        name: 'Test Guarantee',
        rule: 'violation(X) :- node(X, "CALL"), attr(X, "name", "eval").',
        severity: 'error',
        governs: ['**/*.js']
      });

      assert.strictEqual(guarantee.id, 'GUARANTEE:test-guarantee');
      assert.strictEqual(guarantee.type, 'GUARANTEE');
      assert.strictEqual(guarantee.severity, 'error');

      // Verify node exists in graph
      const node = await backend.getNode('GUARANTEE:test-guarantee');
      assert.ok(node, 'GUARANTEE node should exist in graph');
    });

    it('should create GOVERNS edges to matching modules', async () => {
      await manager.create({
        id: 'test-governs',
        rule: 'violation(X) :- node(X, "CALL").',
        governs: ['**/*.js']
      });

      const edges = await backend.getOutgoingEdges('GUARANTEE:test-governs', ['GOVERNS']);
      assert.ok(edges.length > 0, 'Should create GOVERNS edges to modules');
    });

    it('should reject guarantee without id', async () => {
      await assert.rejects(
        () => manager.create({ rule: 'violation(X) :- node(X, "CALL").' }),
        /must have id/
      );
    });

    it('should reject guarantee without rule', async () => {
      await assert.rejects(
        () => manager.create({ id: 'no-rule' }),
        /must have.*rule/
      );
    });
  });

  describe('list()', () => {
    it('should return empty array when no guarantees', async () => {
      const guarantees = await manager.list();
      assert.strictEqual(guarantees.length, 0);
    });

    it('should list created guarantees', async () => {
      await manager.create({ id: 'g1', rule: 'violation(X) :- node(X, "CALL").' });
      await manager.create({ id: 'g2', rule: 'violation(X) :- node(X, "FUNCTION").' });

      const guarantees = await manager.list();
      assert.strictEqual(guarantees.length, 2);

      const ids = guarantees.map(g => g.id);
      assert.ok(ids.includes('GUARANTEE:g1'));
      assert.ok(ids.includes('GUARANTEE:g2'));
    });
  });

  describe('check()', () => {
    it('should pass guarantee with no violations', async () => {
      // Create a guarantee that should pass (no nodes named "nonexistent")
      await manager.create({
        id: 'pass-test',
        rule: 'violation(X) :- node(X, "CALL"), attr(X, "name", "nonexistent_function_xyz").',
        severity: 'error'
      });

      const result = await manager.check('pass-test');
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.violationCount, 0);
    });

    it('should fail guarantee with violations', async () => {
      // Create a guarantee that should fail (eval calls exist in fixture)
      await manager.create({
        id: 'fail-test',
        rule: 'violation(X) :- node(X, "CALL"), attr(X, "name", "eval").',
        severity: 'error'
      });

      const result = await manager.check('fail-test');
      assert.strictEqual(result.passed, false);
      assert.ok(result.violationCount > 0, 'Should have violations');
      assert.ok(result.violations.length > 0, 'Should return violation details');
    });

    it('should return error for invalid rule', async () => {
      await manager.create({
        id: 'invalid-rule',
        rule: 'this is not valid datalog',
        severity: 'error'
      });

      const result = await manager.check('invalid-rule');
      assert.ok(result.error, 'Should have error');
    });
  });

  describe('checkAll()', () => {
    it('should check all guarantees', async () => {
      await manager.create({
        id: 'check-all-1',
        rule: 'violation(X) :- node(X, "CALL"), attr(X, "name", "nonexistent").'
      });
      await manager.create({
        id: 'check-all-2',
        rule: 'violation(X) :- node(X, "CALL"), attr(X, "name", "eval").'
      });

      const result = await manager.checkAll();
      assert.strictEqual(result.total, 2);
      assert.strictEqual(result.passed, 1);
      assert.strictEqual(result.failed, 1);
    });
  });

  describe('delete()', () => {
    it('should delete guarantee and its edges', async () => {
      await manager.create({ id: 'to-delete', rule: 'violation(X) :- node(X, "CALL").' });

      // Verify it exists
      let guarantees = await manager.list();
      assert.strictEqual(guarantees.length, 1);

      // Delete
      await manager.delete('to-delete');

      // Verify it's gone
      guarantees = await manager.list();
      assert.strictEqual(guarantees.length, 0);

      // Verify node is gone
      const node = await backend.getNode('GUARANTEE:to-delete');
      assert.strictEqual(node, null);
    });
  });

  describe('export() / import()', () => {
    it('should export guarantees to YAML', async () => {
      await manager.create({
        id: 'export-test',
        name: 'Export Test',
        rule: 'violation(X) :- node(X, "CALL").',
        severity: 'warning',
        governs: ['src/**/*.js']
      });

      const filePath = await manager.export(TEST_GUARANTEES_FILE);
      assert.ok(existsSync(filePath), 'File should be created');
    });

    it('should import guarantees from YAML', async () => {
      // Create and export
      await manager.create({
        id: 'import-test',
        name: 'Import Test',
        rule: 'violation(X) :- node(X, "CALL").',
        severity: 'error'
      });
      await manager.export(TEST_GUARANTEES_FILE);

      // Delete from graph
      await manager.delete('import-test');
      let guarantees = await manager.list();
      assert.strictEqual(guarantees.length, 0);

      // Import
      const result = await manager.import(TEST_GUARANTEES_FILE);
      assert.strictEqual(result.imported, 1);

      // Verify it's back
      guarantees = await manager.list();
      assert.strictEqual(guarantees.length, 1);
    });

    it('should skip existing guarantees on import', async () => {
      await manager.create({ id: 'existing', rule: 'violation(X) :- node(X, "CALL").' });
      await manager.export(TEST_GUARANTEES_FILE);

      // Try to import again
      const result = await manager.import(TEST_GUARANTEES_FILE);
      assert.strictEqual(result.imported, 0);
      assert.strictEqual(result.skipped, 1);
    });

    it('should clear existing on import with clearExisting=true', async () => {
      await manager.create({ id: 'old', rule: 'violation(X) :- node(X, "CALL").' });

      // Create file with different guarantee
      writeFileSync(TEST_GUARANTEES_FILE, `
version: 1
guarantees:
  - id: new
    name: New Guarantee
    rule: 'violation(X) :- node(X, "FUNCTION").'
    severity: warning
    governs: ['**/*.js']
`);

      const result = await manager.import(TEST_GUARANTEES_FILE, { clearExisting: true });
      assert.strictEqual(result.imported, 1);

      const guarantees = await manager.list();
      assert.strictEqual(guarantees.length, 1);
      assert.ok(guarantees[0].id.includes('new'));
    });
  });

  describe('drift()', () => {
    it('should detect no drift when graph matches file', async () => {
      await manager.create({ id: 'no-drift', rule: 'violation(X) :- node(X, "CALL").' });
      await manager.export(TEST_GUARANTEES_FILE);

      const drift = await manager.drift(TEST_GUARANTEES_FILE);
      assert.strictEqual(drift.hasDrift, false);
    });

    it('should detect uncommitted guarantees', async () => {
      // Export empty file
      await manager.export(TEST_GUARANTEES_FILE);

      // Create guarantee in graph (uncommitted)
      await manager.create({ id: 'uncommitted', rule: 'violation(X) :- node(X, "CALL").' });

      const drift = await manager.drift(TEST_GUARANTEES_FILE);
      assert.strictEqual(drift.hasDrift, true);
      assert.ok(drift.onlyInGraph.includes('uncommitted'));
    });

    it('should detect deleted guarantees', async () => {
      await manager.create({ id: 'will-delete', rule: 'violation(X) :- node(X, "CALL").' });
      await manager.export(TEST_GUARANTEES_FILE);

      // Delete from graph
      await manager.delete('will-delete');

      const drift = await manager.drift(TEST_GUARANTEES_FILE);
      assert.strictEqual(drift.hasDrift, true);
      assert.ok(drift.onlyInFile.includes('will-delete'));
    });
  });
});

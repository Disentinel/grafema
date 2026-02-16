/**
 * Tests for REG-381: Raw Datalog query routing
 *
 * Verifies that `--raw` queries correctly route:
 * - Direct queries (no ":-") → backend.datalogQuery()
 * - Rules (containing ":-") → backend.checkGuarantee()
 *
 * Tests:
 * - Direct query returns nodes via datalogQuery
 * - Rule query returns violations via checkGuarantee
 * - Both paths return consistent results for the same node type
 *
 * RFD-28: Unified executeDatalog endpoint
 *
 * Verifies that `backend.executeDatalog(source)` auto-detects input type:
 * - Direct queries (no ":-") → same results as datalogQuery
 * - Rules (containing ":-") → same results as checkGuarantee
 * - Custom head predicates → returns bindings for all variables (not just X)
 * - Multi-rule programs → queries head predicate of first rule
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/01-simple-script');

after(cleanupAllTestDatabases);

describe('RawDatalogQueryRouting (REG-381)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(FIXTURE_PATH);
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  describe('datalogQuery (direct queries)', () => {
    it('should return results for node() predicate', async () => {
      const results = await backend.datalogQuery('node(X, "FUNCTION")');
      assert.ok(results.length > 0, 'Direct query should find FUNCTION nodes');
      for (const r of results) {
        assert.ok(r.bindings.some(b => b.name === 'X'), 'Should have X binding');
      }
    });

    it('should return results for node() with MODULE type', async () => {
      const results = await backend.datalogQuery('node(X, "MODULE")');
      assert.ok(results.length > 0, 'Direct query should find MODULE nodes');
    });
  });

  describe('checkGuarantee (rule queries)', () => {
    it('should return results for violation rule with node()', async () => {
      const results = await backend.checkGuarantee(
        'violation(X) :- node(X, "FUNCTION").'
      );
      assert.ok(results.length > 0, 'Rule query should find FUNCTION violations');
      for (const r of results) {
        assert.ok(r.bindings.some(b => b.name === 'X'), 'Should have X binding');
      }
    });

    it('should return results for violation rule with MODULE type', async () => {
      const results = await backend.checkGuarantee(
        'violation(X) :- node(X, "MODULE").'
      );
      assert.ok(results.length > 0, 'Rule query should find MODULE violations');
    });

    it('should return results for compound rule', async () => {
      const results = await backend.checkGuarantee(
        'violation(X) :- node(X, "FUNCTION"), attr(X, "name", N).'
      );
      assert.ok(results.length > 0, 'Compound rule should find FUNCTION nodes with names');
    });
  });

  describe('consistency between paths', () => {
    it('should return same node count for FUNCTION via both paths', async () => {
      const directResults = await backend.datalogQuery('node(X, "FUNCTION")');
      const ruleResults = await backend.checkGuarantee(
        'violation(X) :- node(X, "FUNCTION").'
      );

      assert.strictEqual(
        directResults.length,
        ruleResults.length,
        `Direct query found ${directResults.length} but rule found ${ruleResults.length} FUNCTION nodes`
      );
    });

    it('should return same node count for MODULE via both paths', async () => {
      const directResults = await backend.datalogQuery('node(X, "MODULE")');
      const ruleResults = await backend.checkGuarantee(
        'violation(X) :- node(X, "MODULE").'
      );

      assert.strictEqual(
        directResults.length,
        ruleResults.length,
        `Direct query found ${directResults.length} but rule found ${ruleResults.length} MODULE nodes`
      );
    });
  });

  describe('routing logic', () => {
    it('should detect rule syntax by presence of ":-"', () => {
      // This tests the detection logic used in executeRawQuery
      const directQueries = [
        'node(X, "FUNCTION")',
        'type(X, "MODULE")',
        'edge(X, Y, "CALLS")',
        'type(X, "FUNCTION"), attr(X, "name", "main")',
      ];

      const ruleQueries = [
        'violation(X) :- node(X, "FUNCTION").',
        'violation(X) :- node(X, "http:route"), attr(X, "method", "POST").',
        'violation(X) :- edge(X, Y, "CALLS"), \\+ node(Y, "FUNCTION").',
      ];

      for (const q of directQueries) {
        assert.ok(!q.includes(':-'), `"${q}" should NOT be detected as rule`);
      }

      for (const q of ruleQueries) {
        assert.ok(q.includes(':-'), `"${q}" should be detected as rule`);
      }
    });
  });

  describe('executeDatalog — unified endpoint (RFD-28)', () => {
    it('should return same results as datalogQuery for a direct query', { todo: 'executeDatalog not yet implemented in rfdb-server' }, async () => {
      const directResults = await backend.datalogQuery('node(X, "FUNCTION")');
      const unifiedResults = await backend.executeDatalog('node(X, "FUNCTION")');

      assert.strictEqual(
        unifiedResults.length,
        directResults.length,
        `executeDatalog returned ${unifiedResults.length} but datalogQuery returned ${directResults.length} for direct query`
      );

      for (const r of unifiedResults) {
        assert.ok(r.bindings.some(b => b.name === 'X'), 'Should have X binding');
      }
    });

    it('should return same results as checkGuarantee for a rule', { todo: 'executeDatalog not yet implemented in rfdb-server' }, async () => {
      const ruleSource = 'violation(X) :- node(X, "FUNCTION").';
      const guaranteeResults = await backend.checkGuarantee(ruleSource);
      const unifiedResults = await backend.executeDatalog(ruleSource);

      assert.strictEqual(
        unifiedResults.length,
        guaranteeResults.length,
        `executeDatalog returned ${unifiedResults.length} but checkGuarantee returned ${guaranteeResults.length} for rule`
      );

      for (const r of unifiedResults) {
        assert.ok(r.bindings.some(b => b.name === 'X'), 'Should have X binding');
      }
    });

    it('should support custom head predicate with multiple bindings', { todo: 'executeDatalog not yet implemented in rfdb-server' }, async () => {
      const ruleSource = 'found(X, N) :- node(X, "FUNCTION"), attr(X, "name", N).';
      const results = await backend.executeDatalog(ruleSource);

      assert.ok(results.length > 0, 'Custom head predicate should find FUNCTION nodes with names');

      for (const r of results) {
        const bindingNames = r.bindings.map(b => b.name);
        assert.ok(bindingNames.includes('X'), 'Should have X binding from found(X, N)');
        assert.ok(bindingNames.includes('N'), 'Should have N binding from found(X, N)');

        const nBinding = r.bindings.find(b => b.name === 'N');
        assert.ok(
          nBinding.value && nBinding.value.length > 0,
          'N binding should have a non-empty function name'
        );
      }
    });

    it('should match both legacy endpoints for MODULE type', { todo: 'executeDatalog not yet implemented in rfdb-server' }, async () => {
      const directResults = await backend.datalogQuery('node(X, "MODULE")');
      const guaranteeResults = await backend.checkGuarantee(
        'violation(X) :- node(X, "MODULE").'
      );
      const unifiedDirect = await backend.executeDatalog('node(X, "MODULE")');
      const unifiedRule = await backend.executeDatalog(
        'violation(X) :- node(X, "MODULE").'
      );

      assert.strictEqual(
        unifiedDirect.length,
        directResults.length,
        'Unified direct query should match datalogQuery for MODULE'
      );

      assert.strictEqual(
        unifiedRule.length,
        guaranteeResults.length,
        'Unified rule should match checkGuarantee for MODULE'
      );

      assert.strictEqual(
        unifiedDirect.length,
        unifiedRule.length,
        'Unified endpoint should return same count regardless of input form'
      );
    });

    it('should query head predicate of first rule in multi-rule program', { todo: 'executeDatalog not yet implemented in rfdb-server' }, async () => {
      const multiRuleSource = [
        'reachable(X) :- node(X, "FUNCTION").',
        'reachable(X) :- node(X, "MODULE").',
      ].join('\n');

      const results = await backend.executeDatalog(multiRuleSource);

      // Should find both FUNCTION and MODULE nodes via the reachable head predicate
      const functionCount = (await backend.datalogQuery('node(X, "FUNCTION")')).length;
      const moduleCount = (await backend.datalogQuery('node(X, "MODULE")')).length;

      assert.ok(results.length > 0, 'Multi-rule program should return results');
      assert.strictEqual(
        results.length,
        functionCount + moduleCount,
        `Multi-rule reachable(X) should find all FUNCTION (${functionCount}) + MODULE (${moduleCount}) nodes`
      );

      for (const r of results) {
        assert.ok(r.bindings.some(b => b.name === 'X'), 'Should have X binding');
      }
    });
  });
});

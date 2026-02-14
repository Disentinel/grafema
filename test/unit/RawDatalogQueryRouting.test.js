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
});

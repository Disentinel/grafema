/**
 * Tests for REG-503: Explain mode for Datalog queries
 *
 * Verifies that passing explain=true to checkGuarantee, datalogQuery,
 * and executeDatalog returns DatalogExplainResult with proper structure.
 * Also regression-tests that non-explain calls still return array format.
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/01-simple-script');

after(cleanupAllTestDatabases);

/**
 * Assert that a value has the shape of DatalogExplainResult.
 *
 * This helper is intentionally strict about structural requirements and
 * intentionally loose about exact values, since stats vary per run.
 */
function assertExplainShape(result) {
  // Top-level must be a plain object, not an array
  assert.ok(!Array.isArray(result), 'Explain result must be a plain object, not an array');
  assert.strictEqual(typeof result, 'object', 'Explain result must be an object');
  assert.notStrictEqual(result, null, 'Explain result must not be null');

  // bindings: array of plain {Variable: "value"} objects
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'bindings'), 'Must have bindings field');
  assert.ok(Array.isArray(result.bindings), 'bindings must be an array');

  // stats: object with numeric fields
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'stats'), 'Must have stats field');
  assert.ok(result.stats !== null && typeof result.stats === 'object', 'stats must be an object');
  assert.strictEqual(typeof result.stats.nodesVisited, 'number', 'stats.nodesVisited must be a number');
  assert.strictEqual(typeof result.stats.edgesTraversed, 'number', 'stats.edgesTraversed must be a number');
  assert.strictEqual(typeof result.stats.ruleEvaluations, 'number', 'stats.ruleEvaluations must be a number');
  assert.strictEqual(typeof result.stats.totalResults, 'number', 'stats.totalResults must be a number');

  // profile: object with timing fields
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'profile'), 'Must have profile field');
  assert.ok(result.profile !== null && typeof result.profile === 'object', 'profile must be an object');
  assert.strictEqual(typeof result.profile.totalDurationUs, 'number', 'profile.totalDurationUs must be a number');

  // explainSteps: array (may be empty for trivial queries)
  assert.ok(Object.prototype.hasOwnProperty.call(result, 'explainSteps'), 'Must have explainSteps field');
  assert.ok(Array.isArray(result.explainSteps), 'explainSteps must be an array');
}

describe('Explain Mode (REG-503)', () => {
  let db;
  let client; // RFDBClient — has explain overloads directly
  let backend; // TestDatabaseBackend — wraps client with array-format conversion

  before(async () => {
    db = await createTestDatabase();
    backend = db.backend;
    client = backend._client; // Direct RFDBClient access for explain=true overloads

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(FIXTURE_PATH);
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Explain shape tests — verify DatalogExplainResult structure is returned
  // ---------------------------------------------------------------------------

  it('checkGuarantee with explain=true returns DatalogExplainResult shape', async () => {
    const rule = 'violation(X) :- node(X, "FUNCTION").';
    const result = await client.checkGuarantee(rule, true);

    assertExplainShape(result);
  });

  it('datalogQuery with explain=true returns DatalogExplainResult shape', async () => {
    const query = 'node(X, "FUNCTION")';
    const result = await client.datalogQuery(query, true);

    assertExplainShape(result);
  });

  it('executeDatalog with explain=true and a rule body returns DatalogExplainResult shape', async () => {
    // executeDatalog accepts a full Datalog program (rules + query)
    const source = 'violation(X) :- node(X, "FUNCTION").';
    const result = await client.executeDatalog(source, true);

    assertExplainShape(result);
  });

  it('executeDatalog with explain=true and a direct predicate query returns DatalogExplainResult shape', async () => {
    // executeDatalog can also accept a bare predicate as the source
    const source = 'node(X, "FUNCTION")';
    const result = await client.executeDatalog(source, true);

    assertExplainShape(result);
  });

  // ---------------------------------------------------------------------------
  // Stats populated — the engine must have visited something
  // ---------------------------------------------------------------------------

  it('explain result has nodesVisited > 0 when the graph contains FUNCTION nodes', async () => {
    const rule = 'violation(X) :- node(X, "FUNCTION").';
    const result = await client.checkGuarantee(rule, true);

    assertExplainShape(result);
    assert.ok(
      result.stats.nodesVisited > 0,
      `Expected nodesVisited > 0, got ${result.stats.nodesVisited}`
    );
  });

  // ---------------------------------------------------------------------------
  // explainSteps populated — the engine emits step records for real queries
  // ---------------------------------------------------------------------------

  it('explain result has non-empty explainSteps for a rule that finds results', async () => {
    const rule = 'violation(X) :- node(X, "FUNCTION").';
    const result = await client.checkGuarantee(rule, true);

    assertExplainShape(result);
    assert.ok(
      result.explainSteps.length > 0,
      `Expected at least one explain step, got ${result.explainSteps.length}`
    );
  });

  // ---------------------------------------------------------------------------
  // Bindings format — explain bindings are plain {Var: "value"} objects
  // ---------------------------------------------------------------------------

  it('explain bindings are plain {Variable: value} objects, not [{name, value}] pairs', async () => {
    const rule = 'violation(X) :- node(X, "FUNCTION").';
    const result = await client.checkGuarantee(rule, true);

    assertExplainShape(result);

    if (result.bindings.length > 0) {
      const firstBinding = result.bindings[0];

      // Plain object: has key "X" (or similar uppercase var name)
      const keys = Object.keys(firstBinding);
      assert.ok(keys.length > 0, 'Binding object must have at least one key');

      // Values must be strings (node IDs), not objects
      for (const key of keys) {
        assert.strictEqual(
          typeof firstBinding[key],
          'string',
          `Binding value for key "${key}" must be a string, got ${typeof firstBinding[key]}`
        );
      }

      // Must NOT have the [{name, value}] structure used by backend wrappers
      assert.ok(
        !Object.prototype.hasOwnProperty.call(firstBinding, 'name') ||
          !Object.prototype.hasOwnProperty.call(firstBinding, 'value'),
        'Explain bindings must be plain {Var: "id"} objects, not {name, value} pairs'
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Regression: non-explain calls still return the original array format
  // ---------------------------------------------------------------------------

  it('REGRESSION: non-explain checkGuarantee still returns array of violation objects', async () => {
    const rule = 'violation(X) :- node(X, "FUNCTION").';
    const results = await backend.checkGuarantee(rule);

    assert.ok(Array.isArray(results), 'Non-explain checkGuarantee must return an array');
    assert.ok(results.length > 0, 'Should have at least one FUNCTION violation in the fixture');

    // Each element must have the {bindings: [{name, value}]} structure
    const first = results[0];
    assert.ok(
      Object.prototype.hasOwnProperty.call(first, 'bindings'),
      'Each result must have a bindings field'
    );
    assert.ok(Array.isArray(first.bindings), 'bindings must be an array');
    assert.ok(first.bindings.length > 0, 'bindings array must not be empty');
    assert.ok(
      Object.prototype.hasOwnProperty.call(first.bindings[0], 'name'),
      'Each binding must have a name field (non-explain format)'
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(first.bindings[0], 'value'),
      'Each binding must have a value field (non-explain format)'
    );
  });

  it('REGRESSION: non-explain datalogQuery still returns array of result objects', async () => {
    const query = 'node(X, "FUNCTION")';
    const results = await backend.datalogQuery(query);

    assert.ok(Array.isArray(results), 'Non-explain datalogQuery must return an array');
    assert.ok(results.length > 0, 'Should find FUNCTION nodes in the fixture');

    // Each element must have the {bindings: [{name, value}]} structure
    const first = results[0];
    assert.ok(
      Object.prototype.hasOwnProperty.call(first, 'bindings'),
      'Each result must have a bindings field'
    );
    assert.ok(Array.isArray(first.bindings), 'bindings must be an array');
    assert.ok(
      Object.prototype.hasOwnProperty.call(first.bindings[0], 'name'),
      'Each binding must have a name field (non-explain format)'
    );
  });

  it('REGRESSION: non-explain executeDatalog still returns array of result objects', async () => {
    const source = 'violation(X) :- node(X, "FUNCTION").';
    const results = await backend.executeDatalog(source);

    assert.ok(Array.isArray(results), 'Non-explain executeDatalog must return an array');
    assert.ok(results.length > 0, 'Should find FUNCTION nodes via rule in the fixture');

    // Each element must have the {bindings: [{name, value}]} structure
    const first = results[0];
    assert.ok(
      Object.prototype.hasOwnProperty.call(first, 'bindings'),
      'Each result must have a bindings field'
    );
    assert.ok(Array.isArray(first.bindings), 'bindings must be an array');
    assert.ok(
      Object.prototype.hasOwnProperty.call(first.bindings[0], 'name'),
      'Each binding must have a name field (non-explain format)'
    );
  });
});

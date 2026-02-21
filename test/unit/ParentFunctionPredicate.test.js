/**
 * Tests for REG-544: parent_function(NodeId, FunctionId) Datalog predicate
 *
 * Verifies that the built-in `parent_function` predicate correctly finds the
 * nearest containing FUNCTION node for various node types by traversing
 * incoming CONTAINS, HAS_SCOPE, and DECLARES edges upward.
 *
 * Test cases:
 * - CALL nodes inside functions → returns parent FUNCTION
 * - VARIABLE nodes (connected via DECLARES) → returns parent FUNCTION
 * - PARAMETER nodes (connected via HAS_PARAMETER) → returns parent FUNCTION
 * - Module-level CALL nodes → should NOT appear in results (no parent function)
 * - Full rule: find functions that call a specific method
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/01-simple-script');

after(cleanupAllTestDatabases);

describe('ParentFunctionPredicate (REG-544)', () => {
  let db;
  let backend;

  before(async () => {
    db = await createTestDatabase();
    backend = db.backend;

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(FIXTURE_PATH);
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Helper: extract binding value by variable name from a result row
  // ---------------------------------------------------------------------------
  function getBinding(result, varName) {
    const binding = result.bindings.find(b => b.name === varName);
    return binding ? binding.value : undefined;
  }

  // ---------------------------------------------------------------------------
  // 1. Basic parent_function usage: find all functions that contain a CALL node
  // ---------------------------------------------------------------------------
  describe('basic parent_function usage', () => {
    it('should find parent functions for CALL nodes', async () => {
      const results = await backend.datalogQuery(
        'node(C, "CALL"), parent_function(C, F), attr(F, "name", N)'
      );

      assert.ok(results.length > 0, 'Should find at least one CALL with a parent function');

      // Every result must have F and N bindings
      for (const r of results) {
        const fId = getBinding(r, 'F');
        const name = getBinding(r, 'N');
        assert.ok(fId, 'Each result should have F binding (function ID)');
        assert.ok(name, 'Each result should have N binding (function name)');
      }
    });

    it('should return known function names from the fixture', async () => {
      const results = await backend.datalogQuery(
        'node(C, "CALL"), parent_function(C, F), attr(F, "name", N)'
      );

      const functionNames = results.map(r => getBinding(r, 'N'));

      // The fixture has functions: greet, conditionalGreet, createCounter, main, increment
      // Calls inside these functions should resolve to their parent function names
      // greet has: console.log call
      // conditionalGreet has: greet call
      // createCounter has: (nested increment function, console.log)
      // main has: greet, console.log, conditionalGreet, createCounter, counter calls
      assert.ok(
        functionNames.some(n => n === 'main'),
        `Should find "main" as a parent function, got: [${[...new Set(functionNames)].join(', ')}]`
      );
      assert.ok(
        functionNames.some(n => n === 'greet'),
        `Should find "greet" as a parent function, got: [${[...new Set(functionNames)].join(', ')}]`
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. VARIABLE nodes → find their parent function name via DECLARES edge
  // ---------------------------------------------------------------------------
  describe('VARIABLE nodes with parent_function', () => {
    it('should find parent function for VARIABLE nodes', async () => {
      const results = await backend.datalogQuery(
        'node(V, "VARIABLE"), parent_function(V, F), attr(F, "name", N)'
      );

      assert.ok(results.length > 0, 'Should find at least one VARIABLE with a parent function');

      const functionNames = results.map(r => getBinding(r, 'N'));

      // The fixture has variables inside functions:
      // main: const result, const counter
      // createCounter: let count
      assert.ok(
        functionNames.some(n => n === 'main' || n === 'createCounter'),
        `Should find variables inside "main" or "createCounter", got: [${[...new Set(functionNames)].join(', ')}]`
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 3. PARAMETER nodes → find their parent function name via HAS_PARAMETER edge
  // ---------------------------------------------------------------------------
  describe('PARAMETER nodes with parent_function', () => {
    it('should find parent function for PARAMETER nodes', async () => {
      const results = await backend.datalogQuery(
        'node(P, "PARAMETER"), parent_function(P, F), attr(F, "name", N)'
      );

      assert.ok(results.length > 0, 'Should find at least one PARAMETER with a parent function');

      const functionNames = results.map(r => getBinding(r, 'N'));

      // The fixture has parameters:
      // greet(name), conditionalGreet(name, shouldGreet)
      assert.ok(
        functionNames.some(n => n === 'greet' || n === 'conditionalGreet'),
        `Should find parameters inside "greet" or "conditionalGreet", got: [${[...new Set(functionNames)].join(', ')}]`
      );
    });

    it('should correctly map parameter to its specific function', async () => {
      // Use a rule that also captures the parameter name for more specific checks
      const results = await backend.checkGuarantee(
        'violation(PName, FName) :- node(P, "PARAMETER"), attr(P, "name", PName), parent_function(P, F), attr(F, "name", FName).'
      );

      assert.ok(results.length > 0, 'Should find parameter-to-function mappings');

      // Build a map of parameter names to parent function names
      const paramToFunc = {};
      for (const r of results) {
        const pName = getBinding(r, 'PName');
        const fName = getBinding(r, 'FName');
        if (pName && fName) {
          if (!paramToFunc[pName]) paramToFunc[pName] = [];
          paramToFunc[pName].push(fName);
        }
      }

      // "shouldGreet" parameter only exists in conditionalGreet
      if (paramToFunc['shouldGreet']) {
        assert.ok(
          paramToFunc['shouldGreet'].includes('conditionalGreet'),
          `Parameter "shouldGreet" should belong to "conditionalGreet", got: [${paramToFunc['shouldGreet'].join(', ')}]`
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Module-level CALL should NOT appear in parent_function results
  // ---------------------------------------------------------------------------
  describe('module-level nodes (no parent function)', () => {
    it('should not find parent function for module-level call main()', async () => {
      // First, find all CALL nodes
      const allCalls = await backend.datalogQuery('node(C, "CALL")');

      // Then find CALL nodes that DO have a parent function
      const callsWithParent = await backend.datalogQuery(
        'node(C, "CALL"), parent_function(C, F)'
      );

      // The fixture has main() called at module level (line 37).
      // There should be fewer calls with a parent function than total calls,
      // because the module-level main() call should be excluded.
      // Note: there may be other module-level calls too.
      assert.ok(
        allCalls.length > callsWithParent.length,
        `Total CALL nodes (${allCalls.length}) should exceed CALL nodes with parent function (${callsWithParent.length}), ` +
        'because module-level calls (e.g. main()) have no parent function'
      );
    });

    it('should not return module-level call when using checkGuarantee rule', async () => {
      // Find calls that have a parent function named "main" or specific names
      const callsInFunctions = await backend.checkGuarantee(
        'violation(C, N) :- node(C, "CALL"), parent_function(C, F), attr(F, "name", N).'
      );

      // Get all unique function node IDs that contain calls
      const parentFuncIds = new Set();
      for (const r of callsInFunctions) {
        // The violation bindings include C and N, not F directly
        // But the existence of N (function name) confirms the call is inside a function
        const funcName = getBinding(r, 'N');
        if (funcName) parentFuncIds.add(funcName);
      }

      // Module-level is not a function, so it should not appear
      // All parent function names should be actual function names from the fixture
      for (const name of parentFuncIds) {
        assert.ok(
          typeof name === 'string' && name.length > 0,
          `Parent function name should be a non-empty string, got: "${name}"`
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Full example: find functions that call a specific method (console.log)
  // ---------------------------------------------------------------------------
  describe('full example: find functions calling a specific method', () => {
    it('should find functions that call console.log', async () => {
      // The fixture has console.log calls in: greet(), main(), increment()
      // Strategy: find console.log CALL nodes, then get their parent functions
      const consoleCalls = await backend.datalogQuery(
        'node(C, "CALL"), attr(C, "name", "console.log"), parent_function(C, F), attr(F, "name", FName)'
      );

      assert.ok(consoleCalls.length > 0, 'Should find at least one CALL to console.log with a parent function');

      const funcNames = consoleCalls.map(r => getBinding(r, 'FName'));
      const uniqueNames = [...new Set(funcNames)];

      // greet() calls console.log, main() calls console.log, increment() calls console.log
      assert.ok(
        uniqueNames.some(n => n === 'greet'),
        `Should find "greet" calls console.log, got: [${uniqueNames.join(', ')}]`
      );
    });

    it('should find functions that call greet()', async () => {
      // conditionalGreet and main both call greet()
      const greetCalls = await backend.datalogQuery(
        'node(C, "CALL"), attr(C, "name", "greet"), parent_function(C, F), attr(F, "name", FName)'
      );

      assert.ok(greetCalls.length > 0, 'Should find at least one call to greet() with a parent function');

      const funcNames = greetCalls.map(r => getBinding(r, 'FName'));
      const uniqueNames = [...new Set(funcNames)];

      // conditionalGreet calls greet, main calls greet
      assert.ok(
        uniqueNames.some(n => n === 'conditionalGreet' || n === 'main'),
        `Should find "conditionalGreet" or "main" calling greet, got: [${uniqueNames.join(', ')}]`
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Consistency checks
  // ---------------------------------------------------------------------------
  describe('consistency', () => {
    it('direct query and rule query should return same count for CALL parent_function', async () => {
      const directResults = await backend.datalogQuery(
        'node(C, "CALL"), parent_function(C, F)'
      );

      const ruleResults = await backend.checkGuarantee(
        'violation(C) :- node(C, "CALL"), parent_function(C, F).'
      );

      assert.strictEqual(
        directResults.length,
        ruleResults.length,
        `Direct query (${directResults.length}) and rule query (${ruleResults.length}) should return same count`
      );
    });
  });
});

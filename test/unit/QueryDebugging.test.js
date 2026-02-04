/**
 * Tests for MCP Query Debugging features
 *
 * Tests:
 * - get_schema: schema introspection
 * - Empty query stats: helpful hints on empty results
 * - Explain mode: step-by-step query debugging
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';

import { createTestDatabase } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { levenshtein } from '@grafema/core';

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/01-simple-script');

describe('QueryDebugging', () => {
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

  describe('get_schema - Schema Introspection', () => {
    it('should return node type counts', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const nodeCounts = await backend.countNodesByType();

      assert.ok(typeof nodeCounts === 'object', 'Should return an object');
      assert.ok(Object.keys(nodeCounts).length > 0, 'Should have at least one node type');
      assert.ok(nodeCounts['MODULE'] > 0 || nodeCounts['FUNCTION'] > 0, 'Should have MODULE or FUNCTION nodes');
    });

    it('should return edge type counts', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const edgeCounts = await backend.countEdgesByType();

      assert.ok(typeof edgeCounts === 'object', 'Should return an object');
      assert.ok(Object.keys(edgeCounts).length > 0, 'Should have at least one edge type');
      assert.ok(edgeCounts['CONTAINS'] > 0, 'Should have CONTAINS edges');
    });

    it('should discover attributes by sampling nodes', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Sample a FUNCTION node and check its attributes
      let functionNode = null;
      for await (const node of backend.queryNodes({ type: 'FUNCTION' })) {
        functionNode = node;
        break;
      }

      if (functionNode) {
        const attrs = Object.keys(functionNode);
        assert.ok(attrs.includes('name') || attrs.includes('file'), 'FUNCTION should have name or file attribute');
      }
    });
  });

  describe('Empty Query Stats', () => {
    it('should detect non-existent node type', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const nodeCounts = await backend.countNodesByType();

      // Check that a misspelled type doesn't exist
      assert.strictEqual(nodeCounts['FUNCTON'], undefined, 'Misspelled type should not exist');
      assert.ok(nodeCounts['FUNCTION'] > 0, 'Correct type should exist');
    });

    it('should return empty results for non-existent type query', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const results = await backend.checkGuarantee(`
        violation(X) :- node(X, "NONEXISTENT_TYPE").
      `);

      assert.strictEqual(results.length, 0, 'Should return no results for non-existent type');
    });

    it('should find similar types for suggestions using Levenshtein', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      const nodeCounts = await backend.countNodesByType();
      const availableTypes = Object.keys(nodeCounts);

      // Simulate "did you mean" logic with Levenshtein distance
      const queriedType = 'FUNCTON'; // misspelled (1 char difference)
      const queriedLower = queriedType.toLowerCase();
      const similar = availableTypes.filter(t => {
        const dist = levenshtein(queriedLower, t.toLowerCase());
        return dist > 0 && dist <= 2;
      });

      assert.ok(similar.includes('FUNCTION'), 'Should suggest FUNCTION for FUNCTON (Levenshtein distance = 1)');
    });
  });

  describe('Explain Mode - Query Parsing', () => {
    // Helper: parse query predicates (same logic as in server.js)
    function parsePredicates(queryStr) {
      const bodyMatch = queryStr.match(/:-\s*(.+)\./s);
      if (!bodyMatch) return [];

      const body = bodyMatch[1];
      const predicates = [];
      let depth = 0;
      let current = '';

      for (const char of body) {
        if (char === '(') depth++;
        else if (char === ')') depth--;
        else if (char === ',' && depth === 0) {
          if (current.trim()) predicates.push(current.trim());
          current = '';
          continue;
        }
        current += char;
      }
      if (current.trim()) predicates.push(current.trim());

      return predicates;
    }

    it('should parse single predicate query', () => {
      const query = 'violation(X) :- node(X, "FUNCTION").';
      const predicates = parsePredicates(query);

      assert.strictEqual(predicates.length, 1);
      assert.strictEqual(predicates[0], 'node(X, "FUNCTION")');
    });

    it('should parse multi-predicate query', () => {
      const query = 'violation(X) :- node(X, "FUNCTION"), attr(X, "name", "foo").';
      const predicates = parsePredicates(query);

      assert.strictEqual(predicates.length, 2);
      assert.strictEqual(predicates[0], 'node(X, "FUNCTION")');
      assert.strictEqual(predicates[1], 'attr(X, "name", "foo")');
    });

    it('should parse complex query with nested parentheses', () => {
      const query = 'violation(X) :- node(X, "CALL"), attr(X, "name", "eval"), edge(X, Y, "CONTAINS").';
      const predicates = parsePredicates(query);

      assert.strictEqual(predicates.length, 3);
      assert.strictEqual(predicates[0], 'node(X, "CALL")');
      assert.strictEqual(predicates[1], 'attr(X, "name", "eval")');
      assert.strictEqual(predicates[2], 'edge(X, Y, "CONTAINS")');
    });

    it('should handle query with negation', () => {
      const query = 'violation(X) :- node(X, "CALL"), \\+ edge(X, _, "CALLS").';
      const predicates = parsePredicates(query);

      assert.strictEqual(predicates.length, 2);
      assert.strictEqual(predicates[0], 'node(X, "CALL")');
      assert.strictEqual(predicates[1], '\\+ edge(X, _, "CALLS")');
    });
  });

  describe('Explain Mode - Incremental Execution', () => {
    it('should run incremental sub-queries', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Query that narrows down results
      const query1 = 'violation(X) :- node(X, "FUNCTION").';
      const results1 = await backend.checkGuarantee(query1);

      const query2 = 'violation(X) :- node(X, "FUNCTION"), attr(X, "name", "nonexistent_function_name_xyz").';
      const results2 = await backend.checkGuarantee(query2);

      assert.ok(results1.length > 0, 'First predicate should have results');
      assert.strictEqual(results2.length, 0, 'Adding filter should narrow to zero');
    });

    it('should identify which predicate filters all results', async () => {
      const orchestrator = createTestOrchestrator(backend);
      await orchestrator.run(FIXTURE_PATH);

      // Simulate explain mode logic
      const predicates = [
        'node(X, "FUNCTION")',
        'attr(X, "name", "nonexistent_function_name_xyz")'
      ];

      let lastCount = null;
      let zeroAt = -1;

      for (let i = 0; i < predicates.length; i++) {
        const varMatch = predicates[0].match(/\(([A-Z][A-Za-z0-9_]*)/);
        const mainVar = varMatch ? varMatch[1] : 'X';
        const subQuery = `violation(${mainVar}) :- ${predicates.slice(0, i + 1).join(', ')}.`;

        const results = await backend.checkGuarantee(subQuery);
        const count = results.length;

        if (count === 0 && zeroAt === -1) {
          zeroAt = i;
        }
        lastCount = count;
      }

      assert.strictEqual(zeroAt, 1, 'Second predicate (attr filter) should be the one that filters all');
    });
  });
});

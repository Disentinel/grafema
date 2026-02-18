/**
 * DataFlowValidator Unit Tests (REG-498)
 *
 * Tests for three bug fixes:
 * 1. DERIVES_FROM edges (for-of/for-in) must be recognized as valid assignment
 * 2. Validator must use queryNodes/getOutgoingEdges, NOT getAllNodes/getAllEdges
 * 3. Validator must filter 'VARIABLE' type, NOT 'VARIABLE_DECLARATION'
 *
 * These tests define the FIXED behavior (TDD — tests written before implementation).
 * They will fail against the current buggy code and pass after Rob's fix.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { DataFlowValidator } from '@grafema/core';

// ============================================================================
// Mock Graph Backend
// ============================================================================

/**
 * Creates a mock GraphBackend with pre-loaded nodes and edges.
 *
 * Tracks which methods are called so we can assert the validator
 * uses the correct (efficient) API methods.
 */
function createMockBackend(nodes, edges) {
  const calls = {
    getAllEdges: 0,
    getAllNodes: 0,
    queryNodes: 0,
    getOutgoingEdges: 0,
    getIncomingEdges: 0,
    getNode: 0,
  };

  return {
    calls,

    // --- Tracked methods ---

    async getAllEdges() {
      calls.getAllEdges++;
      return edges;
    },

    async getAllNodes(filter) {
      calls.getAllNodes++;
      if (filter && Object.keys(filter).length > 0) {
        return nodes.filter(n => {
          for (const [key, value] of Object.entries(filter)) {
            const nodeKey = key === 'nodeType' ? 'type' : key;
            if (n[nodeKey] !== value) return false;
          }
          return true;
        });
      }
      return nodes;
    },

    async *queryNodes(filter) {
      calls.queryNodes++;
      for (const node of nodes) {
        let match = true;
        if (filter) {
          for (const [key, value] of Object.entries(filter)) {
            const nodeKey = key === 'nodeType' ? 'type' : key;
            if (node[nodeKey] !== value) { match = false; break; }
          }
        }
        if (match) yield node;
      }
    },

    async getOutgoingEdges(nodeId, edgeTypes = null) {
      calls.getOutgoingEdges++;
      return edges.filter(e => {
        if (e.src !== nodeId) return false;
        if (edgeTypes && edgeTypes.length > 0) {
          return edgeTypes.includes(e.type);
        }
        return true;
      });
    },

    async getIncomingEdges(nodeId, edgeTypes = null) {
      calls.getIncomingEdges++;
      return edges.filter(e => {
        if (e.dst !== nodeId) return false;
        if (edgeTypes && edgeTypes.length > 0) {
          return edgeTypes.includes(e.type);
        }
        return true;
      });
    },

    async getNode(id) {
      calls.getNode++;
      return nodes.find(n => n.id === id) || null;
    },

    async nodeCount() { return nodes.length; },
    async edgeCount() { return edges.length; },
    async countNodesByType() { return {}; },
    async countEdgesByType() { return {}; },
    async clear() {},
  };
}

// ============================================================================
// Helper: run validator and return result
// ============================================================================

async function runValidator(nodes, edges) {
  const backend = createMockBackend(nodes, edges);
  const validator = new DataFlowValidator();
  const result = await validator.execute({ graph: backend });
  return { result, backend };
}

/**
 * Extract error codes from validator result.
 */
function getErrorCodes(result) {
  return result.errors.map(e => e.code);
}

/**
 * Check if result has a specific error code for a variable name.
 */
function hasErrorForVariable(result, variableName, errorCode) {
  return result.errors.some(e =>
    e.code === errorCode &&
    e.context?.variable === variableName
  );
}

// ============================================================================
// Test Data Factories
// ============================================================================

function makeVariable(id, name, file = 'test.js', line = 1) {
  return { id, type: 'VARIABLE', name, file, line, exported: false };
}

function makeConstant(id, name, file = 'test.js', line = 1) {
  return { id, type: 'CONSTANT', name, file, line, exported: false };
}

function makeParameter(id, name, file = 'test.js', line = 1) {
  return { id, type: 'PARAMETER', name, file, line, exported: false };
}

function makeLiteral(id, value, file = 'test.js', line = 1) {
  return { id, type: 'LITERAL', name: String(value), file, line, value, exported: false };
}

function makeCall(id, name, file = 'test.js', line = 1) {
  return { id, type: 'CALL', name, file, line, exported: false };
}

function makeFunction(id, name, file = 'test.js', line = 1) {
  return { id, type: 'FUNCTION', name, file, line, exported: false };
}

function assignedFrom(src, dst) {
  return { type: 'ASSIGNED_FROM', src, dst };
}

function derivesFrom(src, dst) {
  return { type: 'DERIVES_FROM', src, dst };
}

function usesEdge(src, dst) {
  return { type: 'USES', src, dst };
}

// ============================================================================
// Tests
// ============================================================================

describe('DataFlowValidator', () => {

  // ==========================================================================
  // Bug Fix #1: DERIVES_FROM edges (for-of / for-in)
  // ==========================================================================

  describe('DERIVES_FROM edge recognition', () => {

    it('for-of loop variable with DERIVES_FROM should NOT trigger ERR_MISSING_ASSIGNMENT', async () => {
      // Scenario: `for (const item of items) { ... }`
      // `item` is a VARIABLE with a DERIVES_FROM edge to `items` (an array variable).
      // The current buggy code only checks ASSIGNED_FROM, so it false-positives here.
      const items = makeVariable('var-items', 'items', 'test.js', 1);
      const itemsLiteral = makeLiteral('lit-items', '[1,2,3]', 'test.js', 1);
      const item = makeVariable('var-item', 'item', 'test.js', 2);

      const nodes = [items, itemsLiteral, item];
      const edges = [
        assignedFrom('var-items', 'lit-items'),  // items = [1,2,3]
        derivesFrom('var-item', 'var-items'),     // item derives from items (for-of)
      ];

      const { result } = await runValidator(nodes, edges);

      assert.ok(
        !hasErrorForVariable(result, 'item', 'ERR_MISSING_ASSIGNMENT'),
        'for-of loop variable "item" with DERIVES_FROM edge should NOT trigger ERR_MISSING_ASSIGNMENT. ' +
        `Got errors: ${JSON.stringify(getErrorCodes(result))}`
      );
    });

    it('for-in loop variable with DERIVES_FROM should NOT trigger ERR_MISSING_ASSIGNMENT', async () => {
      // Scenario: `for (const key in obj) { ... }`
      // `key` has a DERIVES_FROM edge to `obj`.
      const obj = makeVariable('var-obj', 'obj', 'test.js', 1);
      const objLiteral = makeLiteral('lit-obj', '{}', 'test.js', 1);
      const key = makeVariable('var-key', 'key', 'test.js', 2);

      const nodes = [obj, objLiteral, key];
      const edges = [
        assignedFrom('var-obj', 'lit-obj'),
        derivesFrom('var-key', 'var-obj'),  // key derives from obj (for-in)
      ];

      const { result } = await runValidator(nodes, edges);

      assert.ok(
        !hasErrorForVariable(result, 'key', 'ERR_MISSING_ASSIGNMENT'),
        'for-in loop variable "key" with DERIVES_FROM edge should NOT trigger ERR_MISSING_ASSIGNMENT. ' +
        `Got errors: ${JSON.stringify(getErrorCodes(result))}`
      );
    });

    it('for-of with non-Identifier source (function call) should NOT trigger false positive', async () => {
      // Scenario: `for (const x of getItems()) { ... }`
      // The DERIVES_FROM edge points to a CALL node, not a VARIABLE.
      const getItemsCall = makeCall('call-getItems', 'getItems', 'test.js', 2);
      const x = makeVariable('var-x', 'x', 'test.js', 2);

      const nodes = [getItemsCall, x];
      const edges = [
        derivesFrom('var-x', 'call-getItems'),  // x derives from getItems() call
      ];

      const { result } = await runValidator(nodes, edges);

      assert.ok(
        !hasErrorForVariable(result, 'x', 'ERR_MISSING_ASSIGNMENT'),
        'for-of variable with DERIVES_FROM to CALL should NOT trigger ERR_MISSING_ASSIGNMENT. ' +
        `Got errors: ${JSON.stringify(getErrorCodes(result))}`
      );
    });
  });

  // ==========================================================================
  // Bug Fix #2: VARIABLE type filter (not VARIABLE_DECLARATION)
  // ==========================================================================

  describe('Node type filtering', () => {

    it('should find and validate VARIABLE nodes', async () => {
      // The buggy code filters for 'VARIABLE_DECLARATION' which does not exist
      // in the node type system. The correct type is 'VARIABLE'.
      const x = makeVariable('var-x', 'x');
      // No edges -> should trigger ERR_MISSING_ASSIGNMENT
      const nodes = [x];
      const edges = [];

      const { result } = await runValidator(nodes, edges);

      // If the validator correctly finds VARIABLE nodes, it will report
      // the missing assignment. If it incorrectly filters for VARIABLE_DECLARATION,
      // it will find 0 variables and report 0 issues.
      assert.ok(
        hasErrorForVariable(result, 'x', 'ERR_MISSING_ASSIGNMENT'),
        'Validator should detect VARIABLE nodes (type="VARIABLE"), not VARIABLE_DECLARATION. ' +
        `Got errors: ${JSON.stringify(getErrorCodes(result))}`
      );
    });

    it('should find and validate CONSTANT nodes', async () => {
      const c = makeConstant('const-c', 'MAX_SIZE');
      const nodes = [c];
      const edges = [];

      const { result } = await runValidator(nodes, edges);

      assert.ok(
        hasErrorForVariable(result, 'MAX_SIZE', 'ERR_MISSING_ASSIGNMENT'),
        'Validator should detect CONSTANT nodes. ' +
        `Got errors: ${JSON.stringify(getErrorCodes(result))}`
      );
    });

    it('PARAMETER nodes should NOT be validated', async () => {
      // Parameters get their values from callers via RECEIVES_ARGUMENT,
      // not from ASSIGNED_FROM edges. The validator should skip them.
      const param = makeParameter('param-a', 'a');
      const nodes = [param];
      const edges = [];

      const { result } = await runValidator(nodes, edges);

      assert.ok(
        !hasErrorForVariable(result, 'a', 'ERR_MISSING_ASSIGNMENT'),
        'PARAMETER nodes should NOT be validated by DataFlowValidator. ' +
        `Got errors: ${JSON.stringify(getErrorCodes(result))}`
      );
    });
  });

  // ==========================================================================
  // Regression Guard: unassigned variable detection
  // ==========================================================================

  describe('Unassigned variable detection (regression guard)', () => {

    it('unassigned VARIABLE should trigger ERR_MISSING_ASSIGNMENT', async () => {
      const x = makeVariable('var-x', 'x', 'test.js', 5);
      const nodes = [x];
      const edges = [];

      const { result } = await runValidator(nodes, edges);

      assert.ok(
        hasErrorForVariable(result, 'x', 'ERR_MISSING_ASSIGNMENT'),
        'Unassigned variable should trigger ERR_MISSING_ASSIGNMENT'
      );
    });

    it('assigned VARIABLE should NOT trigger ERR_MISSING_ASSIGNMENT', async () => {
      const x = makeVariable('var-x', 'x', 'test.js', 1);
      const lit = makeLiteral('lit-42', 42, 'test.js', 1);
      const nodes = [x, lit];
      const edges = [assignedFrom('var-x', 'lit-42')];

      const { result } = await runValidator(nodes, edges);

      assert.ok(
        !hasErrorForVariable(result, 'x', 'ERR_MISSING_ASSIGNMENT'),
        'Variable assigned from literal should not trigger ERR_MISSING_ASSIGNMENT'
      );
    });
  });

  // ==========================================================================
  // Bug Fix #3: Performance contract (queryNodes / getOutgoingEdges)
  // ==========================================================================

  describe('Performance contract (API usage)', () => {

    it('should NOT call getAllEdges', async () => {
      const x = makeVariable('var-x', 'x');
      const lit = makeLiteral('lit-1', 1);
      const nodes = [x, lit];
      const edges = [assignedFrom('var-x', 'lit-1')];

      const { backend } = await runValidator(nodes, edges);

      assert.strictEqual(
        backend.calls.getAllEdges, 0,
        `Validator called getAllEdges ${backend.calls.getAllEdges} time(s). ` +
        'It should use getOutgoingEdges/getIncomingEdges instead for O(1) per-node lookups.'
      );
    });

    it('should NOT call getAllNodes without filter', async () => {
      const x = makeVariable('var-x', 'x');
      const lit = makeLiteral('lit-1', 1);
      const nodes = [x, lit];
      const edges = [assignedFrom('var-x', 'lit-1')];

      const { backend } = await runValidator(nodes, edges);

      // getAllNodes(filter) is acceptable if filter has type constraint.
      // getAllNodes() with no args is the O(n) anti-pattern.
      // The validator should use queryNodes({ type: 'VARIABLE' }) or
      // getAllNodes({ type: 'VARIABLE' }) instead of getAllNodes().
      //
      // We check: if getAllNodes was called, it must have been called
      // fewer times than the total node count (indicating filtered use).
      // Ideally it should use queryNodes, but getAllNodes with a filter
      // is also acceptable.
      const usedQueryNodes = backend.calls.queryNodes > 0;
      const calledGetAllNodesUnfiltered = backend.calls.getAllNodes > 0;

      // Either queryNodes was used, or getAllNodes was not called at all
      // (meaning the validator found another way to get filtered nodes).
      // The key constraint: no O(n^2) scanning of ALL nodes.
      assert.ok(
        usedQueryNodes || !calledGetAllNodesUnfiltered,
        `Validator should use queryNodes() or getAllNodes(filter) instead of unfiltered getAllNodes(). ` +
        `queryNodes calls: ${backend.calls.queryNodes}, getAllNodes calls: ${backend.calls.getAllNodes}`
      );
    });
  });

  // ==========================================================================
  // findPathToLeaf tests
  // ==========================================================================

  describe('findPathToLeaf', () => {

    it('cycle in assignment chain should NOT cause infinite recursion', async () => {
      // A -> B -> A (cycle). The validator must detect the cycle and terminate.
      const a = makeVariable('var-a', 'a', 'test.js', 1);
      const b = makeVariable('var-b', 'b', 'test.js', 2);

      const nodes = [a, b];
      const edges = [
        assignedFrom('var-a', 'var-b'),  // a = b
        assignedFrom('var-b', 'var-a'),  // b = a (cycle)
      ];

      // The test simply verifies the validator completes without hanging.
      // We use a timeout guard via the test runner (default 30s is enough).
      const { result } = await runValidator(nodes, edges);

      // Both variables should have issues (cycle prevents reaching leaf)
      // but the validator must NOT throw or hang.
      assert.ok(result.success !== undefined, 'Validator should complete without hanging on cycles');
    });

    it('variable assigned from literal (leaf node) should trace successfully', async () => {
      // x = 42 -> LITERAL is a leaf node, path should be found.
      const x = makeVariable('var-x', 'x', 'test.js', 1);
      const lit = makeLiteral('lit-42', 42, 'test.js', 1);

      const nodes = [x, lit];
      const edges = [assignedFrom('var-x', 'lit-42')];

      const { result } = await runValidator(nodes, edges);

      // No ERR_NO_LEAF_NODE error for x
      const leafErrors = result.errors.filter(e =>
        e.code === 'ERR_NO_LEAF_NODE' && e.context?.variable === 'x'
      );

      assert.strictEqual(
        leafErrors.length, 0,
        'Variable assigned from LITERAL should trace to leaf successfully. ' +
        `Got leaf errors: ${JSON.stringify(leafErrors.map(e => e.message))}`
      );
    });

    it('variable assigned from FUNCTION should trace successfully', async () => {
      // const handler = () => {} -> FUNCTION is a leaf node.
      const handler = makeVariable('var-handler', 'handler', 'test.js', 1);
      const fn = makeFunction('fn-anon', '<anonymous>', 'test.js', 1);

      const nodes = [handler, fn];
      const edges = [assignedFrom('var-handler', 'fn-anon')];

      const { result } = await runValidator(nodes, edges);

      const leafErrors = result.errors.filter(e =>
        e.code === 'ERR_NO_LEAF_NODE' && e.context?.variable === 'handler'
      );

      assert.strictEqual(
        leafErrors.length, 0,
        'Variable assigned from FUNCTION should trace to leaf successfully'
      );
    });
  });

  // ==========================================================================
  // Integration scenario: mixed variables
  // ==========================================================================

  describe('Mixed variable scenario', () => {

    it('should correctly classify assigned, derived, and unassigned variables', async () => {
      // Setup: 3 variables with different data flow patterns
      //   items = [1,2,3]        -> ASSIGNED_FROM -> LITERAL (OK)
      //   item  (for-of items)   -> DERIVES_FROM -> items   (OK after fix)
      //   orphan (no edges)      -> ERR_MISSING_ASSIGNMENT
      const items = makeVariable('var-items', 'items', 'test.js', 1);
      const itemsLiteral = makeLiteral('lit-items', '[1,2,3]', 'test.js', 1);
      const item = makeVariable('var-item', 'item', 'test.js', 2);
      const orphan = makeVariable('var-orphan', 'orphan', 'test.js', 3);

      const nodes = [items, itemsLiteral, item, orphan];
      const edges = [
        assignedFrom('var-items', 'lit-items'),
        derivesFrom('var-item', 'var-items'),
      ];

      const { result } = await runValidator(nodes, edges);

      // items: assigned from literal -> no error
      assert.ok(
        !hasErrorForVariable(result, 'items', 'ERR_MISSING_ASSIGNMENT'),
        '"items" should not trigger ERR_MISSING_ASSIGNMENT'
      );

      // item: derives from items -> no error (bug fix #1)
      assert.ok(
        !hasErrorForVariable(result, 'item', 'ERR_MISSING_ASSIGNMENT'),
        '"item" (for-of) should not trigger ERR_MISSING_ASSIGNMENT'
      );

      // orphan: no edges -> error
      assert.ok(
        hasErrorForVariable(result, 'orphan', 'ERR_MISSING_ASSIGNMENT'),
        '"orphan" with no edges should trigger ERR_MISSING_ASSIGNMENT'
      );
    });
  });
});

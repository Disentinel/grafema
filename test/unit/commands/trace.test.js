/**
 * Unit tests for `grafema trace` command - scope filtering
 *
 * Tests the findVariables scope filtering logic.
 * Since findVariables is not exported, we test the filtering behavior
 * by simulating the same logic: query nodes, then filter by scope.
 *
 * REG-187: Scope filtering must use semantic ID parsing, not file path substring
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { TestBackend } from '../../helpers/TestRFDB.js';
import { parseSemanticId } from '@grafema/core';

/**
 * Simulate findVariables scope filtering logic.
 *
 * CRITICAL: This implementation must exactly match the production code
 * in trace.ts findVariables(). If the production logic changes, update
 * this test helper to match.
 *
 * This implements the CORRECT behavior (semantic ID parsing).
 *
 * @param {AsyncIterable} nodes - nodes from backend.queryNodes
 * @param {string} varName - variable name to find
 * @param {string|null} scopeName - scope to filter by (or null for all)
 * @returns {Promise<Array>} - filtered nodes
 */
async function filterByScope(nodes, varName, scopeName) {
  const results = [];
  const lowerScopeName = scopeName ? scopeName.toLowerCase() : null;

  for await (const node of nodes) {
    const name = node.name || '';

    // Match variable name (case-insensitive)
    if (name.toLowerCase() !== varName.toLowerCase()) {
      continue;
    }

    // If scope specified, filter using semantic ID parsing
    if (scopeName) {
      const parsed = parseSemanticId(node.id);
      if (!parsed) continue;

      // Check if scopeName appears anywhere in the scope chain
      if (!parsed.scopePath.some(s => s.toLowerCase() === lowerScopeName)) {
        continue;
      }
    }

    results.push({
      id: node.id,
      type: node.type || node.nodeType,
      name: name,
      file: node.file || '',
      line: node.line,
    });

    if (results.length >= 5) break;
  }

  return results;
}

/**
 * Simulate CURRENT (broken) findVariables logic that uses file path.
 * This is what the current implementation does.
 */
async function filterByFilePath(nodes, varName, scopeName) {
  const results = [];

  for await (const node of nodes) {
    const name = node.name || '';

    if (name.toLowerCase() !== varName.toLowerCase()) {
      continue;
    }

    if (scopeName) {
      const file = node.file || '';
      // Current broken behavior: checks file path, not scope chain
      if (!file.toLowerCase().includes(scopeName.toLowerCase())) {
        continue;
      }
    }

    results.push({
      id: node.id,
      type: node.type || node.nodeType,
      name: name,
      file: node.file || '',
      line: node.line,
    });

    if (results.length >= 5) break;
  }

  return results;
}

describe('grafema trace - scope filtering (REG-187)', () => {
  let backend;

  beforeEach(async () => {
    backend = new TestBackend();
    await backend.connect();
  });

  afterEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  describe('semantic ID scope filtering (correct behavior)', () => {
    it('should find variable with exact scope match', async () => {
      // Setup: Variable "response" in function "handleDragEnd"
      await backend.addNode({
        id: 'AdminSetlist.tsx->AdminSetlist->handleDragEnd->VARIABLE->response',
        nodeType: 'VARIABLE',
        name: 'response',
        file: 'AdminSetlist.tsx',
        line: 42,
      });
      await backend.flush();

      // Test with correct filtering (semantic ID parsing)
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'response', 'handleDragEnd');

      assert.equal(results.length, 1, 'Should find exactly one variable');
      assert.equal(results[0].name, 'response');
      assert.equal(results[0].id, 'AdminSetlist.tsx->AdminSetlist->handleDragEnd->VARIABLE->response');
    });

    it('should NOT match scope based on file path substring (regression test)', async () => {
      // Setup: Variable in file "AdminSetlist.tsx", function "handleDragEnd"
      await backend.addNode({
        id: 'AdminSetlist.tsx->AdminSetlist->handleDragEnd->VARIABLE->response',
        nodeType: 'VARIABLE',
        name: 'response',
        file: 'AdminSetlist.tsx',
        line: 42,
      });
      await backend.flush();

      // Test: "setlist" is in filename but NOT in scope chain
      // Correct behavior: should NOT find (setlist is not a scope)
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const correctResults = await filterByScope(nodes, 'response', 'setlist');
      assert.equal(correctResults.length, 0, 'Correct filtering should NOT match file path');

      // Current broken behavior would find it (matches file path)
      const nodes2 = backend.queryNodes({ nodeType: 'VARIABLE' });
      const brokenResults = await filterByFilePath(nodes2, 'response', 'setlist');
      assert.equal(brokenResults.length, 1, 'Broken filtering matches file path');

      // This proves the current implementation is wrong
    });

    it('should find variable in nested scope when searching parent scope', async () => {
      // Setup: Variable "error" in try#0 block inside handleDragEnd
      await backend.addNode({
        id: 'AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->error',
        nodeType: 'VARIABLE',
        name: 'error',
        file: 'AdminSetlist.tsx',
        line: 50,
      });
      await backend.flush();

      // Test: Search for "handleDragEnd" should find variable in nested try block
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'error', 'handleDragEnd');

      assert.equal(results.length, 1, 'Should find variable in nested scope');
      assert.equal(results[0].name, 'error');
    });

    it('should find variable by direct nested scope name (try#0)', async () => {
      // Setup: Variable in nested try block
      await backend.addNode({
        id: 'AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->error',
        nodeType: 'VARIABLE',
        name: 'error',
        file: 'AdminSetlist.tsx',
        line: 50,
      });
      await backend.flush();

      // Test: Direct search for "try#0" should work
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'error', 'try#0');

      assert.equal(results.length, 1, 'Should find variable by nested scope name');
    });

    it('should match scope names case-insensitively', async () => {
      // Setup: Function name in camelCase
      await backend.addNode({
        id: 'AdminSetlist.tsx->AdminSetlist->handleDragEnd->VARIABLE->response',
        nodeType: 'VARIABLE',
        name: 'response',
        file: 'AdminSetlist.tsx',
        line: 42,
      });
      await backend.flush();

      // Test: ALL CAPS should still match
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'response', 'HANDLEDRAGEND');

      assert.equal(results.length, 1, 'Should match case-insensitively');
    });

    it('should return empty when scope does not exist', async () => {
      // Setup: Variable exists in handleDragEnd
      await backend.addNode({
        id: 'AdminSetlist.tsx->AdminSetlist->handleDragEnd->VARIABLE->response',
        nodeType: 'VARIABLE',
        name: 'response',
        file: 'AdminSetlist.tsx',
        line: 42,
      });
      await backend.flush();

      // Test: Search for non-existent scope
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'response', 'nonExistentFunction');

      assert.equal(results.length, 0, 'Should return empty for non-existent scope');
    });

    it('should filter correctly when multiple variables have same name in different scopes', async () => {
      // Setup: Variable "x" in two different functions
      await backend.addNodes([
        {
          id: 'app.js->global->funcA->VARIABLE->x',
          nodeType: 'VARIABLE',
          name: 'x',
          file: 'app.js',
          line: 10,
        },
        {
          id: 'app.js->global->funcB->VARIABLE->x',
          nodeType: 'VARIABLE',
          name: 'x',
          file: 'app.js',
          line: 20,
        },
      ]);
      await backend.flush();

      // Test: Search for "x from funcA" should only find the one in funcA
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'x', 'funcA');

      assert.equal(results.length, 1, 'Should find only one variable');
      assert.ok(results[0].id.includes('funcA'), 'Should be from funcA');
    });
  });

  describe('special nodes handling', () => {
    it('should handle singleton nodes gracefully', async () => {
      // Setup: Singleton node
      await backend.addNode({
        id: 'net:stdio->__stdio__',
        nodeType: 'SINGLETON',
        name: '__stdio__',
        file: '',
      });
      await backend.flush();

      // Test: Should not crash, but won't match typical scope names
      const nodes = backend.queryNodes({ nodeType: 'SINGLETON' });
      const results = await filterByScope(nodes, '__stdio__', 'someFunction');

      // Singleton has scopePath = ['net:stdio'], not a typical function name
      assert.equal(results.length, 0, 'Singleton should not match function scope');
    });

    it('should handle singleton nodes when searching by prefix', async () => {
      // Setup: Singleton node
      await backend.addNode({
        id: 'net:stdio->__stdio__',
        nodeType: 'SINGLETON',
        name: '__stdio__',
        file: '',
      });
      await backend.flush();

      // Test: Search by the prefix scope
      const nodes = backend.queryNodes({ nodeType: 'SINGLETON' });
      const results = await filterByScope(nodes, '__stdio__', 'net:stdio');

      assert.equal(results.length, 1, 'Should find singleton by prefix');
    });

    it('should handle external module nodes gracefully', async () => {
      // Setup: External module node
      await backend.addNode({
        id: 'EXTERNAL_MODULE->lodash',
        nodeType: 'EXTERNAL_MODULE',
        name: 'lodash',
        file: '',
      });
      await backend.flush();

      // Test: External modules have empty scopePath
      const nodes = backend.queryNodes({ nodeType: 'EXTERNAL_MODULE' });
      const results = await filterByScope(nodes, 'lodash', 'anyScope');

      // External modules have scopePath = [], so won't match any scope
      assert.equal(results.length, 0, 'External module should not match scope filter');
    });
  });

  describe('invalid semantic ID handling', () => {
    it('should skip nodes with malformed IDs', async () => {
      // Setup: Node with invalid ID format (no arrows)
      await backend.addNode({
        id: 'broken-id-format',
        nodeType: 'VARIABLE',
        name: 'broken',
        file: 'test.js',
        line: 1,
      });
      await backend.flush();

      // Test: Should not crash, just skip the node
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'broken', 'anyScope');

      // parseSemanticId returns null for invalid IDs, node should be skipped
      assert.equal(results.length, 0, 'Should skip nodes with invalid IDs');
    });

    it('should skip nodes with too few parts in ID', async () => {
      // Setup: Node with only 2 parts (need at least 4)
      await backend.addNode({
        id: 'file->name',
        nodeType: 'VARIABLE',
        name: 'name',
        file: 'file',
        line: 1,
      });
      await backend.flush();

      // Test: Should not crash
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'name', 'anyScope');

      assert.equal(results.length, 0, 'Should skip nodes with malformed IDs');
    });
  });

  describe('no scope filter (null scopeName)', () => {
    it('should return all matching variables when scopeName is null', async () => {
      // Setup: Multiple variables with same name in different scopes
      await backend.addNodes([
        {
          id: 'app.js->global->funcA->VARIABLE->data',
          nodeType: 'VARIABLE',
          name: 'data',
          file: 'app.js',
          line: 10,
        },
        {
          id: 'app.js->global->funcB->VARIABLE->data',
          nodeType: 'VARIABLE',
          name: 'data',
          file: 'app.js',
          line: 20,
        },
        {
          id: 'other.js->global->funcC->VARIABLE->data',
          nodeType: 'VARIABLE',
          name: 'data',
          file: 'other.js',
          line: 5,
        },
      ]);
      await backend.flush();

      // Test: No scope filter should return all variables named "data"
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'data', null);

      assert.equal(results.length, 3, 'Should return all variables without scope filter');
    });
  });

  describe('global scope handling', () => {
    it('should find global variables when searching by "global" scope', async () => {
      // Setup: Global variable
      await backend.addNode({
        id: 'app.js->global->VARIABLE->config',
        nodeType: 'VARIABLE',
        name: 'config',
        file: 'app.js',
        line: 1,
      });
      await backend.flush();

      // Test: Search by "global" scope
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'config', 'global');

      assert.equal(results.length, 1, 'Should find global variable');
    });
  });

  describe('class scope handling', () => {
    it('should find variable in class method when searching by class name', async () => {
      // Setup: Variable in class method
      await backend.addNode({
        id: 'service.ts->UserService->login->VARIABLE->token',
        nodeType: 'VARIABLE',
        name: 'token',
        file: 'service.ts',
        line: 25,
      });
      await backend.flush();

      // Test: Search by class name should find variables in its methods
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'token', 'UserService');

      assert.equal(results.length, 1, 'Should find variable by class scope');
    });

    it('should find variable in class method when searching by method name', async () => {
      // Setup: Variable in class method
      await backend.addNode({
        id: 'service.ts->UserService->login->VARIABLE->token',
        nodeType: 'VARIABLE',
        name: 'token',
        file: 'service.ts',
        line: 25,
      });
      await backend.flush();

      // Test: Search by method name
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'token', 'login');

      assert.equal(results.length, 1, 'Should find variable by method scope');
    });
  });

  describe('discriminator in scope names', () => {
    it('should match exact discriminator scope (if#0 vs if#1)', async () => {
      // Setup: Variables in different if blocks
      await backend.addNodes([
        {
          id: 'app.js->global->process->if#0->VARIABLE->result',
          nodeType: 'VARIABLE',
          name: 'result',
          file: 'app.js',
          line: 10,
        },
        {
          id: 'app.js->global->process->if#1->VARIABLE->result',
          nodeType: 'VARIABLE',
          name: 'result',
          file: 'app.js',
          line: 20,
        },
      ]);
      await backend.flush();

      // Test: Search for specific if block
      const nodes = backend.queryNodes({ nodeType: 'VARIABLE' });
      const results = await filterByScope(nodes, 'result', 'if#0');

      assert.equal(results.length, 1, 'Should find only if#0 variable');
      assert.ok(results[0].id.includes('if#0'), 'Should be from if#0');
    });
  });

  describe('multiple node types (VARIABLE, CONSTANT, PARAMETER)', () => {
    it('should find constants in specified scope', async () => {
      // Setup: Constant in function
      await backend.addNode({
        id: 'config.js->global->configure->CONSTANT->MAX_RETRIES',
        nodeType: 'CONSTANT',
        name: 'MAX_RETRIES',
        file: 'config.js',
        line: 5,
      });
      await backend.flush();

      // Test: Search for constant by scope
      const nodes = backend.queryNodes({ nodeType: 'CONSTANT' });
      const results = await filterByScope(nodes, 'MAX_RETRIES', 'configure');

      assert.equal(results.length, 1, 'Should find constant in scope');
    });

    it('should find parameters in specified scope', async () => {
      // Setup: Parameter in function
      await backend.addNode({
        id: 'handler.js->global->handleRequest->PARAMETER->req',
        nodeType: 'PARAMETER',
        name: 'req',
        file: 'handler.js',
        line: 1,
      });
      await backend.flush();

      // Test: Search for parameter by scope
      const nodes = backend.queryNodes({ nodeType: 'PARAMETER' });
      const results = await filterByScope(nodes, 'req', 'handleRequest');

      assert.equal(results.length, 1, 'Should find parameter in scope');
    });
  });
});

/**
 * Tests for parseSemanticId function directly
 * (Used by the scope filtering logic)
 */
describe('parseSemanticId', () => {
  it('should parse standard semantic ID', () => {
    const parsed = parseSemanticId('AdminSetlist.tsx->AdminSetlist->handleDragEnd->VARIABLE->response');

    assert.deepEqual(parsed, {
      file: 'AdminSetlist.tsx',
      scopePath: ['AdminSetlist', 'handleDragEnd'],
      type: 'VARIABLE',
      name: 'response',
      discriminator: undefined,
      context: undefined,
    });
  });

  it('should parse semantic ID with discriminator', () => {
    const parsed = parseSemanticId('app.js->global->process->CALL->console.log#2');

    assert.deepEqual(parsed, {
      file: 'app.js',
      scopePath: ['global', 'process'],
      type: 'CALL',
      name: 'console.log',
      discriminator: 2,
      context: undefined,
    });
  });

  it('should parse singleton ID', () => {
    const parsed = parseSemanticId('net:stdio->__stdio__');

    assert.deepEqual(parsed, {
      file: '',
      scopePath: ['net:stdio'],
      type: 'SINGLETON',
      name: '__stdio__',
      discriminator: undefined,
    });
  });

  it('should parse external module ID', () => {
    const parsed = parseSemanticId('EXTERNAL_MODULE->lodash');

    assert.deepEqual(parsed, {
      file: '',
      scopePath: [],
      type: 'EXTERNAL_MODULE',
      name: 'lodash',
      discriminator: undefined,
    });
  });

  it('should return null for invalid ID (too few parts)', () => {
    const parsed = parseSemanticId('invalid-id');
    assert.equal(parsed, null);
  });

  it('should return null for ID with only 2 parts', () => {
    const parsed = parseSemanticId('file->name');
    assert.equal(parsed, null);
  });

  it('should return null for ID with only 3 parts', () => {
    const parsed = parseSemanticId('file->scope->name');
    assert.equal(parsed, null);
  });

  it('should parse ID with deeply nested scope', () => {
    const parsed = parseSemanticId('file.js->Class->method->if#0->try#0->catch#0->VARIABLE->err');

    assert.deepEqual(parsed, {
      file: 'file.js',
      scopePath: ['Class', 'method', 'if#0', 'try#0', 'catch#0'],
      type: 'VARIABLE',
      name: 'err',
      discriminator: undefined,
      context: undefined,
    });
  });
});

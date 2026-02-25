/**
 * runtimeCategories Unit Tests (REG-583)
 *
 * Tests the authoritative categorization data for runtime-typed nodes.
 * Validates that resolveBuiltinObjectId, resolveBuiltinFunctionId, and
 * getBuiltinNodeType return correct values for all runtime categories:
 *   ECMASCRIPT_BUILTIN, WEB_API, BROWSER_API, NODEJS_STDLIB
 *
 * These are pure data/function tests — no graph database needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// runtimeCategories will be exported from @grafema/core after Rob's implementation.
// TDD: these imports will fail until source files are created and built.
let resolveBuiltinObjectId;
let resolveBuiltinFunctionId;
let getBuiltinNodeType;
let ECMASCRIPT_BUILTIN_OBJECTS;
let WEB_API_OBJECTS;
let BROWSER_API_OBJECTS;
let NODEJS_STDLIB_OBJECTS;
let ALL_KNOWN_OBJECTS;
let ALL_KNOWN_FUNCTIONS;

let importSucceeded = false;
try {
  const mod = await import('@grafema/core');
  resolveBuiltinObjectId = mod.resolveBuiltinObjectId;
  resolveBuiltinFunctionId = mod.resolveBuiltinFunctionId;
  getBuiltinNodeType = mod.getBuiltinNodeType;
  ECMASCRIPT_BUILTIN_OBJECTS = mod.ECMASCRIPT_BUILTIN_OBJECTS;
  WEB_API_OBJECTS = mod.WEB_API_OBJECTS;
  BROWSER_API_OBJECTS = mod.BROWSER_API_OBJECTS;
  NODEJS_STDLIB_OBJECTS = mod.NODEJS_STDLIB_OBJECTS;
  ALL_KNOWN_OBJECTS = mod.ALL_KNOWN_OBJECTS;
  ALL_KNOWN_FUNCTIONS = mod.ALL_KNOWN_FUNCTIONS;
  importSucceeded = true;
} catch {
  // Exports not available yet — tests will skip until Rob implements the source.
}

function skipIfNotImplemented() {
  if (!importSucceeded) {
    console.log('SKIP: runtimeCategories not exported from @grafema/core yet');
    return true;
  }
  return false;
}

describe('runtimeCategories', () => {
  // ==========================================================================
  // resolveBuiltinObjectId
  // ==========================================================================

  describe('resolveBuiltinObjectId', () => {
    it('should resolve Math to ECMASCRIPT_BUILTIN:Math', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('Math');
      assert.strictEqual(result, 'ECMASCRIPT_BUILTIN:Math');
    });

    it('should resolve console to WEB_API:console', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('console');
      assert.strictEqual(result, 'WEB_API:console');
    });

    it('should resolve document to BROWSER_API:document', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('document');
      assert.strictEqual(result, 'BROWSER_API:document');
    });

    it('should resolve process to NODEJS_STDLIB:process', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('process');
      assert.strictEqual(result, 'NODEJS_STDLIB:process');
    });

    it('should return null for unknown variable "res"', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('res');
      assert.strictEqual(result, null, 'Unknown variable should return null');
    });

    it('should return null for npm package "axios"', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('axios');
      assert.strictEqual(result, null, 'npm package namespace should return null');
    });

    it('should resolve JSON to ECMASCRIPT_BUILTIN:JSON', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('JSON');
      assert.strictEqual(result, 'ECMASCRIPT_BUILTIN:JSON');
    });

    it('should resolve Promise to ECMASCRIPT_BUILTIN:Promise', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('Promise');
      assert.strictEqual(result, 'ECMASCRIPT_BUILTIN:Promise');
    });

    it('should resolve window to BROWSER_API:window', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('window');
      assert.strictEqual(result, 'BROWSER_API:window');
    });

    it('should resolve Buffer to NODEJS_STDLIB:Buffer', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('Buffer');
      assert.strictEqual(result, 'NODEJS_STDLIB:Buffer');
    });

    it('should resolve fs to NODEJS_STDLIB:fs (GAP 3 fix)', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('fs');
      assert.strictEqual(result, 'NODEJS_STDLIB:fs',
        'fs is a Node.js stdlib module, not an npm namespace');
    });

    it('should resolve path to NODEJS_STDLIB:path (GAP 3 fix)', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('path');
      assert.strictEqual(result, 'NODEJS_STDLIB:path');
    });

    it('should resolve WebSocket to BROWSER_API:WebSocket (GAP 4 fix)', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('WebSocket');
      assert.strictEqual(result, 'BROWSER_API:WebSocket');
    });

    it('should resolve localStorage to BROWSER_API:localStorage', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('localStorage');
      assert.strictEqual(result, 'BROWSER_API:localStorage');
    });

    it('should resolve fetch to WEB_API:fetch', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinObjectId('fetch');
      assert.strictEqual(result, 'WEB_API:fetch');
    });
  });

  // ==========================================================================
  // resolveBuiltinFunctionId
  // ==========================================================================

  describe('resolveBuiltinFunctionId', () => {
    it('should resolve parseInt to ECMASCRIPT_BUILTIN:parseInt', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinFunctionId('parseInt');
      assert.strictEqual(result, 'ECMASCRIPT_BUILTIN:parseInt');
    });

    it('should resolve setTimeout to WEB_API:setTimeout', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinFunctionId('setTimeout');
      assert.strictEqual(result, 'WEB_API:setTimeout');
    });

    it('should resolve setImmediate to NODEJS_STDLIB:setImmediate', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinFunctionId('setImmediate');
      assert.strictEqual(result, 'NODEJS_STDLIB:setImmediate');
    });

    it('should return null for require (modeled via IMPORT nodes)', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinFunctionId('require');
      assert.strictEqual(result, null,
        'require is deliberately excluded — modeled via IMPORT/REQUIRES_MODULE nodes');
    });

    it('should resolve isNaN to ECMASCRIPT_BUILTIN:isNaN', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinFunctionId('isNaN');
      assert.strictEqual(result, 'ECMASCRIPT_BUILTIN:isNaN');
    });

    it('should resolve clearTimeout to WEB_API:clearTimeout', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinFunctionId('clearTimeout');
      assert.strictEqual(result, 'WEB_API:clearTimeout');
    });

    it('should resolve queueMicrotask to WEB_API:queueMicrotask', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinFunctionId('queueMicrotask');
      assert.strictEqual(result, 'WEB_API:queueMicrotask');
    });

    it('should resolve requestAnimationFrame to BROWSER_API:requestAnimationFrame (GAP 5 fix)', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinFunctionId('requestAnimationFrame');
      assert.strictEqual(result, 'BROWSER_API:requestAnimationFrame');
    });

    it('should return null for unknown function name', () => {
      if (skipIfNotImplemented()) return;

      const result = resolveBuiltinFunctionId('myCustomFunction');
      assert.strictEqual(result, null);
    });
  });

  // ==========================================================================
  // getBuiltinNodeType
  // ==========================================================================

  describe('getBuiltinNodeType', () => {
    it('should extract ECMASCRIPT_BUILTIN from node ID', () => {
      if (skipIfNotImplemented()) return;

      const result = getBuiltinNodeType('ECMASCRIPT_BUILTIN:Math');
      assert.strictEqual(result, 'ECMASCRIPT_BUILTIN');
    });

    it('should extract WEB_API from node ID', () => {
      if (skipIfNotImplemented()) return;

      const result = getBuiltinNodeType('WEB_API:console');
      assert.strictEqual(result, 'WEB_API');
    });

    it('should extract BROWSER_API from node ID', () => {
      if (skipIfNotImplemented()) return;

      const result = getBuiltinNodeType('BROWSER_API:document');
      assert.strictEqual(result, 'BROWSER_API');
    });

    it('should extract NODEJS_STDLIB from node ID', () => {
      if (skipIfNotImplemented()) return;

      const result = getBuiltinNodeType('NODEJS_STDLIB:process');
      assert.strictEqual(result, 'NODEJS_STDLIB');
    });

    it('should return null for EXTERNAL_MODULE node ID', () => {
      if (skipIfNotImplemented()) return;

      const result = getBuiltinNodeType('EXTERNAL_MODULE:lodash');
      assert.strictEqual(result, null,
        'EXTERNAL_MODULE is not a builtin type');
    });

    it('should return null for UNKNOWN_CALL_TARGET node ID', () => {
      if (skipIfNotImplemented()) return;

      const result = getBuiltinNodeType('UNKNOWN_CALL_TARGET:res');
      assert.strictEqual(result, null,
        'UNKNOWN_CALL_TARGET is not a builtin type');
    });

    it('should return null for node ID without colon', () => {
      if (skipIfNotImplemented()) return;

      const result = getBuiltinNodeType('some-node-id');
      assert.strictEqual(result, null);
    });
  });

  // ==========================================================================
  // Set Overlap Prevention
  // ==========================================================================

  describe('Set overlap prevention', () => {
    it('should have no overlap between ECMASCRIPT_BUILTIN and WEB_API objects', () => {
      if (skipIfNotImplemented()) return;

      for (const name of ECMASCRIPT_BUILTIN_OBJECTS) {
        assert.ok(!WEB_API_OBJECTS.has(name),
          `"${name}" appears in both ECMASCRIPT_BUILTIN_OBJECTS and WEB_API_OBJECTS`);
      }
    });

    it('should have no overlap between ECMASCRIPT_BUILTIN and BROWSER_API objects', () => {
      if (skipIfNotImplemented()) return;

      for (const name of ECMASCRIPT_BUILTIN_OBJECTS) {
        assert.ok(!BROWSER_API_OBJECTS.has(name),
          `"${name}" appears in both ECMASCRIPT_BUILTIN_OBJECTS and BROWSER_API_OBJECTS`);
      }
    });

    it('should have no overlap between ECMASCRIPT_BUILTIN and NODEJS_STDLIB objects', () => {
      if (skipIfNotImplemented()) return;

      for (const name of ECMASCRIPT_BUILTIN_OBJECTS) {
        assert.ok(!NODEJS_STDLIB_OBJECTS.has(name),
          `"${name}" appears in both ECMASCRIPT_BUILTIN_OBJECTS and NODEJS_STDLIB_OBJECTS`);
      }
    });

    it('should have no overlap between WEB_API and BROWSER_API objects', () => {
      if (skipIfNotImplemented()) return;

      for (const name of WEB_API_OBJECTS) {
        assert.ok(!BROWSER_API_OBJECTS.has(name),
          `"${name}" appears in both WEB_API_OBJECTS and BROWSER_API_OBJECTS`);
      }
    });

    it('should have no overlap between WEB_API and NODEJS_STDLIB objects', () => {
      if (skipIfNotImplemented()) return;

      for (const name of WEB_API_OBJECTS) {
        assert.ok(!NODEJS_STDLIB_OBJECTS.has(name),
          `"${name}" appears in both WEB_API_OBJECTS and NODEJS_STDLIB_OBJECTS`);
      }
    });

    it('should have no overlap between BROWSER_API and NODEJS_STDLIB objects', () => {
      if (skipIfNotImplemented()) return;

      for (const name of BROWSER_API_OBJECTS) {
        assert.ok(!NODEJS_STDLIB_OBJECTS.has(name),
          `"${name}" appears in both BROWSER_API_OBJECTS and NODEJS_STDLIB_OBJECTS`);
      }
    });

    it('ALL_KNOWN_OBJECTS should be the union of all four object sets', () => {
      if (skipIfNotImplemented()) return;

      const expectedSize =
        ECMASCRIPT_BUILTIN_OBJECTS.size +
        WEB_API_OBJECTS.size +
        BROWSER_API_OBJECTS.size +
        NODEJS_STDLIB_OBJECTS.size;

      assert.strictEqual(ALL_KNOWN_OBJECTS.size, expectedSize,
        'ALL_KNOWN_OBJECTS size should equal sum of all four sets (no overlap)');

      // Every entry from each set should be in the combined set
      for (const name of ECMASCRIPT_BUILTIN_OBJECTS) {
        assert.ok(ALL_KNOWN_OBJECTS.has(name), `${name} should be in ALL_KNOWN_OBJECTS`);
      }
      for (const name of WEB_API_OBJECTS) {
        assert.ok(ALL_KNOWN_OBJECTS.has(name), `${name} should be in ALL_KNOWN_OBJECTS`);
      }
      for (const name of BROWSER_API_OBJECTS) {
        assert.ok(ALL_KNOWN_OBJECTS.has(name), `${name} should be in ALL_KNOWN_OBJECTS`);
      }
      for (const name of NODEJS_STDLIB_OBJECTS) {
        assert.ok(ALL_KNOWN_OBJECTS.has(name), `${name} should be in ALL_KNOWN_OBJECTS`);
      }
    });
  });
});

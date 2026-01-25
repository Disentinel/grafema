/**
 * BuiltinRegistry Unit Tests (REG-218)
 *
 * Tests for the BuiltinRegistry class that manages Node.js builtin definitions.
 *
 * The registry provides:
 * - Lookup of known builtin functions
 * - Metadata for security flags, purity, etc.
 * - Module categorization
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { BuiltinRegistry } from '@grafema/core';

describe('BuiltinRegistry', () => {

  describe('Module Recognition', () => {
    it('should recognize fs as a builtin module', async () => {
      const registry = new BuiltinRegistry();
      assert.strictEqual(registry.isBuiltinModule('fs'), true);
    });

    it('should recognize path as a builtin module', async () => {
      const registry = new BuiltinRegistry();
      assert.strictEqual(registry.isBuiltinModule('path'), true);
    });

    it('should recognize http as a builtin module', async () => {
      const registry = new BuiltinRegistry();
      assert.strictEqual(registry.isBuiltinModule('http'), true);
    });

    it('should recognize child_process as a builtin module', async () => {
      const registry = new BuiltinRegistry();
      assert.strictEqual(registry.isBuiltinModule('child_process'), true);
    });

    it('should recognize crypto as a builtin module', async () => {
      const registry = new BuiltinRegistry();
      assert.strictEqual(registry.isBuiltinModule('crypto'), true);
    });

    it('should recognize fs/promises as a builtin module', async () => {
      const registry = new BuiltinRegistry();
      assert.strictEqual(registry.isBuiltinModule('fs/promises'), true);
    });

    it('should NOT recognize lodash as a builtin module', async () => {
      const registry = new BuiltinRegistry();
      assert.strictEqual(registry.isBuiltinModule('lodash'), false);
    });

    it('should NOT recognize express as a builtin module', async () => {
      const registry = new BuiltinRegistry();
      assert.strictEqual(registry.isBuiltinModule('express'), false);
    });

    it('should handle node: prefix (node:fs -> fs)', async () => {
      const registry = new BuiltinRegistry();
      assert.strictEqual(registry.isBuiltinModule('node:fs'), true);
      assert.strictEqual(registry.normalizeModule('node:fs'), 'fs');
    });
  });

  describe('Function Lookup', () => {
    it('should find fs.readFile as a known function', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('fs', 'readFile');
      assert.ok(func, 'fs.readFile should be known');
      assert.strictEqual(func.name, 'readFile');
      assert.strictEqual(func.module, 'fs');
    });

    it('should find path.join as a known function', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('path', 'join');
      assert.ok(func, 'path.join should be known');
    });

    it('should find child_process.exec as a known function', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('child_process', 'exec');
      assert.ok(func, 'child_process.exec should be known');
    });

    it('should return null for unknown functions', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('fs', 'nonExistentFunction');
      assert.strictEqual(func, null);
    });

    it('should return null for functions in unknown modules', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('lodash', 'map');
      assert.strictEqual(func, null);
    });
  });

  describe('Function Metadata', () => {
    it('should return security:file-io for fs.readFile', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('fs', 'readFile');
      assert.strictEqual(func.security, 'file-io');
    });

    it('should return security:file-io for fs.writeFile', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('fs', 'writeFile');
      assert.strictEqual(func.security, 'file-io');
    });

    it('should return security:exec for child_process.exec', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('child_process', 'exec');
      assert.strictEqual(func.security, 'exec');
    });

    it('should return security:exec for child_process.spawn', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('child_process', 'spawn');
      assert.strictEqual(func.security, 'exec');
    });

    it('should return security:net for http.createServer', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('http', 'createServer');
      assert.strictEqual(func.security, 'net');
    });

    it('should return pure:true for path.join', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('path', 'join');
      assert.strictEqual(func.pure, true);
    });

    it('should return pure:true for path.resolve', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('path', 'resolve');
      assert.strictEqual(func.pure, true);
    });

    it('should return pure:false for fs.readFile (side effect)', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('fs', 'readFile');
      assert.strictEqual(func.pure, false);
    });
  });

  describe('isKnownFunction', () => {
    it('should return true for known function combinations', async () => {
      const registry = new BuiltinRegistry();
      assert.strictEqual(registry.isKnownFunction('fs', 'readFile'), true);
      assert.strictEqual(registry.isKnownFunction('path', 'join'), true);
      assert.strictEqual(registry.isKnownFunction('http', 'createServer'), true);
    });

    it('should return false for unknown function combinations', async () => {
      const registry = new BuiltinRegistry();
      assert.strictEqual(registry.isKnownFunction('fs', 'unknown'), false);
      assert.strictEqual(registry.isKnownFunction('lodash', 'map'), false);
    });
  });

  describe('getAllFunctions', () => {
    it('should return all functions for a module', async () => {
      const registry = new BuiltinRegistry();
      const fsFunctions = registry.getAllFunctions('fs');
      assert.ok(fsFunctions.length > 0);
      assert.ok(fsFunctions.some(f => f.name === 'readFile'));
      assert.ok(fsFunctions.some(f => f.name === 'writeFile'));
    });

    it('should return empty array for unknown module', async () => {
      const registry = new BuiltinRegistry();
      const functions = registry.getAllFunctions('lodash');
      assert.deepStrictEqual(functions, []);
    });
  });

  describe('fs/promises special handling', () => {
    it('should find fs/promises.readFile', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('fs/promises', 'readFile');
      assert.ok(func, 'fs/promises.readFile should be known');
    });

    it('should have security:file-io for fs/promises.writeFile', async () => {
      const registry = new BuiltinRegistry();
      const func = registry.getFunction('fs/promises', 'writeFile');
      assert.strictEqual(func.security, 'file-io');
    });

    it('should treat fs/promises and fs as separate modules', async () => {
      const registry = new BuiltinRegistry();
      // Both should exist separately
      assert.strictEqual(registry.isBuiltinModule('fs'), true);
      assert.strictEqual(registry.isBuiltinModule('fs/promises'), true);
    });
  });

  describe('Module listing', () => {
    it('should list all supported builtin modules', async () => {
      const registry = new BuiltinRegistry();
      const modules = registry.listModules();
      assert.ok(modules.includes('fs'));
      assert.ok(modules.includes('path'));
      assert.ok(modules.includes('http'));
      assert.ok(modules.includes('https'));
      assert.ok(modules.includes('crypto'));
      assert.ok(modules.includes('child_process'));
      assert.ok(modules.includes('os'));
      assert.ok(modules.includes('url'));
      assert.ok(modules.includes('util'));
      assert.ok(modules.includes('events'));
      assert.ok(modules.includes('fs/promises'));
    });
  });

  describe('createNodeId', () => {
    it('should create correct node ID format', async () => {
      const registry = new BuiltinRegistry();
      const id = registry.createNodeId('fs', 'readFile');
      assert.strictEqual(id, 'EXTERNAL_FUNCTION:fs.readFile');
    });

    it('should handle fs/promises correctly', async () => {
      const registry = new BuiltinRegistry();
      const id = registry.createNodeId('fs/promises', 'readFile');
      assert.strictEqual(id, 'EXTERNAL_FUNCTION:fs/promises.readFile');
    });

    it('should normalize node: prefix in node ID', async () => {
      const registry = new BuiltinRegistry();
      const id = registry.createNodeId('node:fs', 'readFile');
      assert.strictEqual(id, 'EXTERNAL_FUNCTION:fs.readFile');
    });
  });
});

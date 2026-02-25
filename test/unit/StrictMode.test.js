/**
 * Strict Mode Tests (REG-330)
 *
 * Tests the strict mode functionality that causes analysis to fail
 * when enrichers cannot resolve references.
 *
 * Strict mode is a debugging tool for dogfooding Grafema on Grafema.
 * When enabled (--strict flag or strict: true in config):
 * - Enrichers report unresolved references as StrictModeError
 * - All errors are collected (not fail-fast)
 * - Analysis fails after ENRICHMENT phase if any errors exist
 *
 * Key behaviors tested:
 * 1. Normal mode: unresolved references produce warnings, analysis continues
 * 2. Strict mode: unresolved references produce fatal errors
 * 3. External methods (console.log, Math.random): NOT flagged even in strict mode
 * 4. Multiple errors are collected, not fail-fast
 *
 * These tests are written TDD-style - they will fail until implementation.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { StrictModeError } from '@grafema/core';
import { MethodCallResolver } from '@grafema/core';
import { FunctionCallResolver } from '@grafema/core';
import { ArgumentParameterLinker } from '@grafema/core';
import { AliasTracker } from '@grafema/core';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Strict Mode', () => {
  let testCounter = 0;

  async function setupBackend() {
    const testDir = join(tmpdir(), `grafema-test-strict-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    const db = await createTestDatabase();
    const backend = db.backend;

    return { backend, testDir };
  }

  // ===========================================================================
  // TESTS: MethodCallResolver Strict Mode
  // ===========================================================================

  describe('MethodCallResolver', () => {
    it('should return no errors in normal mode for unresolved method', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Create an unresolved method call - object exists but method doesn't
        await backend.addNode({
          id: 'unknown-call',
          type: 'CALL',
          name: 'unknownObj.doSomething',
          file: 'app.js',
          line: 5,
          object: 'unknownObj',
          method: 'doSomething'
        });

        await backend.flush();

        // Normal mode - should not report errors
        const result = await resolver.execute({ graph: backend, strictMode: false });

        assert.strictEqual(result.errors.length, 0, 'No errors in normal mode');
        // REG-583: unknown object method calls now resolve to UNKNOWN_CALL_TARGET (not unresolved)
        assert.strictEqual(result.metadata.unknownResolved, 1, 'Should track unknownResolved');
      } finally {
        await backend.close();
      }
    });

    it('should return StrictModeError when strictMode=true and method unresolved', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'unknown-call',
          type: 'CALL',
          name: 'unknownObj.doSomething',
          file: 'app.js',
          line: 5,
          object: 'unknownObj',
          method: 'doSomething'
        });

        await backend.flush();

        // Strict mode - should report error
        const result = await resolver.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 1, 'Should have one error');
        assert.ok(result.errors[0] instanceof StrictModeError, 'Error should be StrictModeError');
        assert.strictEqual(result.errors[0].code, 'STRICT_UNRESOLVED_METHOD');
        assert.ok(result.errors[0].message.includes('unknownObj.doSomething'));
      } finally {
        await backend.close();
      }
    });

    it('should NOT report error for external methods even in strict mode', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // console.log is an external method - should never be flagged
        await backend.addNode({
          id: 'console-call',
          type: 'CALL',
          name: 'console.log',
          file: 'app.js',
          line: 5,
          object: 'console',
          method: 'log'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 0, 'No errors for external methods');
      } finally {
        await backend.close();
      }
    });

    it('should NOT report error for Math built-in even in strict mode', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'math-call',
          type: 'CALL',
          name: 'Math.random',
          file: 'app.js',
          line: 5,
          object: 'Math',
          method: 'random'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 0, 'No errors for Math built-in');
      } finally {
        await backend.close();
      }
    });

    it('should NOT report error for JSON built-in even in strict mode', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'json-call',
          type: 'CALL',
          name: 'JSON.parse',
          file: 'app.js',
          line: 5,
          object: 'JSON',
          method: 'parse'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 0, 'No errors for JSON built-in');
      } finally {
        await backend.close();
      }
    });

    it('should NOT report error for Promise built-in even in strict mode', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'promise-call',
          type: 'CALL',
          name: 'Promise.resolve',
          file: 'app.js',
          line: 5,
          object: 'Promise',
          method: 'resolve'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 0, 'No errors for Promise built-in');
      } finally {
        await backend.close();
      }
    });

    it('should NOT report error when method is already resolved', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Create class with method
        await backend.addNodes([
          {
            id: 'user-class',
            type: 'CLASS',
            name: 'User',
            file: 'user.js',
            line: 1
          },
          {
            id: 'user-save-method',
            type: 'METHOD',
            name: 'save',
            file: 'user.js',
            line: 5
          },
          {
            id: 'user-save-call',
            type: 'CALL',
            name: 'User.save',
            file: 'app.js',
            line: 10,
            object: 'User',
            method: 'save'
          }
        ]);

        // Create CONTAINS edge: CLASS -> METHOD
        await backend.addEdge({
          src: 'user-class',
          dst: 'user-save-method',
          type: 'CONTAINS'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        // Method is resolved - no errors
        assert.strictEqual(result.errors.length, 0, 'No errors when method resolved');
        assert.strictEqual(result.created.edges, 1, 'Should create CALLS edge');
      } finally {
        await backend.close();
      }
    });

    it('should provide actionable error message with file and line', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'unknown-call',
          type: 'CALL',
          name: 'service.process',
          file: 'src/controllers/handler.js',
          line: 42,
          object: 'service',
          method: 'process'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 1);
        const error = result.errors[0];

        // Error should include context for debugging
        assert.strictEqual(error.context.filePath, 'src/controllers/handler.js');
        assert.strictEqual(error.context.lineNumber, 42);
        assert.strictEqual(error.context.plugin, 'MethodCallResolver');
        assert.strictEqual(error.context.phase, 'ENRICHMENT');

        // Suggestion should help fix the issue
        assert.ok(error.suggestion, 'Should have suggestion');
        assert.ok(error.suggestion.includes('service'), 'Suggestion should mention object');
      } finally {
        await backend.close();
      }
    });
  });

  // ===========================================================================
  // TESTS: FunctionCallResolver Strict Mode
  // ===========================================================================

  describe('FunctionCallResolver', () => {
    it('should return no errors in normal mode for broken re-export', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // Re-export pointing to missing export
        await backend.addNodes([
          {
            id: 'index-reexport-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/index.js',
            exportType: 'named',
            local: 'foo',
            source: './other'  // other.js has no 'foo' export
          },
          {
            id: 'other-bar-export',
            type: 'EXPORT',
            name: 'bar',
            file: '/project/other.js',
            exportType: 'named',
            local: 'bar'
            // Note: No 'foo' export!
          },
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            source: './index',
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          }
        ]);

        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'index-reexport-foo'
        });

        await backend.flush();

        // Normal mode - no errors, just skipped
        const result = await resolver.execute({ graph: backend, strictMode: false });

        assert.strictEqual(result.errors.length, 0, 'No errors in normal mode');
        assert.ok(result.metadata.skipped.reExportsBroken > 0, 'Should track as skipped');
      } finally {
        await backend.close();
      }
    });

    it('should return StrictModeError when strictMode=true and re-export broken', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // Same setup as above
        await backend.addNodes([
          {
            id: 'index-reexport-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/index.js',
            exportType: 'named',
            local: 'foo',
            source: './other'
          },
          {
            id: 'other-bar-export',
            type: 'EXPORT',
            name: 'bar',
            file: '/project/other.js',
            exportType: 'named',
            local: 'bar'
          },
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            source: './index',
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          }
        ]);

        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'index-reexport-foo'
        });

        await backend.flush();

        // Strict mode - should report error
        const result = await resolver.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 1, 'Should have one error');
        assert.ok(result.errors[0] instanceof StrictModeError, 'Error should be StrictModeError');
        assert.strictEqual(result.errors[0].code, 'STRICT_BROKEN_IMPORT');
      } finally {
        await backend.close();
      }
    });

    it('should NOT report error for external module imports', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // External import (lodash) - should never be flagged
        await backend.addNodes([
          {
            id: 'main-import-lodash',
            type: 'IMPORT',
            name: '_',
            file: '/project/main.js',
            line: 1,
            source: 'lodash',  // External module
            importType: 'default',
            imported: 'default',
            local: '_'
          },
          {
            id: 'main-call-lodash',
            type: 'CALL',
            name: '_',
            file: '/project/main.js',
            line: 3
          }
        ]);

        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 0, 'No errors for external imports');
      } finally {
        await backend.close();
      }
    });
  });

  // ===========================================================================
  // TESTS: ArgumentParameterLinker Strict Mode
  // ===========================================================================

  describe('ArgumentParameterLinker', () => {
    it('should return no errors in normal mode for unresolved call', async () => {
      const { backend } = await setupBackend();

      try {
        const linker = new ArgumentParameterLinker();

        // Call with arguments but no CALLS edge (unresolved target)
        await backend.addNode({
          id: 'unresolved-call',
          type: 'CALL',
          name: 'unknownFunc',
          file: 'app.js',
          line: 10
        });

        // Argument node
        await backend.addNode({
          id: 'arg-1',
          type: 'LITERAL',
          value: 'test',
          file: 'app.js',
          line: 10
        });

        // PASSES_ARGUMENT edge
        await backend.addEdge({
          src: 'unresolved-call',
          dst: 'arg-1',
          type: 'PASSES_ARGUMENT',
          argIndex: 0
        });

        await backend.flush();

        // Normal mode - no errors
        const result = await linker.execute({ graph: backend, strictMode: false });

        assert.strictEqual(result.errors.length, 0, 'No errors in normal mode');
        assert.strictEqual(result.metadata.unresolvedCalls, 1, 'Should track unresolved');
      } finally {
        await backend.close();
      }
    });

    it('should return StrictModeError when strictMode=true and call has no CALLS edge', async () => {
      const { backend } = await setupBackend();

      try {
        const linker = new ArgumentParameterLinker();

        // Same setup
        await backend.addNode({
          id: 'unresolved-call',
          type: 'CALL',
          name: 'unknownFunc',
          file: 'app.js',
          line: 10
        });

        await backend.addNode({
          id: 'arg-1',
          type: 'LITERAL',
          value: 'test',
          file: 'app.js',
          line: 10
        });

        await backend.addEdge({
          src: 'unresolved-call',
          dst: 'arg-1',
          type: 'PASSES_ARGUMENT',
          argIndex: 0
        });

        await backend.flush();

        // Strict mode - should report error
        const result = await linker.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 1, 'Should have one error');
        assert.ok(result.errors[0] instanceof StrictModeError, 'Error should be StrictModeError');
        assert.strictEqual(result.errors[0].code, 'STRICT_UNRESOLVED_ARGUMENT');
      } finally {
        await backend.close();
      }
    });
  });

  // ===========================================================================
  // TESTS: AliasTracker Strict Mode
  // ===========================================================================

  describe('AliasTracker', () => {
    it('should return no errors in normal mode for depth exceeded', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // Create 12-level alias chain (exceeds MAX_DEPTH=10)
        const nodes = [
          { id: 'db-class', type: 'CLASS', name: 'Database', file: 'db.js' },
          { id: 'db-query', type: 'METHOD', name: 'query', file: 'db.js' },
          { id: 'expr-query', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'Database', property: 'query', file: 'db.js' }
        ];

        for (let i = 1; i <= 12; i++) {
          nodes.push({ id: `var-${i}`, type: 'VARIABLE', name: `level${i}`, file: `level${i}.js` });
        }
        nodes.push({ id: 'call-final', type: 'CALL', name: 'level12', file: 'level12.js' });

        await backend.addNodes(nodes);

        await backend.addEdge({ src: 'db-class', dst: 'db-query', type: 'CONTAINS' });
        await backend.addEdge({ src: 'var-1', dst: 'expr-query', type: 'ASSIGNED_FROM' });
        for (let i = 2; i <= 12; i++) {
          await backend.addEdge({ src: `var-${i}`, dst: `var-${i - 1}`, type: 'ASSIGNED_FROM' });
        }
        await backend.flush();

        // Normal mode - should warn but no errors
        const result = await tracker.execute({ graph: backend, strictMode: false });

        assert.strictEqual(result.errors.length, 0, 'No errors in normal mode');
        assert.ok(result.metadata.depthExceeded >= 1, 'Should track depth exceeded');
      } finally {
        await backend.close();
      }
    });

    it('should return StrictModeError when strictMode=true and depth exceeded', async () => {
      const { backend } = await setupBackend();

      try {
        const tracker = new AliasTracker();

        // Same 12-level chain setup
        const nodes = [
          { id: 'db-class', type: 'CLASS', name: 'Database', file: 'db.js' },
          { id: 'db-query', type: 'METHOD', name: 'query', file: 'db.js' },
          { id: 'expr-query', type: 'EXPRESSION', expressionType: 'MemberExpression', object: 'Database', property: 'query', file: 'db.js' }
        ];

        for (let i = 1; i <= 12; i++) {
          nodes.push({ id: `var-${i}`, type: 'VARIABLE', name: `level${i}`, file: `level${i}.js` });
        }
        nodes.push({ id: 'call-final', type: 'CALL', name: 'level12', file: 'level12.js' });

        await backend.addNodes(nodes);

        await backend.addEdge({ src: 'db-class', dst: 'db-query', type: 'CONTAINS' });
        await backend.addEdge({ src: 'var-1', dst: 'expr-query', type: 'ASSIGNED_FROM' });
        for (let i = 2; i <= 12; i++) {
          await backend.addEdge({ src: `var-${i}`, dst: `var-${i - 1}`, type: 'ASSIGNED_FROM' });
        }
        await backend.flush();

        // Strict mode - should report error
        const result = await tracker.execute({ graph: backend, strictMode: true });

        assert.ok(result.errors.length >= 1, 'Should have at least one error');
        assert.ok(result.errors[0] instanceof StrictModeError, 'Error should be StrictModeError');
        assert.strictEqual(result.errors[0].code, 'STRICT_ALIAS_DEPTH_EXCEEDED');
      } finally {
        await backend.close();
      }
    });
  });

  // ===========================================================================
  // TESTS: Error Collection (Not Fail-Fast)
  // ===========================================================================

  describe('Error collection (not fail-fast)', () => {
    it('should collect multiple errors before returning', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Multiple unresolved calls
        await backend.addNodes([
          {
            id: 'unknown-call-1',
            type: 'CALL',
            name: 'obj1.method1',
            file: 'app.js',
            line: 5,
            object: 'obj1',
            method: 'method1'
          },
          {
            id: 'unknown-call-2',
            type: 'CALL',
            name: 'obj2.method2',
            file: 'app.js',
            line: 10,
            object: 'obj2',
            method: 'method2'
          },
          {
            id: 'unknown-call-3',
            type: 'CALL',
            name: 'obj3.method3',
            file: 'app.js',
            line: 15,
            object: 'obj3',
            method: 'method3'
          }
        ]);

        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        // All errors should be collected, not just the first one
        assert.strictEqual(result.errors.length, 3, 'Should collect all 3 errors');
        assert.strictEqual(result.metadata.unknownResolved, 3, 'Should track all 3 unresolved');

        // Each error should have unique context
        const lines = result.errors.map(e => e.context.lineNumber);
        assert.ok(lines.includes(5), 'Should include line 5');
        assert.ok(lines.includes(10), 'Should include line 10');
        assert.ok(lines.includes(15), 'Should include line 15');
      } finally {
        await backend.close();
      }
    });

    it('should collect errors from multiple files', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNodes([
          {
            id: 'call-1',
            type: 'CALL',
            name: 'svc.process',
            file: 'src/handler.js',
            line: 10,
            object: 'svc',
            method: 'process'
          },
          {
            id: 'call-2',
            type: 'CALL',
            name: 'db.findRecords',
            file: 'src/repository.js',
            line: 20,
            object: 'db',
            method: 'findRecords'
          },
          {
            id: 'call-3',
            type: 'CALL',
            name: 'api.fetch',
            file: 'src/client.js',
            line: 30,
            object: 'api',
            method: 'fetch'
          }
        ]);

        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        assert.strictEqual(result.errors.length, 3, 'Should collect errors from all files');

        const files = result.errors.map(e => e.context.filePath);
        assert.ok(files.includes('src/handler.js'));
        assert.ok(files.includes('src/repository.js'));
        assert.ok(files.includes('src/client.js'));
      } finally {
        await backend.close();
      }
    });
  });

  // ===========================================================================
  // TESTS: Mixed Resolved and Unresolved
  // ===========================================================================

  describe('Mixed resolved and unresolved', () => {
    it('should only report errors for unresolved, not resolved', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNodes([
          // Class with method (will resolve)
          { id: 'user-class', type: 'CLASS', name: 'User', file: 'user.js', line: 1 },
          { id: 'user-save', type: 'METHOD', name: 'save', file: 'user.js', line: 5 },

          // Resolved call
          {
            id: 'resolved-call',
            type: 'CALL',
            name: 'User.save',
            file: 'app.js',
            line: 10,
            object: 'User',
            method: 'save'
          },

          // Unresolved call
          {
            id: 'unresolved-call',
            type: 'CALL',
            name: 'unknownObj.doSomething',
            file: 'app.js',
            line: 20,
            object: 'unknownObj',
            method: 'doSomething'
          },

          // External call (should not error)
          {
            id: 'external-call',
            type: 'CALL',
            name: 'console.log',
            file: 'app.js',
            line: 30,
            object: 'console',
            method: 'log'
          }
        ]);

        await backend.addEdge({ src: 'user-class', dst: 'user-save', type: 'CONTAINS' });
        await backend.flush();

        const result = await resolver.execute({ graph: backend, strictMode: true });

        // Only unresolved should produce error
        assert.strictEqual(result.errors.length, 1, 'Only one error for unresolved');
        assert.ok(result.errors[0].message.includes('unknownObj.doSomething'));

        // Resolved call should create edge
        const edges = await backend.getOutgoingEdges('resolved-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Resolved call should have CALLS edge');
      } finally {
        await backend.close();
      }
    });
  });

  // ===========================================================================
  // TESTS: Default Behavior (strictMode undefined)
  // ===========================================================================

  describe('Default behavior (strictMode undefined)', () => {
    it('should behave as strictMode=false when flag is undefined', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'unknown-call',
          type: 'CALL',
          name: 'unknownObj.doSomething',
          file: 'app.js',
          line: 5,
          object: 'unknownObj',
          method: 'doSomething'
        });

        await backend.flush();

        // No strictMode flag passed
        const result = await resolver.execute({ graph: backend });

        assert.strictEqual(result.errors.length, 0, 'No errors when strictMode undefined');
        assert.strictEqual(result.metadata.unknownResolved, 1, 'Should track unresolved');
      } finally {
        await backend.close();
      }
    });
  });
});

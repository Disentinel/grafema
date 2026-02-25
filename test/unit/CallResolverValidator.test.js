/**
 * CallResolverValidator Tests
 *
 * Tests the Datalog-based validation of function call resolution
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

describe('CallResolverValidator', () => {
  let testCounter = 0;

  async function setupTest(files) {
    const testDir = join(tmpdir(), `navi-test-callresolver-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({
        name: `test-callresolver-${testCounter}`,
        type: 'module'
      })
    );

    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(testDir, filename), content);
    }

    const db = await createTestDatabase();
    const backend = db.backend;

    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(testDir);

    return { backend, db, testDir };
  }

  describe('Datalog attr predicate', () => {
    it('should access node attributes via attr()', async () => {
      const { backend } = await setupTest({
        'index.js': `
function foo() { return 42; }
const result = foo();
        `
      });

      try {
        // Add custom node with metadata to test attr access
        await backend.addNode({
          id: 'test-method-call',
          type: 'CALL',
          name: 'arr.map',
          file: 'test.js',
          object: 'arr',
          method: 'map'
        });

        // Query using Datalog attr predicate via checkGuarantee
        // Note: datalogLoadRules + datalogQuery doesn't work because the Rust server
        // doesn't persist rules - use checkGuarantee which includes rules in the query
        const results = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), attr(X, "object", _).
        `);

        // Should find our manually added node
        assert.ok(results.length >= 1, 'Should find at least one method call');

        const found = results.some(r => {
          const nodeId = r.bindings.find(b => b.name === 'X')?.value;
          return nodeId !== undefined;
        });
        assert.ok(found, 'Should find the method call node');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Unresolved function calls', () => {
    it('should detect call to undefined function using Datalog', async () => {
      const { backend } = await setupTest({
        'index.js': `
// Empty file - we add nodes manually
        `
      });

      try {
        // Add CALL_SITE without corresponding function (simulates unresolved call)
        await backend.addNode({
          id: 'unresolved-call',
          type: 'CALL',
          name: 'undefinedFunction',
          file: 'test.js',
          line: 5
          // Note: no "object" field = this is a CALL_SITE, not METHOD_CALL
        });

        // Check the guarantee
        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        // Should find exactly one violation
        assert.strictEqual(violations.length, 1, 'Should find one unresolved call');

        console.log('Datalog correctly detected unresolved function call');
      } finally {
        await backend.close();
      }
    });

    it('should NOT flag resolved function calls', async () => {
      const { backend } = await setupTest({
        'index.js': `
function foo() { return 42; }
const result = foo();
        `
      });

      try {
        // Check the guarantee - should find no violations for properly resolved calls
        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        // In this case, foo() should be resolved to the function definition
        // Note: This depends on the analyzer creating proper CALLS edges
        console.log(`Found ${violations.length} violations`);

        // Get details for any violations (for debugging)
        for (const v of violations) {
          const nodeId = v.bindings.find(b => b.name === 'X')?.value;
          if (nodeId) {
            const node = await backend.getNode(nodeId);
            console.log(`  Violation: ${node?.name} in ${node?.file}`);
          }
        }
      } finally {
        await backend.close();
      }
    });

    it('should NOT flag method calls (external)', async () => {
      const { backend } = await setupTest({
        'index.js': `
// Empty - we add manually
        `
      });

      try {
        // Add METHOD_CALL (has "object" metadata)
        await backend.addNode({
          id: 'method-call',
          type: 'CALL',
          name: 'console.log',
          file: 'test.js',
          object: 'console',
          method: 'log'
        });

        // Check the guarantee
        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        // Should NOT flag the method call (it has "object" attr)
        assert.strictEqual(violations.length, 0, 'Method calls should not be flagged');

        console.log('Datalog correctly ignored external method call');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Combined guarantee checking', () => {
    it('should validate both CALL_SITE and METHOD_CALL correctly', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // Add various node types
        await backend.addNodes([
          // Resolved CALL_SITE
          {
            id: 'resolved-call',
            type: 'CALL',
            name: 'myFunction',
            file: 'test.js'
          },
          // Target function
          {
            id: 'my-function',
            type: 'FUNCTION',
            name: 'myFunction',
            file: 'test.js'
          },
          // Unresolved CALL_SITE
          {
            id: 'unresolved-call',
            type: 'CALL',
            name: 'unknownFunc',
            file: 'test.js'
          },
          // METHOD_CALL (external)
          {
            id: 'external-method',
            type: 'CALL',
            name: 'arr.filter',
            file: 'test.js',
            object: 'arr',
            method: 'filter'
          }
        ]);

        // Add CALLS edge for resolved call
        await backend.addEdge({
          src: 'resolved-call',
          dst: 'my-function',
          type: 'CALLS'
        });

        // Flush to ensure all data is written
        await backend.flush();

        // Check guarantee
        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        // Should only find the unresolved CALL_SITE
        assert.strictEqual(violations.length, 1, 'Should find exactly 1 unresolved call');

        const nodeId = violations[0].bindings.find(b => b.name === 'X')?.value;
        const node = await backend.getNode(nodeId);
        assert.strictEqual(node?.name, 'unknownFunc', 'Should flag unknownFunc');

        console.log('Combined guarantee check passed correctly');
      } finally {
        await backend.close();
      }
    });
  });

  // ==========================================================================
  // EDGE CASES AND ADVERSARIAL TESTS
  // ==========================================================================

  describe('Edge Cases - Shadowing and Aliasing', () => {
    it('should handle local variable shadowing a class name', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          // Class with method
          { id: 'user-class', type: 'CLASS', name: 'User', file: 'models.js' },
          { id: 'user-save', type: 'METHOD', name: 'save', file: 'models.js' },
          // Local variable named "User" (shadowing!)
          { id: 'user-var', type: 'VARIABLE', name: 'User', file: 'app.js' },
          // Call to User.save() - which User is it?
          { id: 'shadow-call', type: 'CALL', name: 'User.save', file: 'app.js', object: 'User', method: 'save' }
        ]);

        await backend.addEdge({ src: 'user-class', dst: 'user-save', type: 'CONTAINS' });
        await backend.flush();

        // This is a METHOD_CALL (has object), so should NOT be flagged by CALL_SITE rule
        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 0, 'Shadowed method call should not be flagged as CALL_SITE');
        console.log('Shadowing edge case handled correctly');
      } finally {
        await backend.close();
      }
    });

    it('should detect aliased function that becomes unresolvable', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // const m = obj.method;
        // m(); // This is a CALL_SITE now, not METHOD_CALL!
        await backend.addNodes([
          { id: 'alias-var', type: 'VARIABLE', name: 'm', file: 'app.js' },
          // m() - this looks like a regular function call!
          { id: 'alias-call', type: 'CALL', name: 'm', file: 'app.js' }
          // Note: no 'object' field - this is a CALL_SITE
        ]);

        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        // Should flag this - aliased method call becomes unresolvable CALL_SITE
        assert.strictEqual(violations.length, 1, 'Aliased method call should be flagged');
        console.log('Aliased function detection works');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Edge Cases - Chained and Nested Calls', () => {
    it('should handle chained method calls', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // arr.filter().map().reduce() - each is a separate METHOD_CALL
        await backend.addNodes([
          { id: 'chain-1', type: 'CALL', name: 'arr.filter', file: 'app.js', object: 'arr', method: 'filter' },
          { id: 'chain-2', type: 'CALL', name: '<result>.map', file: 'app.js', object: '<chain>', method: 'map' },
          { id: 'chain-3', type: 'CALL', name: '<result>.reduce', file: 'app.js', object: '<chain>', method: 'reduce' }
        ]);

        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        // All have 'object' field, so none should be flagged
        assert.strictEqual(violations.length, 0, 'Chained calls should not be flagged');
        console.log('Chained calls handled correctly');
      } finally {
        await backend.close();
      }
    });

    it('should handle nested object method calls', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // obj.nested.deeply.method()
        await backend.addNodes([
          { id: 'nested-call', type: 'CALL', name: 'obj.nested.deeply.method', file: 'app.js', object: 'obj.nested.deeply', method: 'method' }
        ]);

        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 0, 'Nested object calls should not be flagged');
        console.log('Nested object calls handled correctly');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Edge Cases - Dynamic and Computed Calls', () => {
    it('should handle dynamic method access (computed property)', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // obj[methodName]() - dynamic, but still a method call
        await backend.addNodes([
          { id: 'dynamic-call', type: 'CALL', name: 'obj[dynamic]', file: 'app.js', object: 'obj', method: '<computed>' }
        ]);

        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 0, 'Dynamic method calls should not be flagged as CALL_SITE');
        console.log('Dynamic method calls handled correctly');
      } finally {
        await backend.close();
      }
    });

    it('should handle eval as external (with CALLS edge) but flag Function constructor', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          // eval gets a CALLS edge from ExternalCallResolver (REG-583)
          { id: 'ECMASCRIPT_BUILTIN:eval', type: 'ECMASCRIPT_BUILTIN', name: 'eval', file: '' },
          { id: 'eval-call', type: 'CALL', name: 'eval', file: 'app.js' },
          // Function constructor is NOT a builtin - should be flagged
          { id: 'func-ctor', type: 'CALL', name: 'Function', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'eval-call', dst: 'ECMASCRIPT_BUILTIN:eval', type: 'CALLS' });
        await backend.flush();

        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        // Only Function should be flagged (eval has CALLS edge to ECMASCRIPT_BUILTIN)
        assert.strictEqual(result.errors?.length ?? 0, 1, 'Only Function should be flagged');
        assert.ok(result.errors[0].message.includes('Function'), 'Should flag Function');

        const summary = result.metadata?.summary;
        assert.strictEqual(summary.resolvedExternal, 1, 'eval should be resolvedExternal');
        assert.strictEqual(summary.unresolvedCalls, 1, 'Function should be unresolved');

        console.log('eval recognized as external, Function flagged');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Edge Cases - Prototype and bind/call/apply', () => {
    it('should handle prototype method calls', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // Array.prototype.map.call(arrayLike, fn)
        await backend.addNodes([
          { id: 'proto-call', type: 'CALL', name: 'Array.prototype.map.call', file: 'app.js', object: 'Array.prototype.map', method: 'call' }
        ]);

        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 0, 'Prototype method calls should not be flagged');
        console.log('Prototype method calls handled correctly');
      } finally {
        await backend.close();
      }
    });

    it('should handle bind/call/apply patterns', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          // func.bind(this)
          { id: 'bind-call', type: 'CALL', name: 'func.bind', file: 'app.js', object: 'func', method: 'bind' },
          // func.call(ctx, args)
          { id: 'call-call', type: 'CALL', name: 'func.call', file: 'app.js', object: 'func', method: 'call' },
          // func.apply(ctx, [args])
          { id: 'apply-call', type: 'CALL', name: 'func.apply', file: 'app.js', object: 'func', method: 'apply' }
        ]);

        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 0, 'bind/call/apply should not be flagged');
        console.log('bind/call/apply patterns handled correctly');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Edge Cases - False Positive Prevention', () => {
    it('should NOT flag imported function calls', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // import { helper } from './utils';
        // helper(); - this should be resolved via import
        await backend.addNodes([
          { id: 'imported-fn', type: 'FUNCTION', name: 'helper', file: 'utils.js' },
          { id: 'import-call', type: 'CALL', name: 'helper', file: 'app.js' }
        ]);

        // Simulate import resolution with CALLS edge
        await backend.addEdge({ src: 'import-call', dst: 'imported-fn', type: 'CALLS' });
        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 0, 'Imported function calls should not be flagged');
        console.log('Imported function calls not flagged (false positive prevented)');
      } finally {
        await backend.close();
      }
    });

    it('should NOT flag IIFE (Immediately Invoked Function Expression)', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // (function() { ... })()
        // (() => { ... })()
        await backend.addNodes([
          { id: 'iife-fn', type: 'FUNCTION', name: '<anonymous>', file: 'app.js' },
          { id: 'iife-call', type: 'CALL', name: '<anonymous>', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'iife-call', dst: 'iife-fn', type: 'CALLS' });
        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 0, 'IIFE should not be flagged');
        console.log('IIFE not flagged (false positive prevented)');
      } finally {
        await backend.close();
      }
    });

    it('should NOT flag callback functions passed to higher-order functions', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // arr.map(callback) - callback is called internally by map
        // The CALL to callback happens inside Array.prototype.map, not in user code
        await backend.addNodes([
          { id: 'callback-fn', type: 'FUNCTION', name: 'callback', file: 'app.js' },
          { id: 'map-call', type: 'CALL', name: 'arr.map', file: 'app.js', object: 'arr', method: 'map' }
          // Note: we don't create a CALL node for the internal callback invocation
        ]);

        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 0, 'Callback patterns should not be flagged');
        console.log('Callback patterns handled correctly');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Edge Cases - False Negative Prevention', () => {
    it('should flag typo in function name', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          { id: 'real-fn', type: 'FUNCTION', name: 'processData', file: 'app.js' },
          // Typo: procesData (missing 's')
          { id: 'typo-call', type: 'CALL', name: 'procesData', file: 'app.js' }
        ]);

        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 1, 'Typo in function name should be flagged');

        const nodeId = violations[0].bindings.find(b => b.name === 'X')?.value;
        const node = await backend.getNode(nodeId);
        assert.strictEqual(node?.name, 'procesData', 'Should flag the typo call');

        console.log('Typo in function name detected');
      } finally {
        await backend.close();
      }
    });

    it('should flag call to function from wrong module', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          // Function exists in utils.js
          { id: 'util-fn', type: 'FUNCTION', name: 'helper', file: 'utils.js' },
          // But called from app.js without import
          { id: 'unimported-call', type: 'CALL', name: 'helper', file: 'app.js' }
          // No CALLS edge because not properly imported
        ]);

        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 1, 'Call to unimported function should be flagged');
        console.log('Unimported function call detected');
      } finally {
        await backend.close();
      }
    });

    it('should flag call to deleted/removed function', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // Simulates: function was removed but call still exists
        await backend.addNodes([
          // No FUNCTION node for 'oldHelper'
          { id: 'stale-call', type: 'CALL', name: 'oldHelper', file: 'app.js' }
        ]);

        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 1, 'Call to removed function should be flagged');
        console.log('Stale function call detected');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Edge Cases - Unusual Names', () => {
    it('should handle functions with special characters in names', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          // Valid JS: const $helper = () => {}; $helper();
          { id: 'dollar-fn', type: 'FUNCTION', name: '$helper', file: 'app.js' },
          { id: 'dollar-call', type: 'CALL', name: '$helper', file: 'app.js' },
          // Valid JS: const _private = () => {}; _private();
          { id: 'underscore-fn', type: 'FUNCTION', name: '_private', file: 'app.js' },
          { id: 'underscore-call', type: 'CALL', name: '_private', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'dollar-call', dst: 'dollar-fn', type: 'CALLS' });
        await backend.addEdge({ src: 'underscore-call', dst: 'underscore-fn', type: 'CALLS' });
        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 0, 'Special character function names should work');
        console.log('Special character names handled correctly');
      } finally {
        await backend.close();
      }
    });

    it('should handle unicode function names', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          // Valid JS: const привет = () => {}; привет();
          { id: 'unicode-fn', type: 'FUNCTION', name: 'привет', file: 'app.js' },
          { id: 'unicode-call', type: 'CALL', name: 'привет', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'unicode-call', dst: 'unicode-fn', type: 'CALLS' });
        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 0, 'Unicode function names should work');
        console.log('Unicode names handled correctly');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Edge Cases - Multiple Calls', () => {
    it('should resolve multiple calls to same function', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          { id: 'target-fn', type: 'FUNCTION', name: 'helper', file: 'app.js' },
          { id: 'call-1', type: 'CALL', name: 'helper', file: 'app.js', line: 10 },
          { id: 'call-2', type: 'CALL', name: 'helper', file: 'app.js', line: 15 },
          { id: 'call-3', type: 'CALL', name: 'helper', file: 'app.js', line: 20 }
        ]);

        // All calls resolved
        await backend.addEdge({ src: 'call-1', dst: 'target-fn', type: 'CALLS' });
        await backend.addEdge({ src: 'call-2', dst: 'target-fn', type: 'CALLS' });
        await backend.addEdge({ src: 'call-3', dst: 'target-fn', type: 'CALLS' });
        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 0, 'All calls to same function should resolve');
        console.log('Multiple calls to same function handled correctly');
      } finally {
        await backend.close();
      }
    });

    it('should flag only unresolved calls among multiple', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          { id: 'target-fn', type: 'FUNCTION', name: 'helper', file: 'app.js' },
          { id: 'call-ok-1', type: 'CALL', name: 'helper', file: 'app.js' },
          { id: 'call-ok-2', type: 'CALL', name: 'helper', file: 'app.js' },
          { id: 'call-bad', type: 'CALL', name: 'helperTypo', file: 'app.js' } // Unresolved
        ]);

        await backend.addEdge({ src: 'call-ok-1', dst: 'target-fn', type: 'CALLS' });
        await backend.addEdge({ src: 'call-ok-2', dst: 'target-fn', type: 'CALLS' });
        // call-bad has no CALLS edge
        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 1, 'Only unresolved call should be flagged');

        const nodeId = violations[0].bindings.find(b => b.name === 'X')?.value;
        const node = await backend.getNode(nodeId);
        assert.strictEqual(node?.name, 'helperTypo', 'Should flag the typo');

        console.log('Mixed resolved/unresolved calls handled correctly');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Stress Tests', () => {
    it('should handle large number of calls', async () => {
      const { backend } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        const nodes = [
          { id: 'fn-1', type: 'FUNCTION', name: 'func1', file: 'app.js' },
          { id: 'fn-2', type: 'FUNCTION', name: 'func2', file: 'app.js' }
        ];

        const edges = [];

        // Add 100 resolved calls
        for (let i = 0; i < 100; i++) {
          const fnId = i % 2 === 0 ? 'fn-1' : 'fn-2';
          const fnName = i % 2 === 0 ? 'func1' : 'func2';
          nodes.push({
            id: `call-${i}`,
            type: 'CALL',
            name: fnName,
            file: 'app.js',
            line: i
          });
          edges.push({ src: `call-${i}`, dst: fnId, type: 'CALLS' });
        }

        // Add 5 unresolved calls
        for (let i = 0; i < 5; i++) {
          nodes.push({
            id: `bad-call-${i}`,
            type: 'CALL',
            name: `unknownFunc${i}`,
            file: 'app.js'
          });
        }

        await backend.addNodes(nodes);
        for (const edge of edges) {
          await backend.addEdge(edge);
        }
        await backend.flush();

        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        assert.strictEqual(violations.length, 5, 'Should find exactly 5 unresolved calls');
        console.log('Large number of calls handled correctly');
      } finally {
        await backend.close();
      }
    });
  });

  // ==========================================================================
  // REG-227: CallResolverValidator Resolution Categories
  // ==========================================================================

  describe('REG-227: Resolution Type Categorization', () => {
    it('should NOT flag JavaScript built-in function calls (REG-583 update)', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // REG-583: parseInt and setTimeout now get CALLS edges to typed nodes
        // from ExternalCallResolver. Only require remains as a pure builtin fallback.
        await backend.addNodes([
          // parseInt has CALLS edge to ECMASCRIPT_BUILTIN:parseInt
          { id: 'ECMASCRIPT_BUILTIN:parseInt', type: 'ECMASCRIPT_BUILTIN', name: 'parseInt', file: '' },
          { id: 'parseInt-call', type: 'CALL', name: 'parseInt', file: 'app.js' },
          // setTimeout has CALLS edge to WEB_API:setTimeout
          { id: 'WEB_API:setTimeout', type: 'WEB_API', name: 'setTimeout', file: '' },
          { id: 'setTimeout-call', type: 'CALL', name: 'setTimeout', file: 'app.js' },
          // require has no CALLS edge — recognized by REQUIRE_BUILTINS fallback
          { id: 'require-call', type: 'CALL', name: 'require', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'parseInt-call', dst: 'ECMASCRIPT_BUILTIN:parseInt', type: 'CALLS' });
        await backend.addEdge({ src: 'setTimeout-call', dst: 'WEB_API:setTimeout', type: 'CALLS' });

        await backend.flush();

        // Run validator directly
        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        // Should have no warnings
        assert.strictEqual(result.errors?.length ?? 0, 0, 'Built-in calls should not be flagged');

        // Summary:
        // - parseInt and setTimeout have CALLS edges to typed nodes → resolvedExternal
        // - require has no CALLS edge → resolvedBuiltin (REQUIRE_BUILTINS fallback)
        const summary = result.metadata?.summary;
        assert.strictEqual(summary.resolvedExternal, 2,
          'parseInt and setTimeout should count as resolvedExternal (CALLS to typed nodes)');
        assert.strictEqual(summary.resolvedBuiltin, 1,
          'require should count as resolvedBuiltin (REQUIRE_BUILTINS fallback)');
        assert.strictEqual(summary.unresolvedCalls, 0, 'Should have no unresolved calls');
      } finally {
        await backend.close();
      }
    });

    it('should NOT flag external package calls with CALLS edges', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          { id: 'ext-module', type: 'EXTERNAL_MODULE', name: 'lodash', file: '' },
          { id: 'map-call', type: 'CALL', name: 'map', file: 'app.js' }
        ]);

        await backend.addEdge({
          src: 'map-call',
          dst: 'ext-module',
          type: 'CALLS'
        });

        await backend.flush();

        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        assert.strictEqual(result.errors?.length ?? 0, 0, 'External calls should not be flagged');

        const summary = result.metadata?.summary;
        assert.strictEqual(summary.resolvedExternal, 1, 'Should count 1 external call');

        console.log('External package calls correctly recognized');
      } finally {
        await backend.close();
      }
    });

    it('should flag truly unresolved calls as warnings (not errors)', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          { id: 'unknown-call', type: 'CALL', name: 'unknownFunction', file: 'app.js', line: 42 }
        ]);

        await backend.flush();

        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        // Should have exactly 1 warning
        assert.strictEqual(result.errors?.length ?? 0, 1, 'Should report 1 warning');

        const warning = result.errors[0];
        assert.strictEqual(warning.severity, 'warning', 'Should be a warning, not error');
        assert.strictEqual(warning.code, 'WARN_UNRESOLVED_CALL');
        assert.ok(warning.message.includes('unknownFunction'), 'Message should include function name');

        const summary = result.metadata?.summary;
        assert.strictEqual(summary.unresolvedCalls, 1, 'Should count 1 unresolved call');
        assert.strictEqual(summary.warnings, 1, 'Should show 1 warning');

        console.log('Unresolved calls correctly reported as warnings');
      } finally {
        await backend.close();
      }
    });

    it('should correctly categorize mixed resolution types in summary (REG-583)', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        await backend.addNodes([
          // Internal resolved
          { id: 'fn-def', type: 'FUNCTION', name: 'helper', file: 'app.js' },
          { id: 'internal-call', type: 'CALL', name: 'helper', file: 'app.js' },

          // External resolved (npm package)
          { id: 'lodash-module', type: 'EXTERNAL_MODULE', name: 'lodash', file: '' },
          { id: 'external-call', type: 'CALL', name: 'map', file: 'app.js' },

          // REG-583: parseInt now has CALLS edge to ECMASCRIPT_BUILTIN:parseInt → resolvedExternal
          { id: 'ECMASCRIPT_BUILTIN:parseInt', type: 'ECMASCRIPT_BUILTIN', name: 'parseInt', file: '' },
          { id: 'builtin-call', type: 'CALL', name: 'parseInt', file: 'app.js' },

          // Method call
          { id: 'method-call', type: 'CALL', name: 'arr.filter', file: 'app.js', object: 'arr', method: 'filter' },

          // Unresolved
          { id: 'unresolved-call', type: 'CALL', name: 'unknownFunc', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'internal-call', dst: 'fn-def', type: 'CALLS' });
        await backend.addEdge({ src: 'external-call', dst: 'lodash-module', type: 'CALLS' });
        await backend.addEdge({ src: 'builtin-call', dst: 'ECMASCRIPT_BUILTIN:parseInt', type: 'CALLS' });
        await backend.flush();

        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        const summary = result.metadata?.summary;
        assert.strictEqual(summary.totalCalls, 5, 'Should count 5 total calls');
        assert.strictEqual(summary.resolvedInternal, 1, 'Should count 1 internal');
        // REG-583: Both lodash and parseInt have CALLS edges to typed nodes → both are resolvedExternal
        assert.strictEqual(summary.resolvedExternal, 2,
          'Should count 2 external (lodash + ECMASCRIPT_BUILTIN:parseInt)');
        assert.strictEqual(summary.resolvedBuiltin, 0,
          'parseInt now has CALLS edge → no longer counted as builtin fallback');
        assert.strictEqual(summary.methodCalls, 1, 'Should count 1 method call');
        assert.strictEqual(summary.unresolvedCalls, 1, 'Should count 1 unresolved');
      } finally {
        await backend.close();
      }
    });
  });

  // ==========================================================================
  // REG-583: Runtime-typed node recognition
  // ==========================================================================

  describe('REG-583: Runtime-typed node recognition', () => {
    it('should count CALLS to ECMASCRIPT_BUILTIN as resolvedExternal', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // Use a bare function call (no object attribute) so the validator doesn't classify as 'method'
        await backend.addNodes([
          { id: 'ECMASCRIPT_BUILTIN:parseInt', type: 'ECMASCRIPT_BUILTIN', name: 'parseInt', file: '' },
          { id: 'parseint-call', type: 'CALL', name: 'parseInt', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'parseint-call', dst: 'ECMASCRIPT_BUILTIN:parseInt', type: 'CALLS' });
        await backend.flush();

        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        assert.strictEqual(result.errors?.length ?? 0, 0,
          'ECMASCRIPT_BUILTIN CALLS should not be flagged');

        const summary = result.metadata?.summary;
        assert.strictEqual(summary.resolvedExternal, 1,
          'CALLS to ECMASCRIPT_BUILTIN should count as resolvedExternal');
      } finally {
        await backend.close();
      }
    });

    it('should count CALLS to WEB_API as resolvedExternal', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // Bare function call: setTimeout()
        await backend.addNodes([
          { id: 'WEB_API:setTimeout', type: 'WEB_API', name: 'setTimeout', file: '' },
          { id: 'settimeout-call', type: 'CALL', name: 'setTimeout', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'settimeout-call', dst: 'WEB_API:setTimeout', type: 'CALLS' });
        await backend.flush();

        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        assert.strictEqual(result.errors?.length ?? 0, 0,
          'WEB_API CALLS should not be flagged');

        const summary = result.metadata?.summary;
        assert.strictEqual(summary.resolvedExternal, 1,
          'CALLS to WEB_API should count as resolvedExternal');
      } finally {
        await backend.close();
      }
    });

    it('should count CALLS to BROWSER_API as resolvedExternal', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // Bare function call: requestAnimationFrame()
        await backend.addNodes([
          { id: 'BROWSER_API:requestAnimationFrame', type: 'BROWSER_API', name: 'requestAnimationFrame', file: '' },
          { id: 'raf-call', type: 'CALL', name: 'requestAnimationFrame', file: 'ui.js' }
        ]);

        await backend.addEdge({ src: 'raf-call', dst: 'BROWSER_API:requestAnimationFrame', type: 'CALLS' });
        await backend.flush();

        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        assert.strictEqual(result.errors?.length ?? 0, 0,
          'BROWSER_API CALLS should not be flagged');

        const summary = result.metadata?.summary;
        assert.strictEqual(summary.resolvedExternal, 1,
          'CALLS to BROWSER_API should count as resolvedExternal');
      } finally {
        await backend.close();
      }
    });

    it('should count CALLS to NODEJS_STDLIB as resolvedExternal', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // Bare function call: setImmediate()
        await backend.addNodes([
          { id: 'NODEJS_STDLIB:setImmediate', type: 'NODEJS_STDLIB', name: 'setImmediate', file: '' },
          { id: 'setimmediate-call', type: 'CALL', name: 'setImmediate', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'setimmediate-call', dst: 'NODEJS_STDLIB:setImmediate', type: 'CALLS' });
        await backend.flush();

        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        assert.strictEqual(result.errors?.length ?? 0, 0,
          'NODEJS_STDLIB CALLS should not be flagged');

        const summary = result.metadata?.summary;
        assert.strictEqual(summary.resolvedExternal, 1,
          'CALLS to NODEJS_STDLIB should count as resolvedExternal');
      } finally {
        await backend.close();
      }
    });

    it('should count CALLS to UNKNOWN_CALL_TARGET as resolvedExternal', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // Bare function call pattern — UNKNOWN_CALL_TARGET is typically from method calls,
        // but the validator should recognize it when present as a CALLS edge destination
        await backend.addNodes([
          { id: 'UNKNOWN_CALL_TARGET:someFunc', type: 'UNKNOWN_CALL_TARGET', name: 'someFunc', file: '' },
          { id: 'somefunc-call', type: 'CALL', name: 'someFunc', file: 'handler.js' }
        ]);

        await backend.addEdge({ src: 'somefunc-call', dst: 'UNKNOWN_CALL_TARGET:someFunc', type: 'CALLS' });
        await backend.flush();

        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        assert.strictEqual(result.errors?.length ?? 0, 0,
          'UNKNOWN_CALL_TARGET CALLS should not be flagged');

        const summary = result.metadata?.summary;
        assert.strictEqual(summary.resolvedExternal, 1,
          'CALLS to UNKNOWN_CALL_TARGET should count as resolvedExternal');
      } finally {
        await backend.close();
      }
    });

    it('should count require with no CALLS edge as resolvedBuiltin (REQUIRE_BUILTINS fallback)', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // require() has no CALLS edge — it is modeled via IMPORT/REQUIRES_MODULE nodes.
        // The validator uses REQUIRE_BUILTINS fallback to count it as resolvedBuiltin.
        await backend.addNode({
          id: 'require-call',
          type: 'CALL',
          name: 'require',
          file: 'app.js'
        });

        await backend.flush();

        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        assert.strictEqual(result.errors?.length ?? 0, 0,
          'require() should not be flagged');

        const summary = result.metadata?.summary;
        assert.strictEqual(summary.resolvedBuiltin, 1,
          'require() with no CALLS edge should count as resolvedBuiltin');
        assert.strictEqual(summary.unresolvedCalls, 0,
          'require() should not count as unresolved');
      } finally {
        await backend.close();
      }
    });

    it('should count parseInt WITH CALLS edge as resolvedExternal (not builtin fallback)', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `// Empty`
      });

      try {
        // REG-583: parseInt now has a CALLS edge to ECMASCRIPT_BUILTIN:parseInt.
        // It should be counted as resolvedExternal (via CALLS edge lookup),
        // NOT as resolvedBuiltin (via the old JS_GLOBAL_FUNCTIONS fallback).
        await backend.addNodes([
          { id: 'ECMASCRIPT_BUILTIN:parseInt', type: 'ECMASCRIPT_BUILTIN', name: 'parseInt', file: '' },
          { id: 'parseInt-call', type: 'CALL', name: 'parseInt', file: 'app.js' }
        ]);

        await backend.addEdge({ src: 'parseInt-call', dst: 'ECMASCRIPT_BUILTIN:parseInt', type: 'CALLS' });
        await backend.flush();

        const { CallResolverValidator } = await import('@grafema/core');
        const validator = new CallResolverValidator();
        const result = await validator.execute({
          graph: backend,
          config: {},
          rootDir: testDir
        });

        assert.strictEqual(result.errors?.length ?? 0, 0,
          'parseInt with CALLS edge should not be flagged');

        const summary = result.metadata?.summary;
        assert.strictEqual(summary.resolvedExternal, 1,
          'parseInt with CALLS edge should count as resolvedExternal');
        assert.strictEqual(summary.resolvedBuiltin, 0,
          'parseInt should NOT use builtin fallback when CALLS edge exists');
      } finally {
        await backend.close();
      }
    });
  });
});

/**
 * FunctionNode Semantic ID Tests
 *
 * Tests for FunctionNode migration to use ScopeContext + Location
 * for stable semantic IDs instead of line-based IDs.
 *
 * Format: {file}->{scope_path}->FUNCTION->{name}
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { FunctionNode, ScopeTracker, computeSemanticId } from '@grafema/core';

describe('FunctionNode with Semantic ID', () => {
  describe('createWithContext() - new semantic ID API', () => {
    it('should create top-level function with semantic ID', () => {
      const tracker = new ScopeTracker('src/app.js');
      const context = tracker.getContext();
      const location = { line: 5, column: 2 };

      const node = FunctionNode.createWithContext(
        'processData',
        context,
        location
      );

      // Semantic ID: no line number
      assert.strictEqual(node.id, 'src/app.js->global->FUNCTION->processData');

      // Location stored as fields
      assert.strictEqual(node.file, 'src/app.js');
      assert.strictEqual(node.line, 5);
      assert.strictEqual(node.column, 2);
      assert.strictEqual(node.name, 'processData');
      assert.strictEqual(node.type, 'FUNCTION');
    });

    it('should create function inside class scope', () => {
      const tracker = new ScopeTracker('src/services/UserService.js');
      tracker.enterScope('UserService', 'CLASS');
      const context = tracker.getContext();
      const location = { line: 10, column: 4 };

      const node = FunctionNode.createWithContext(
        'login',
        context,
        location,
        { isClassMethod: true, className: 'UserService' }
      );

      assert.strictEqual(node.id, 'src/services/UserService.js->UserService->FUNCTION->login');
      assert.strictEqual(node.line, 10);
      assert.strictEqual(node.isClassMethod, true);
      assert.strictEqual(node.className, 'UserService');
    });

    it('should create nested function inside function scope', () => {
      const tracker = new ScopeTracker('src/utils.js');
      tracker.enterScope('outer', 'FUNCTION');
      const context = tracker.getContext();
      const location = { line: 15, column: 6 };

      const node = FunctionNode.createWithContext(
        'inner',
        context,
        location
      );

      assert.strictEqual(node.id, 'src/utils.js->outer->FUNCTION->inner');
      assert.strictEqual(node.parentScopeId, 'src/utils.js->global->FUNCTION->outer');
    });

    it('should create function inside control flow scope', () => {
      const tracker = new ScopeTracker('src/handlers.js');
      tracker.enterScope('handleRequest', 'FUNCTION');
      tracker.enterCountedScope('if');
      const context = tracker.getContext();
      const location = { line: 20, column: 8 };

      const node = FunctionNode.createWithContext(
        'callback',
        context,
        location
      );

      assert.strictEqual(node.id, 'src/handlers.js->handleRequest->if#0->FUNCTION->callback');
    });

    it('should handle async functions', () => {
      const tracker = new ScopeTracker('src/api.js');
      const context = tracker.getContext();
      const location = { line: 1, column: 0 };

      const node = FunctionNode.createWithContext(
        'fetchData',
        context,
        location,
        { async: true }
      );

      assert.strictEqual(node.id, 'src/api.js->global->FUNCTION->fetchData');
      assert.strictEqual(node.async, true);
    });

    it('should handle generator functions', () => {
      const tracker = new ScopeTracker('src/generators.js');
      const context = tracker.getContext();
      const location = { line: 1, column: 0 };

      const node = FunctionNode.createWithContext(
        'range',
        context,
        location,
        { generator: true }
      );

      assert.strictEqual(node.id, 'src/generators.js->global->FUNCTION->range');
      assert.strictEqual(node.generator, true);
    });

    it('should handle exported functions', () => {
      const tracker = new ScopeTracker('src/exports.js');
      const context = tracker.getContext();
      const location = { line: 1, column: 0 };

      const node = FunctionNode.createWithContext(
        'publicApi',
        context,
        location,
        { exported: true }
      );

      assert.strictEqual(node.id, 'src/exports.js->global->FUNCTION->publicApi');
      assert.strictEqual(node.exported, true);
    });

    it('should handle arrow functions', () => {
      const tracker = new ScopeTracker('src/arrows.js');
      const context = tracker.getContext();
      const location = { line: 1, column: 0 };

      const node = FunctionNode.createWithContext(
        'arrowFn',
        context,
        location,
        { arrowFunction: true }
      );

      assert.strictEqual(node.id, 'src/arrows.js->global->FUNCTION->arrowFn');
      assert.strictEqual(node.arrowFunction, true);
    });

    it('should store function parameters', () => {
      const tracker = new ScopeTracker('src/params.js');
      const context = tracker.getContext();
      const location = { line: 1, column: 0 };

      const node = FunctionNode.createWithContext(
        'withParams',
        context,
        location,
        { params: ['a', 'b', 'c'] }
      );

      assert.strictEqual(node.id, 'src/params.js->global->FUNCTION->withParams');
      assert.deepStrictEqual(node.params, ['a', 'b', 'c']);
    });
  });

  describe('Semantic ID stability (same function, different lines)', () => {
    it('should produce same ID when function moves to different line', () => {
      const tracker = new ScopeTracker('src/app.js');
      const context = tracker.getContext();

      // Function at line 5
      const node1 = FunctionNode.createWithContext(
        'myFunction',
        context,
        { line: 5, column: 0 }
      );

      // Same function moved to line 10 (added empty lines)
      const node2 = FunctionNode.createWithContext(
        'myFunction',
        context,
        { line: 10, column: 0 }
      );

      // IDs should be IDENTICAL - semantic identity
      assert.strictEqual(node1.id, node2.id);
      assert.strictEqual(node1.id, 'src/app.js->global->FUNCTION->myFunction');

      // But line fields are different
      assert.strictEqual(node1.line, 5);
      assert.strictEqual(node2.line, 10);
    });

    it('should produce different IDs for different functions in same file', () => {
      const tracker = new ScopeTracker('src/app.js');
      const context = tracker.getContext();

      const fn1 = FunctionNode.createWithContext(
        'function1',
        context,
        { line: 5, column: 0 }
      );

      const fn2 = FunctionNode.createWithContext(
        'function2',
        context,
        { line: 10, column: 0 }
      );

      assert.notStrictEqual(fn1.id, fn2.id);
      assert.strictEqual(fn1.id, 'src/app.js->global->FUNCTION->function1');
      assert.strictEqual(fn2.id, 'src/app.js->global->FUNCTION->function2');
    });

    it('should produce different IDs for same-named functions in different files', () => {
      const tracker1 = new ScopeTracker('src/file1.js');
      const tracker2 = new ScopeTracker('src/file2.js');

      const fn1 = FunctionNode.createWithContext(
        'handler',
        tracker1.getContext(),
        { line: 1, column: 0 }
      );

      const fn2 = FunctionNode.createWithContext(
        'handler',
        tracker2.getContext(),
        { line: 1, column: 0 }
      );

      assert.notStrictEqual(fn1.id, fn2.id);
      assert.strictEqual(fn1.id, 'src/file1.js->global->FUNCTION->handler');
      assert.strictEqual(fn2.id, 'src/file2.js->global->FUNCTION->handler');
    });

    it('should produce different IDs for same-named functions in different scopes', () => {
      const tracker = new ScopeTracker('src/app.js');

      // Function in global scope
      const global = FunctionNode.createWithContext(
        'helper',
        tracker.getContext(),
        { line: 1, column: 0 }
      );

      // Function inside class
      tracker.enterScope('MyClass', 'CLASS');
      const inClass = FunctionNode.createWithContext(
        'helper',
        tracker.getContext(),
        { line: 10, column: 0 }
      );

      assert.notStrictEqual(global.id, inClass.id);
      assert.strictEqual(global.id, 'src/app.js->global->FUNCTION->helper');
      assert.strictEqual(inClass.id, 'src/app.js->MyClass->FUNCTION->helper');
    });
  });

  describe('Anonymous functions with sibling index', () => {
    it('should handle anonymous function with sibling index', () => {
      const tracker = new ScopeTracker('src/app.js');
      const context = tracker.getContext();

      // First anonymous function
      const siblingIndex = tracker.getSiblingIndex('anonymous');
      const name = `anonymous[${siblingIndex}]`;

      const node = FunctionNode.createWithContext(
        name,
        context,
        { line: 5, column: 10 }
      );

      assert.strictEqual(node.id, 'src/app.js->global->FUNCTION->anonymous[0]');
      assert.strictEqual(node.name, 'anonymous[0]');
    });

    it('should increment sibling index for multiple anonymous functions', () => {
      const tracker = new ScopeTracker('src/app.js');
      const context = tracker.getContext();

      // First anonymous
      const name1 = `anonymous[${tracker.getSiblingIndex('anonymous')}]`;
      const node1 = FunctionNode.createWithContext(name1, context, { line: 5, column: 0 });

      // Second anonymous
      const name2 = `anonymous[${tracker.getSiblingIndex('anonymous')}]`;
      const node2 = FunctionNode.createWithContext(name2, context, { line: 8, column: 0 });

      // Third anonymous
      const name3 = `anonymous[${tracker.getSiblingIndex('anonymous')}]`;
      const node3 = FunctionNode.createWithContext(name3, context, { line: 11, column: 0 });

      assert.strictEqual(node1.id, 'src/app.js->global->FUNCTION->anonymous[0]');
      assert.strictEqual(node2.id, 'src/app.js->global->FUNCTION->anonymous[1]');
      assert.strictEqual(node3.id, 'src/app.js->global->FUNCTION->anonymous[2]');
    });

    it('should reset sibling index in nested scope', () => {
      const tracker = new ScopeTracker('src/app.js');

      // Global anonymous
      const globalName = `anonymous[${tracker.getSiblingIndex('anonymous')}]`;
      const globalFn = FunctionNode.createWithContext(
        globalName,
        tracker.getContext(),
        { line: 1, column: 0 }
      );

      // Enter named function
      tracker.enterScope('outer', 'FUNCTION');

      // Nested anonymous - resets to 0 in this scope
      const nestedName = `anonymous[${tracker.getSiblingIndex('anonymous')}]`;
      const nestedFn = FunctionNode.createWithContext(
        nestedName,
        tracker.getContext(),
        { line: 5, column: 0 }
      );

      assert.strictEqual(globalFn.id, 'src/app.js->global->FUNCTION->anonymous[0]');
      assert.strictEqual(nestedFn.id, 'src/app.js->outer->FUNCTION->anonymous[0]');
    });
  });

  describe('parentScopeId computation', () => {
    it('should set parentScopeId for nested function', () => {
      const tracker = new ScopeTracker('src/app.js');

      // Create outer function
      tracker.enterScope('outer', 'FUNCTION');
      const context = tracker.getContext();

      const inner = FunctionNode.createWithContext(
        'inner',
        context,
        { line: 10, column: 4 }
      );

      // parentScopeId should point to outer function's semantic ID
      assert.strictEqual(inner.parentScopeId, 'src/app.js->global->FUNCTION->outer');
    });

    it('should not set parentScopeId for global function', () => {
      const tracker = new ScopeTracker('src/app.js');

      const fn = FunctionNode.createWithContext(
        'globalFn',
        tracker.getContext(),
        { line: 1, column: 0 }
      );

      // Top-level function has no parent scope
      assert.strictEqual(fn.parentScopeId, undefined);
    });

    it('should compute correct parentScopeId in deeply nested structure', () => {
      const tracker = new ScopeTracker('src/complex.js');

      tracker.enterScope('Class', 'CLASS');
      tracker.enterScope('method', 'METHOD');
      tracker.enterCountedScope('if');

      const callback = FunctionNode.createWithContext(
        'callback',
        tracker.getContext(),
        { line: 25, column: 8 }
      );

      // Parent is the if#0 scope - but we track function scopes
      // For functions, parentScopeId refers to the containing function/method
      // The exact parent depends on implementation - could be method or the control flow scope
      assert.ok(callback.parentScopeId);
      assert.ok(callback.parentScopeId.includes('method') || callback.parentScopeId.includes('if#0'));
    });
  });

  describe('stableId field', () => {
    it('should set stableId equal to id', () => {
      const tracker = new ScopeTracker('src/app.js');

      const node = FunctionNode.createWithContext(
        'myFn',
        tracker.getContext(),
        { line: 1, column: 0 }
      );

      assert.strictEqual(node.stableId, node.id);
    });
  });

  describe('validation', () => {
    it('should pass validation for valid function node', () => {
      const tracker = new ScopeTracker('src/app.js');

      const node = FunctionNode.createWithContext(
        'validFn',
        tracker.getContext(),
        { line: 1, column: 0 }
      );

      const errors = FunctionNode.validate(node);
      assert.strictEqual(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('should require name', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        FunctionNode.createWithContext(
          '',
          tracker.getContext(),
          { line: 1, column: 0 }
        );
      }, /name is required/);
    });

    it('should require file in context', () => {
      const context = { file: '', scopePath: [] };

      assert.throws(() => {
        FunctionNode.createWithContext(
          'fn',
          context,
          { line: 1, column: 0 }
        );
      }, /file is required/);
    });

    it('should require line in location', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        FunctionNode.createWithContext(
          'fn',
          tracker.getContext(),
          { column: 0 }
        );
      }, /line is required/);
    });

    it('should require column in location', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        FunctionNode.createWithContext(
          'fn',
          tracker.getContext(),
          { line: 1 }
        );
      }, /column is required/);
    });
  });

  describe('backward compatibility with create()', () => {
    it('should still support legacy create() method', () => {
      // Legacy API still works for backward compatibility
      const node = FunctionNode.create(
        'legacyFn',
        'src/app.js',
        5,
        10,
        { async: true }
      );

      // Legacy method still uses old ID format
      assert.ok(node.id.includes('legacyFn'));
      assert.strictEqual(node.name, 'legacyFn');
      assert.strictEqual(node.file, 'src/app.js');
      assert.strictEqual(node.line, 5);
      assert.strictEqual(node.column, 10);
      assert.strictEqual(node.async, true);
    });
  });

  describe('edge cases', () => {
    it('should handle function names with special characters', () => {
      const tracker = new ScopeTracker('src/svelte.js');

      const node = FunctionNode.createWithContext(
        '$effect',
        tracker.getContext(),
        { line: 1, column: 0 }
      );

      assert.strictEqual(node.id, 'src/svelte.js->global->FUNCTION->$effect');
      assert.strictEqual(node.name, '$effect');
    });

    it('should handle deeply nested scopes', () => {
      const tracker = new ScopeTracker('src/complex.js');

      tracker.enterScope('Class1', 'CLASS');
      tracker.enterScope('method1', 'METHOD');
      tracker.enterCountedScope('if');
      tracker.enterCountedScope('try');
      tracker.enterCountedScope('for');

      const node = FunctionNode.createWithContext(
        'deepFn',
        tracker.getContext(),
        { line: 50, column: 16 }
      );

      assert.strictEqual(
        node.id,
        'src/complex.js->Class1->method1->if#0->try#0->for#0->FUNCTION->deepFn'
      );
    });

    it('should handle file paths with special characters', () => {
      const tracker = new ScopeTracker('src/handlers/user-auth.service.ts');

      const node = FunctionNode.createWithContext(
        'authenticate',
        tracker.getContext(),
        { line: 1, column: 0 }
      );

      assert.strictEqual(
        node.id,
        'src/handlers/user-auth.service.ts->global->FUNCTION->authenticate'
      );
    });
  });
});

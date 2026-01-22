/**
 * CallSiteNode Semantic ID Tests
 *
 * Tests for CallSiteNode migration to use ScopeContext + Location
 * for stable semantic IDs with discriminators for multiple calls.
 *
 * Format: {file}->{scope_path}->CALL->{calleeName}#N
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { CallSiteNode, ScopeTracker, computeSemanticId } from '@grafema/core';

describe('CallSiteNode with Semantic ID', () => {
  describe('createWithContext() - new semantic ID API', () => {
    it('should create call site with semantic ID and discriminator', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('processData', 'FUNCTION');
      const context = tracker.getContext();
      const location = { line: 10, column: 4 };
      const discriminator = tracker.getItemCounter('CALL:console.log');

      const node = CallSiteNode.createWithContext(
        'console.log',
        context,
        location,
        { discriminator }
      );

      // Semantic ID with discriminator: no line number
      assert.strictEqual(node.id, 'src/app.js->processData->CALL->console.log#0');
      assert.strictEqual(node.file, 'src/app.js');
      assert.strictEqual(node.line, 10);
      assert.strictEqual(node.column, 4);
      assert.strictEqual(node.name, 'console.log');
      assert.strictEqual(node.type, 'CALL_SITE');
    });

    it('should increment discriminator for multiple calls to same function', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('test', 'FUNCTION');
      const context = tracker.getContext();

      // First call
      const call1 = CallSiteNode.createWithContext(
        'console.log',
        context,
        { line: 5, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:console.log') }
      );

      // Second call
      const call2 = CallSiteNode.createWithContext(
        'console.log',
        context,
        { line: 6, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:console.log') }
      );

      // Third call
      const call3 = CallSiteNode.createWithContext(
        'console.log',
        context,
        { line: 7, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:console.log') }
      );

      assert.strictEqual(call1.id, 'src/app.js->test->CALL->console.log#0');
      assert.strictEqual(call2.id, 'src/app.js->test->CALL->console.log#1');
      assert.strictEqual(call3.id, 'src/app.js->test->CALL->console.log#2');
    });

    it('should track different function calls separately', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('handler', 'FUNCTION');
      const context = tracker.getContext();

      const log1 = CallSiteNode.createWithContext(
        'console.log',
        context,
        { line: 5, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:console.log') }
      );

      const error1 = CallSiteNode.createWithContext(
        'console.error',
        context,
        { line: 6, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:console.error') }
      );

      const log2 = CallSiteNode.createWithContext(
        'console.log',
        context,
        { line: 7, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:console.log') }
      );

      assert.strictEqual(log1.id, 'src/app.js->handler->CALL->console.log#0');
      assert.strictEqual(error1.id, 'src/app.js->handler->CALL->console.error#0');
      assert.strictEqual(log2.id, 'src/app.js->handler->CALL->console.log#1');
    });

    it('should create call site in global scope', () => {
      const tracker = new ScopeTracker('src/init.js');
      const context = tracker.getContext();
      const discriminator = tracker.getItemCounter('CALL:initialize');

      const node = CallSiteNode.createWithContext(
        'initialize',
        context,
        { line: 1, column: 0 },
        { discriminator }
      );

      assert.strictEqual(node.id, 'src/init.js->global->CALL->initialize#0');
    });

    it('should create call site inside control flow scope', () => {
      const tracker = new ScopeTracker('src/handlers.js');
      tracker.enterScope('processRequest', 'FUNCTION');
      tracker.enterCountedScope('if');
      const context = tracker.getContext();
      const discriminator = tracker.getItemCounter('CALL:handleSuccess');

      const node = CallSiteNode.createWithContext(
        'handleSuccess',
        context,
        { line: 15, column: 8 },
        { discriminator }
      );

      assert.strictEqual(node.id, 'src/handlers.js->processRequest->if#0->CALL->handleSuccess#0');
    });

    it('should reset discriminator in different scopes', () => {
      const tracker = new ScopeTracker('src/app.js');

      // First function
      tracker.enterScope('func1', 'FUNCTION');
      const context1 = tracker.getContext();
      const call1 = CallSiteNode.createWithContext(
        'log',
        context1,
        { line: 5, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:log') }
      );
      tracker.exitScope();

      // Second function - counter resets
      tracker.enterScope('func2', 'FUNCTION');
      const context2 = tracker.getContext();
      const call2 = CallSiteNode.createWithContext(
        'log',
        context2,
        { line: 15, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:log') }
      );

      assert.strictEqual(call1.id, 'src/app.js->func1->CALL->log#0');
      assert.strictEqual(call2.id, 'src/app.js->func2->CALL->log#0');
    });
  });

  describe('Semantic ID stability', () => {
    it('should produce same ID when call moves to different line', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('myFunc', 'FUNCTION');
      const context = tracker.getContext();

      // Call at line 5
      const node1 = CallSiteNode.createWithContext(
        'helper',
        context,
        { line: 5, column: 4 },
        { discriminator: 0 }
      );

      // Same call moved to line 10 (added empty lines)
      const node2 = CallSiteNode.createWithContext(
        'helper',
        context,
        { line: 10, column: 4 },
        { discriminator: 0 }
      );

      // IDs should be IDENTICAL
      assert.strictEqual(node1.id, node2.id);
      assert.strictEqual(node1.id, 'src/app.js->myFunc->CALL->helper#0');

      // But line fields are different
      assert.strictEqual(node1.line, 5);
      assert.strictEqual(node2.line, 10);
    });

    it('should produce different IDs for different discriminators', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('test', 'FUNCTION');
      const context = tracker.getContext();

      const call1 = CallSiteNode.createWithContext(
        'log',
        context,
        { line: 5, column: 4 },
        { discriminator: 0 }
      );

      const call2 = CallSiteNode.createWithContext(
        'log',
        context,
        { line: 5, column: 4 },
        { discriminator: 1 }
      );

      assert.notStrictEqual(call1.id, call2.id);
      assert.strictEqual(call1.id, 'src/app.js->test->CALL->log#0');
      assert.strictEqual(call2.id, 'src/app.js->test->CALL->log#1');
    });
  });

  describe('parentScopeId', () => {
    it('should set parentScopeId when provided', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('myFunc', 'FUNCTION');
      const context = tracker.getContext();
      const parentScopeId = computeSemanticId('FUNCTION', 'myFunc', { file: 'src/app.js', scopePath: [] });

      const node = CallSiteNode.createWithContext(
        'helper',
        context,
        { line: 10, column: 4 },
        { discriminator: 0, parentScopeId }
      );

      assert.strictEqual(node.parentScopeId, 'src/app.js->global->FUNCTION->myFunc');
    });

    it('should not require parentScopeId', () => {
      const tracker = new ScopeTracker('src/app.js');
      const context = tracker.getContext();

      const node = CallSiteNode.createWithContext(
        'init',
        context,
        { line: 1, column: 0 },
        { discriminator: 0 }
      );

      assert.strictEqual(node.parentScopeId, undefined);
    });
  });

  describe('validation', () => {
    it('should require targetName', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        CallSiteNode.createWithContext(
          '',
          tracker.getContext(),
          { line: 1, column: 0 },
          { discriminator: 0 }
        );
      }, /targetName is required/);
    });

    it('should require file in context', () => {
      const context = { file: '', scopePath: [] };

      assert.throws(() => {
        CallSiteNode.createWithContext(
          'fn',
          context,
          { line: 1, column: 0 },
          { discriminator: 0 }
        );
      }, /file is required/);
    });

    it('should require line in location', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        CallSiteNode.createWithContext(
          'fn',
          tracker.getContext(),
          { column: 0 },
          { discriminator: 0 }
        );
      }, /line is required/);
    });

    it('should require discriminator', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        CallSiteNode.createWithContext(
          'fn',
          tracker.getContext(),
          { line: 1, column: 0 },
          {}
        );
      }, /discriminator is required/);
    });
  });

  describe('backward compatibility with create()', () => {
    it('should still support legacy create() method', () => {
      const node = CallSiteNode.create(
        'legacyCall',
        'src/app.js',
        5,
        10,
        { counter: 0 }
      );

      assert.ok(node.id.includes('legacyCall'));
      assert.strictEqual(node.name, 'legacyCall');
      assert.strictEqual(node.file, 'src/app.js');
      assert.strictEqual(node.line, 5);
      assert.strictEqual(node.column, 10);
    });
  });

  describe('edge cases', () => {
    it('should handle method calls with dot notation', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('handler', 'FUNCTION');
      const context = tracker.getContext();

      const node = CallSiteNode.createWithContext(
        'db.query',
        context,
        { line: 10, column: 4 },
        { discriminator: 0 }
      );

      assert.strictEqual(node.id, 'src/app.js->handler->CALL->db.query#0');
      assert.strictEqual(node.name, 'db.query');
    });

    it('should handle chained method calls', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('process', 'FUNCTION');
      const context = tracker.getContext();

      const node = CallSiteNode.createWithContext(
        'arr.map.filter',
        context,
        { line: 5, column: 4 },
        { discriminator: 0 }
      );

      assert.strictEqual(node.id, 'src/app.js->process->CALL->arr.map.filter#0');
    });

    it('should handle deeply nested scopes', () => {
      const tracker = new ScopeTracker('src/complex.js');
      tracker.enterScope('Class', 'CLASS');
      tracker.enterScope('method', 'METHOD');
      tracker.enterCountedScope('if');
      tracker.enterCountedScope('try');
      const context = tracker.getContext();

      const node = CallSiteNode.createWithContext(
        'risky',
        context,
        { line: 50, column: 12 },
        { discriminator: 0 }
      );

      assert.strictEqual(
        node.id,
        'src/complex.js->Class->method->if#0->try#0->CALL->risky#0'
      );
    });

    it('should handle special characters in callee name', () => {
      const tracker = new ScopeTracker('src/svelte.js');
      const context = tracker.getContext();

      const node = CallSiteNode.createWithContext(
        '$effect',
        context,
        { line: 1, column: 0 },
        { discriminator: 0 }
      );

      assert.strictEqual(node.id, 'src/svelte.js->global->CALL->$effect#0');
    });
  });
});

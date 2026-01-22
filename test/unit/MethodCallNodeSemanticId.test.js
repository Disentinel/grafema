/**
 * MethodCallNode Semantic ID Tests
 *
 * Tests for MethodCallNode migration to use ScopeContext + Location
 * for stable semantic IDs with discriminators for multiple calls.
 *
 * Format: {file}->{scope_path}->CALL->{object.method}#N
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { MethodCallNode, ScopeTracker } from '@grafema/core';

describe('MethodCallNode with Semantic ID', () => {
  describe('createWithContext() - new semantic ID API', () => {
    it('should create method call with semantic ID', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('handler', 'FUNCTION');
      const context = tracker.getContext();
      const location = { line: 10, column: 4 };
      const discriminator = tracker.getItemCounter('CALL:db.query');

      const node = MethodCallNode.createWithContext(
        'db',
        'query',
        context,
        location,
        { discriminator }
      );

      assert.strictEqual(node.id, 'src/app.js->handler->CALL->db.query#0');
      assert.strictEqual(node.file, 'src/app.js');
      assert.strictEqual(node.line, 10);
      assert.strictEqual(node.column, 4);
      assert.strictEqual(node.name, 'db.query');
      assert.strictEqual(node.object, 'db');
      assert.strictEqual(node.method, 'query');
      assert.strictEqual(node.type, 'METHOD_CALL');
    });

    it('should handle method call without object (bare function)', () => {
      const tracker = new ScopeTracker('src/app.js');
      const context = tracker.getContext();
      const discriminator = tracker.getItemCounter('CALL:initialize');

      const node = MethodCallNode.createWithContext(
        undefined,
        'initialize',
        context,
        { line: 1, column: 0 },
        { discriminator }
      );

      assert.strictEqual(node.id, 'src/app.js->global->CALL->initialize#0');
      assert.strictEqual(node.name, 'initialize');
      assert.strictEqual(node.object, undefined);
      assert.strictEqual(node.method, 'initialize');
    });

    it('should increment discriminator for multiple calls', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('process', 'FUNCTION');
      const context = tracker.getContext();

      const call1 = MethodCallNode.createWithContext(
        'console',
        'log',
        context,
        { line: 5, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:console.log') }
      );

      const call2 = MethodCallNode.createWithContext(
        'console',
        'log',
        context,
        { line: 6, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:console.log') }
      );

      assert.strictEqual(call1.id, 'src/app.js->process->CALL->console.log#0');
      assert.strictEqual(call2.id, 'src/app.js->process->CALL->console.log#1');
    });

    it('should store args when provided', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('test', 'FUNCTION');
      const context = tracker.getContext();

      const node = MethodCallNode.createWithContext(
        'arr',
        'push',
        context,
        { line: 5, column: 4 },
        { discriminator: 0, args: [1, 2, 3] }
      );

      assert.deepStrictEqual(node.args, [1, 2, 3]);
    });

    it('should create method call in control flow scope', () => {
      const tracker = new ScopeTracker('src/handlers.js');
      tracker.enterScope('handleRequest', 'FUNCTION');
      tracker.enterCountedScope('try');
      const context = tracker.getContext();

      const node = MethodCallNode.createWithContext(
        'db',
        'save',
        context,
        { line: 15, column: 8 },
        { discriminator: 0 }
      );

      assert.strictEqual(node.id, 'src/handlers.js->handleRequest->try#0->CALL->db.save#0');
    });
  });

  describe('Semantic ID stability', () => {
    it('should produce same ID when method call moves', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('myFunc', 'FUNCTION');
      const context = tracker.getContext();

      const node1 = MethodCallNode.createWithContext(
        'service',
        'execute',
        context,
        { line: 5, column: 4 },
        { discriminator: 0 }
      );

      const node2 = MethodCallNode.createWithContext(
        'service',
        'execute',
        context,
        { line: 15, column: 4 },
        { discriminator: 0 }
      );

      assert.strictEqual(node1.id, node2.id);
      assert.strictEqual(node1.line, 5);
      assert.strictEqual(node2.line, 15);
    });

    it('should produce different IDs for different methods on same object', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('handler', 'FUNCTION');
      const context = tracker.getContext();

      const find = MethodCallNode.createWithContext(
        'db',
        'find',
        context,
        { line: 5, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:db.find') }
      );

      const save = MethodCallNode.createWithContext(
        'db',
        'save',
        context,
        { line: 6, column: 4 },
        { discriminator: tracker.getItemCounter('CALL:db.save') }
      );

      assert.notStrictEqual(find.id, save.id);
      assert.strictEqual(find.id, 'src/app.js->handler->CALL->db.find#0');
      assert.strictEqual(save.id, 'src/app.js->handler->CALL->db.save#0');
    });
  });

  describe('validation', () => {
    it('should require methodName', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        MethodCallNode.createWithContext(
          'obj',
          '',
          tracker.getContext(),
          { line: 1, column: 0 },
          { discriminator: 0 }
        );
      }, /methodName is required/);
    });

    it('should require file in context', () => {
      const context = { file: '', scopePath: [] };

      assert.throws(() => {
        MethodCallNode.createWithContext(
          'obj',
          'method',
          context,
          { line: 1, column: 0 },
          { discriminator: 0 }
        );
      }, /file is required/);
    });

    it('should require line in location', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        MethodCallNode.createWithContext(
          'obj',
          'method',
          tracker.getContext(),
          { column: 0 },
          { discriminator: 0 }
        );
      }, /line is required/);
    });

    it('should require discriminator', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        MethodCallNode.createWithContext(
          'obj',
          'method',
          tracker.getContext(),
          { line: 1, column: 0 },
          {}
        );
      }, /discriminator is required/);
    });
  });

  describe('backward compatibility with create()', () => {
    it('should still support legacy create() method', () => {
      const node = MethodCallNode.create(
        'legacyObj',
        'legacyMethod',
        'src/app.js',
        5,
        10,
        { counter: 0 }
      );

      assert.ok(node.id.includes('legacyObj.legacyMethod'));
      assert.strictEqual(node.name, 'legacyObj.legacyMethod');
      assert.strictEqual(node.object, 'legacyObj');
      assert.strictEqual(node.method, 'legacyMethod');
    });
  });

  describe('edge cases', () => {
    it('should handle deeply nested scopes', () => {
      const tracker = new ScopeTracker('src/complex.js');
      tracker.enterScope('Class', 'CLASS');
      tracker.enterScope('method', 'METHOD');
      tracker.enterCountedScope('if');
      tracker.enterCountedScope('for');
      const context = tracker.getContext();

      const node = MethodCallNode.createWithContext(
        'item',
        'process',
        context,
        { line: 50, column: 12 },
        { discriminator: 0 }
      );

      assert.strictEqual(
        node.id,
        'src/complex.js->Class->method->if#0->for#0->CALL->item.process#0'
      );
    });

    it('should handle special characters in object name', () => {
      const tracker = new ScopeTracker('src/svelte.js');
      const context = tracker.getContext();

      const node = MethodCallNode.createWithContext(
        '$store',
        'subscribe',
        context,
        { line: 1, column: 0 },
        { discriminator: 0 }
      );

      assert.strictEqual(node.id, 'src/svelte.js->global->CALL->$store.subscribe#0');
    });
  });
});

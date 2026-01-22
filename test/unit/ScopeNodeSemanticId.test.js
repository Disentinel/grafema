/**
 * ScopeNode Semantic ID Tests
 *
 * Tests for ScopeNode migration to use ScopeContext + Location
 * for stable semantic IDs with discriminators for control flow scopes.
 *
 * Format: {file}->{scope_path}->SCOPE->{scopeType}#N
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ScopeNode, ScopeTracker } from '@grafema/core';

describe('ScopeNode with Semantic ID', () => {
  describe('createWithContext() - new semantic ID API', () => {
    it('should create if scope with semantic ID', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('processData', 'FUNCTION');
      const context = tracker.getContext();
      const location = { line: 10 };
      const discriminator = tracker.getItemCounter('SCOPE:if');

      const node = ScopeNode.createWithContext(
        'if',
        context,
        location,
        { discriminator }
      );

      assert.strictEqual(node.id, 'src/app.js->processData->SCOPE->if#0');
      assert.strictEqual(node.file, 'src/app.js');
      assert.strictEqual(node.line, 10);
      assert.strictEqual(node.scopeType, 'if');
      assert.strictEqual(node.type, 'SCOPE');
    });

    it('should increment discriminator for multiple scopes of same type', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('handler', 'FUNCTION');
      const context = tracker.getContext();

      const if1 = ScopeNode.createWithContext(
        'if',
        context,
        { line: 5 },
        { discriminator: tracker.getItemCounter('SCOPE:if') }
      );

      const if2 = ScopeNode.createWithContext(
        'if',
        context,
        { line: 10 },
        { discriminator: tracker.getItemCounter('SCOPE:if') }
      );

      const if3 = ScopeNode.createWithContext(
        'if',
        context,
        { line: 15 },
        { discriminator: tracker.getItemCounter('SCOPE:if') }
      );

      assert.strictEqual(if1.id, 'src/app.js->handler->SCOPE->if#0');
      assert.strictEqual(if2.id, 'src/app.js->handler->SCOPE->if#1');
      assert.strictEqual(if3.id, 'src/app.js->handler->SCOPE->if#2');
    });

    it('should track different scope types separately', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('process', 'FUNCTION');
      const context = tracker.getContext();

      const if1 = ScopeNode.createWithContext(
        'if',
        context,
        { line: 5 },
        { discriminator: tracker.getItemCounter('SCOPE:if') }
      );

      const try1 = ScopeNode.createWithContext(
        'try',
        context,
        { line: 10 },
        { discriminator: tracker.getItemCounter('SCOPE:try') }
      );

      const if2 = ScopeNode.createWithContext(
        'if',
        context,
        { line: 15 },
        { discriminator: tracker.getItemCounter('SCOPE:if') }
      );

      assert.strictEqual(if1.id, 'src/app.js->process->SCOPE->if#0');
      assert.strictEqual(try1.id, 'src/app.js->process->SCOPE->try#0');
      assert.strictEqual(if2.id, 'src/app.js->process->SCOPE->if#1');
    });

    it('should create else scope', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('handler', 'FUNCTION');
      const context = tracker.getContext();

      const node = ScopeNode.createWithContext(
        'else',
        context,
        { line: 10 },
        { discriminator: 0 }
      );

      assert.strictEqual(node.id, 'src/app.js->handler->SCOPE->else#0');
    });

    it('should create for loop scope', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('processArray', 'FUNCTION');
      const context = tracker.getContext();

      const node = ScopeNode.createWithContext(
        'for',
        context,
        { line: 5 },
        { discriminator: 0 }
      );

      assert.strictEqual(node.id, 'src/app.js->processArray->SCOPE->for#0');
    });

    it('should create while loop scope', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('waitLoop', 'FUNCTION');
      const context = tracker.getContext();

      const node = ScopeNode.createWithContext(
        'while',
        context,
        { line: 8 },
        { discriminator: 0 }
      );

      assert.strictEqual(node.id, 'src/app.js->waitLoop->SCOPE->while#0');
    });

    it('should create try/catch/finally scopes', () => {
      const tracker = new ScopeTracker('src/error-handler.js');
      tracker.enterScope('handleError', 'FUNCTION');
      const context = tracker.getContext();

      const tryScope = ScopeNode.createWithContext(
        'try',
        context,
        { line: 5 },
        { discriminator: tracker.getItemCounter('SCOPE:try') }
      );

      const catchScope = ScopeNode.createWithContext(
        'catch',
        context,
        { line: 10 },
        { discriminator: tracker.getItemCounter('SCOPE:catch') }
      );

      const finallyScope = ScopeNode.createWithContext(
        'finally',
        context,
        { line: 15 },
        { discriminator: tracker.getItemCounter('SCOPE:finally') }
      );

      assert.strictEqual(tryScope.id, 'src/error-handler.js->handleError->SCOPE->try#0');
      assert.strictEqual(catchScope.id, 'src/error-handler.js->handleError->SCOPE->catch#0');
      assert.strictEqual(finallyScope.id, 'src/error-handler.js->handleError->SCOPE->finally#0');
    });

    it('should create switch/case scopes', () => {
      const tracker = new ScopeTracker('src/router.js');
      tracker.enterScope('route', 'FUNCTION');
      const context = tracker.getContext();

      const switchScope = ScopeNode.createWithContext(
        'switch',
        context,
        { line: 5 },
        { discriminator: 0 }
      );

      assert.strictEqual(switchScope.id, 'src/router.js->route->SCOPE->switch#0');
    });

    it('should set conditional flag', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('check', 'FUNCTION');
      const context = tracker.getContext();

      const node = ScopeNode.createWithContext(
        'if',
        context,
        { line: 5 },
        { discriminator: 0, conditional: true }
      );

      assert.strictEqual(node.conditional, true);
    });

    it('should set parentScopeId', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('outer', 'FUNCTION');
      const context = tracker.getContext();

      const node = ScopeNode.createWithContext(
        'if',
        context,
        { line: 5 },
        { discriminator: 0, parentScopeId: 'src/app.js->global->FUNCTION->outer' }
      );

      assert.strictEqual(node.parentScopeId, 'src/app.js->global->FUNCTION->outer');
    });

    it('should set parentFunctionId', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('myFunc', 'FUNCTION');
      const context = tracker.getContext();

      const node = ScopeNode.createWithContext(
        'if',
        context,
        { line: 5 },
        { discriminator: 0, parentFunctionId: 'src/app.js->global->FUNCTION->myFunc' }
      );

      assert.strictEqual(node.parentFunctionId, 'src/app.js->global->FUNCTION->myFunc');
    });
  });

  describe('Semantic ID stability', () => {
    it('should produce same ID when scope moves to different line', () => {
      const tracker = new ScopeTracker('src/app.js');
      tracker.enterScope('myFunc', 'FUNCTION');
      const context = tracker.getContext();

      const node1 = ScopeNode.createWithContext(
        'if',
        context,
        { line: 5 },
        { discriminator: 0 }
      );

      const node2 = ScopeNode.createWithContext(
        'if',
        context,
        { line: 15 },
        { discriminator: 0 }
      );

      assert.strictEqual(node1.id, node2.id);
      assert.strictEqual(node1.line, 5);
      assert.strictEqual(node2.line, 15);
    });

    it('should produce different IDs in different functions', () => {
      const tracker = new ScopeTracker('src/app.js');

      tracker.enterScope('func1', 'FUNCTION');
      const scope1 = ScopeNode.createWithContext(
        'if',
        tracker.getContext(),
        { line: 5 },
        { discriminator: 0 }
      );
      tracker.exitScope();

      tracker.enterScope('func2', 'FUNCTION');
      const scope2 = ScopeNode.createWithContext(
        'if',
        tracker.getContext(),
        { line: 5 },
        { discriminator: 0 }
      );

      assert.notStrictEqual(scope1.id, scope2.id);
      assert.strictEqual(scope1.id, 'src/app.js->func1->SCOPE->if#0');
      assert.strictEqual(scope2.id, 'src/app.js->func2->SCOPE->if#0');
    });
  });

  describe('validation', () => {
    it('should require scopeType', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        ScopeNode.createWithContext(
          '',
          tracker.getContext(),
          { line: 1 },
          { discriminator: 0 }
        );
      }, /scopeType is required/);
    });

    it('should require file in context', () => {
      const context = { file: '', scopePath: [] };

      assert.throws(() => {
        ScopeNode.createWithContext(
          'if',
          context,
          { line: 1 },
          { discriminator: 0 }
        );
      }, /file is required/);
    });

    it('should require line in location', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        ScopeNode.createWithContext(
          'if',
          tracker.getContext(),
          {},
          { discriminator: 0 }
        );
      }, /line is required/);
    });

    it('should require discriminator', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        ScopeNode.createWithContext(
          'if',
          tracker.getContext(),
          { line: 1 },
          {}
        );
      }, /discriminator is required/);
    });
  });

  describe('backward compatibility with create()', () => {
    it('should still support legacy create() method', () => {
      const node = ScopeNode.create(
        'if',
        'src/app.js',
        5,
        { counter: 0 }
      );

      assert.ok(node.id.includes('if'));
      assert.strictEqual(node.scopeType, 'if');
      assert.strictEqual(node.file, 'src/app.js');
      assert.strictEqual(node.line, 5);
    });
  });

  describe('edge cases', () => {
    it('should handle deeply nested scopes', () => {
      const tracker = new ScopeTracker('src/complex.js');
      tracker.enterScope('Class', 'CLASS');
      tracker.enterScope('method', 'METHOD');
      tracker.enterCountedScope('if');
      tracker.enterCountedScope('try');
      const context = tracker.getContext();

      const forScope = ScopeNode.createWithContext(
        'for',
        context,
        { line: 50 },
        { discriminator: 0 }
      );

      assert.strictEqual(
        forScope.id,
        'src/complex.js->Class->method->if#0->try#0->SCOPE->for#0'
      );
    });

    it('should handle global scope', () => {
      const tracker = new ScopeTracker('src/init.js');
      const context = tracker.getContext();

      // Rare but possible: control flow at module level
      const node = ScopeNode.createWithContext(
        'if',
        context,
        { line: 1 },
        { discriminator: 0 }
      );

      assert.strictEqual(node.id, 'src/init.js->global->SCOPE->if#0');
    });
  });
});

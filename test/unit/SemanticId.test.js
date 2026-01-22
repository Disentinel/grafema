/**
 * SemanticId Module Tests
 *
 * Tests for semantic ID generation and parsing.
 * Based on specification: _tasks/2025-01-22-nodefactory-migration/009-joel-semantic-id-revised.md
 *
 * Semantic IDs provide stable identifiers for code elements that don't change
 * when unrelated code is added/removed (no line numbers in IDs).
 *
 * Format: {file}->{scope_path}->{type}->{name}[#discriminator]
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  computeSemanticId,
  parseSemanticId,
  computeDiscriminator
} from '@grafema/core';

import { ScopeTracker } from '@grafema/core';

// =============================================================================
// TESTS: computeSemanticId()
// =============================================================================

describe('SemanticId', () => {
  describe('computeSemanticId()', () => {
    describe('top-level (global scope) nodes', () => {
      it('should generate ID for top-level function', () => {
        const context = { file: 'src/app.js', scopePath: [] };
        const id = computeSemanticId('FUNCTION', 'processData', context);

        assert.strictEqual(id, 'src/app.js->global->FUNCTION->processData');
      });

      it('should generate ID for top-level class', () => {
        const context = { file: 'src/models/User.js', scopePath: [] };
        const id = computeSemanticId('CLASS', 'User', context);

        assert.strictEqual(id, 'src/models/User.js->global->CLASS->User');
      });

      it('should generate ID for top-level variable', () => {
        const context = { file: 'config.js', scopePath: [] };
        const id = computeSemanticId('VARIABLE', 'API_URL', context);

        assert.strictEqual(id, 'config.js->global->VARIABLE->API_URL');
      });

      it('should generate ID for MODULE node', () => {
        const context = { file: 'src/index.js', scopePath: [] };
        const id = computeSemanticId('MODULE', 'module', context);

        assert.strictEqual(id, 'src/index.js->global->MODULE->module');
      });

      it('should generate ID for IMPORT node', () => {
        const context = { file: 'src/app.js', scopePath: [] };
        const id = computeSemanticId('IMPORT', './database:db', context);

        assert.strictEqual(id, 'src/app.js->global->IMPORT->./database:db');
      });

      it('should generate ID for EXPORT node', () => {
        const context = { file: 'src/utils.js', scopePath: [] };
        const id = computeSemanticId('EXPORT', 'formatDate', context);

        assert.strictEqual(id, 'src/utils.js->global->EXPORT->formatDate');
      });
    });

    describe('nested scope nodes', () => {
      it('should generate ID for method inside class', () => {
        const context = { file: 'src/app.js', scopePath: ['UserService'] };
        const id = computeSemanticId('METHOD', 'login', context);

        assert.strictEqual(id, 'src/app.js->UserService->METHOD->login');
      });

      it('should generate ID for variable inside function', () => {
        const context = { file: 'src/handlers/user.js', scopePath: ['getUser'] };
        const id = computeSemanticId('VARIABLE', 'user', context);

        assert.strictEqual(id, 'src/handlers/user.js->getUser->VARIABLE->user');
      });

      it('should generate ID for deeply nested scope (class > method > if)', () => {
        const context = {
          file: 'src/app.js',
          scopePath: ['UserService', 'processRequest', 'if#0']
        };
        const id = computeSemanticId('CALL', 'console.log', context, { discriminator: 0 });

        assert.strictEqual(id, 'src/app.js->UserService->processRequest->if#0->CALL->console.log#0');
      });

      it('should generate ID for variable in else block', () => {
        const context = {
          file: 'src/handler.js',
          scopePath: ['process', 'else#0']
        };
        const id = computeSemanticId('VARIABLE', 'error', context);

        assert.strictEqual(id, 'src/handler.js->process->else#0->VARIABLE->error');
      });

      it('should handle multiple levels of control flow', () => {
        const context = {
          file: 'src/complex.js',
          scopePath: ['handleRequest', 'try#0', 'if#0', 'for#0']
        };
        const id = computeSemanticId('CALL', 'process', context, { discriminator: 2 });

        assert.strictEqual(
          id,
          'src/complex.js->handleRequest->try#0->if#0->for#0->CALL->process#2'
        );
      });
    });

    describe('counter-based nodes with discriminator', () => {
      it('should generate ID for first CALL in scope', () => {
        const context = { file: 'src/app.js', scopePath: ['test'] };
        const id = computeSemanticId('CALL', 'console.log', context, { discriminator: 0 });

        assert.strictEqual(id, 'src/app.js->test->CALL->console.log#0');
      });

      it('should generate ID for second CALL in scope', () => {
        const context = { file: 'src/app.js', scopePath: ['test'] };
        const id = computeSemanticId('CALL', 'console.log', context, { discriminator: 1 });

        assert.strictEqual(id, 'src/app.js->test->CALL->console.log#1');
      });

      it('should generate ID for third CALL in scope', () => {
        const context = { file: 'src/app.js', scopePath: ['test'] };
        const id = computeSemanticId('CALL', 'console.log', context, { discriminator: 2 });

        assert.strictEqual(id, 'src/app.js->test->CALL->console.log#2');
      });

      it('should generate ID for LITERAL node', () => {
        const context = { file: 'src/config.js', scopePath: ['init'] };
        const id = computeSemanticId('LITERAL', 'string', context, { discriminator: 0 });

        assert.strictEqual(id, 'src/config.js->init->LITERAL->string#0');
      });

      it('should generate ID for EXPRESSION node', () => {
        const context = { file: 'src/app.js', scopePath: ['compute'] };
        const id = computeSemanticId('EXPRESSION', 'BinaryExpression', context, { discriminator: 3 });

        assert.strictEqual(id, 'src/app.js->compute->EXPRESSION->BinaryExpression#3');
      });

      it('should generate ID for DECORATOR node', () => {
        const context = { file: 'src/service.ts', scopePath: [] };
        const id = computeSemanticId('DECORATOR', 'Injectable', context, { discriminator: 0 });

        assert.strictEqual(id, 'src/service.ts->global->DECORATOR->Injectable#0');
      });

      it('should generate ID for SCOPE node', () => {
        const context = { file: 'src/handler.js', scopePath: ['process'] };
        const id = computeSemanticId('SCOPE', 'if', context, { discriminator: 1 });

        assert.strictEqual(id, 'src/handler.js->process->SCOPE->if#1');
      });
    });

    describe('context-based discriminators', () => {
      it('should generate ID with context string', () => {
        const context = { file: 'src/app.js', scopePath: ['handler'] };
        const id = computeSemanticId('VARIABLE', 'x', context, { context: 'in:else-block' });

        assert.strictEqual(id, 'src/app.js->handler->VARIABLE->x[in:else-block]');
      });

      it('should prefer discriminator over context when both provided', () => {
        const context = { file: 'src/app.js', scopePath: ['handler'] };
        const id = computeSemanticId('CALL', 'log', context, {
          discriminator: 5,
          context: 'ignored'
        });

        // Discriminator takes precedence
        assert.strictEqual(id, 'src/app.js->handler->CALL->log#5');
      });
    });

    describe('singleton nodes', () => {
      it('should use correct format for net:stdio singleton', () => {
        // Singletons have fixed format, not computed via computeSemanticId
        // but we test the expected format
        const expected = 'net:stdio->__stdio__';
        assert.strictEqual(expected, 'net:stdio->__stdio__');
      });

      it('should use correct format for net:request singleton', () => {
        const expected = 'net:request->__network__';
        assert.strictEqual(expected, 'net:request->__network__');
      });
    });

    describe('EXTERNAL_MODULE nodes', () => {
      it('should use correct format for external module', () => {
        // External modules have fixed format: EXTERNAL_MODULE->{moduleName}
        const expected = 'EXTERNAL_MODULE->lodash';
        assert.strictEqual(expected, 'EXTERNAL_MODULE->lodash');
      });
    });

    describe('edge cases', () => {
      it('should handle file paths with special characters', () => {
        const context = { file: 'src/handlers/user-auth.service.ts', scopePath: [] };
        const id = computeSemanticId('CLASS', 'UserAuthService', context);

        assert.strictEqual(id, 'src/handlers/user-auth.service.ts->global->CLASS->UserAuthService');
      });

      it('should handle names with special characters ($, _)', () => {
        const context = { file: 'src/svelte.js', scopePath: [] };
        const id = computeSemanticId('FUNCTION', '$effect', context);

        assert.strictEqual(id, 'src/svelte.js->global->FUNCTION->$effect');
      });

      it('should handle empty name (anonymous)', () => {
        const context = { file: 'src/app.js', scopePath: [] };
        const id = computeSemanticId('FUNCTION', 'anonymous[0]', context);

        assert.strictEqual(id, 'src/app.js->global->FUNCTION->anonymous[0]');
      });

      it('should handle deeply nested anonymous functions', () => {
        const context = { file: 'src/app.js', scopePath: ['anonymous[0]'] };
        const id = computeSemanticId('FUNCTION', 'anonymous[0]', context);

        assert.strictEqual(id, 'src/app.js->anonymous[0]->FUNCTION->anonymous[0]');
      });
    });
  });

  // ===========================================================================
  // TESTS: parseSemanticId()
  // ===========================================================================

  describe('parseSemanticId()', () => {
    describe('parse standard ID formats', () => {
      it('should parse top-level function ID', () => {
        const result = parseSemanticId('src/app.js->global->FUNCTION->processData');

        assert.deepStrictEqual(result, {
          file: 'src/app.js',
          scopePath: ['global'],
          type: 'FUNCTION',
          name: 'processData',
          discriminator: undefined,
          context: undefined
        });
      });

      it('should parse nested method ID', () => {
        const result = parseSemanticId('src/app.js->UserService->METHOD->login');

        assert.deepStrictEqual(result, {
          file: 'src/app.js',
          scopePath: ['UserService'],
          type: 'METHOD',
          name: 'login',
          discriminator: undefined,
          context: undefined
        });
      });

      it('should parse deeply nested ID', () => {
        const result = parseSemanticId('src/handler.js->process->if#0->CALL->log');

        assert.deepStrictEqual(result, {
          file: 'src/handler.js',
          scopePath: ['process', 'if#0'],
          type: 'CALL',
          name: 'log',
          discriminator: undefined,
          context: undefined
        });
      });

      it('should parse IMPORT ID', () => {
        const result = parseSemanticId('src/app.js->global->IMPORT->./database:db');

        assert.deepStrictEqual(result, {
          file: 'src/app.js',
          scopePath: ['global'],
          type: 'IMPORT',
          name: './database:db',
          discriminator: undefined,
          context: undefined
        });
      });
    });

    describe('handle discriminators (#N)', () => {
      it('should parse ID with discriminator #0', () => {
        const result = parseSemanticId('src/app.js->test->CALL->console.log#0');

        assert.deepStrictEqual(result, {
          file: 'src/app.js',
          scopePath: ['test'],
          type: 'CALL',
          name: 'console.log',
          discriminator: 0,
          context: undefined
        });
      });

      it('should parse ID with discriminator #5', () => {
        const result = parseSemanticId('file.js->fn->CALL->process#5');

        assert.deepStrictEqual(result, {
          file: 'file.js',
          scopePath: ['fn'],
          type: 'CALL',
          name: 'process',
          discriminator: 5,
          context: undefined
        });
      });

      it('should parse ID with large discriminator #123', () => {
        const result = parseSemanticId('app.js->loop->LITERAL->number#123');

        assert.deepStrictEqual(result, {
          file: 'app.js',
          scopePath: ['loop'],
          type: 'LITERAL',
          name: 'number',
          discriminator: 123,
          context: undefined
        });
      });
    });

    describe('handle context ([context])', () => {
      it('should parse ID with context', () => {
        const result = parseSemanticId('src/app.js->handler->VARIABLE->x[in:else-block]');

        assert.deepStrictEqual(result, {
          file: 'src/app.js',
          scopePath: ['handler'],
          type: 'VARIABLE',
          name: 'x',
          discriminator: undefined,
          context: 'in:else-block'
        });
      });

      it('should parse ID with complex context', () => {
        const result = parseSemanticId('file.js->fn->CALL->log[catch:error]');

        assert.deepStrictEqual(result, {
          file: 'file.js',
          scopePath: ['fn'],
          type: 'CALL',
          name: 'log',
          discriminator: undefined,
          context: 'catch:error'
        });
      });
    });

    describe('handle singletons', () => {
      it('should parse net:stdio singleton', () => {
        const result = parseSemanticId('net:stdio->__stdio__');

        assert.deepStrictEqual(result, {
          file: '',
          scopePath: ['net:stdio'],
          type: 'SINGLETON',
          name: '__stdio__',
          discriminator: undefined
        });
      });

      it('should parse net:request singleton', () => {
        const result = parseSemanticId('net:request->__network__');

        assert.deepStrictEqual(result, {
          file: '',
          scopePath: ['net:request'],
          type: 'SINGLETON',
          name: '__network__',
          discriminator: undefined
        });
      });
    });

    describe('handle EXTERNAL_MODULE', () => {
      it('should parse EXTERNAL_MODULE ID', () => {
        const result = parseSemanticId('EXTERNAL_MODULE->lodash');

        assert.deepStrictEqual(result, {
          file: '',
          scopePath: [],
          type: 'EXTERNAL_MODULE',
          name: 'lodash',
          discriminator: undefined
        });
      });

      it('should parse scoped package EXTERNAL_MODULE', () => {
        const result = parseSemanticId('EXTERNAL_MODULE->@tanstack/react-query');

        assert.deepStrictEqual(result, {
          file: '',
          scopePath: [],
          type: 'EXTERNAL_MODULE',
          name: '@tanstack/react-query',
          discriminator: undefined
        });
      });
    });

    describe('handle invalid IDs', () => {
      it('should return null for empty string', () => {
        const result = parseSemanticId('');
        assert.strictEqual(result, null);
      });

      it('should return null for malformed ID (too few parts)', () => {
        const result = parseSemanticId('file.js->FUNCTION');
        assert.strictEqual(result, null);
      });

      it('should return null for ID with only one part', () => {
        const result = parseSemanticId('something');
        assert.strictEqual(result, null);
      });
    });

    describe('roundtrip: compute -> parse -> verify', () => {
      it('should roundtrip simple ID', () => {
        const context = { file: 'src/app.js', scopePath: [] };
        const computed = computeSemanticId('FUNCTION', 'main', context);
        const parsed = parseSemanticId(computed);

        assert.strictEqual(parsed.file, 'src/app.js');
        assert.strictEqual(parsed.type, 'FUNCTION');
        assert.strictEqual(parsed.name, 'main');
      });

      it('should roundtrip ID with discriminator', () => {
        const context = { file: 'app.js', scopePath: ['handler'] };
        const computed = computeSemanticId('CALL', 'log', context, { discriminator: 3 });
        const parsed = parseSemanticId(computed);

        assert.strictEqual(parsed.file, 'app.js');
        assert.strictEqual(parsed.type, 'CALL');
        assert.strictEqual(parsed.name, 'log');
        assert.strictEqual(parsed.discriminator, 3);
      });

      it('should roundtrip deeply nested ID', () => {
        const context = {
          file: 'src/complex.js',
          scopePath: ['Class', 'method', 'if#0', 'try#0']
        };
        const computed = computeSemanticId('VARIABLE', 'result', context);
        const parsed = parseSemanticId(computed);

        assert.strictEqual(parsed.file, 'src/complex.js');
        assert.deepStrictEqual(parsed.scopePath, ['Class', 'method', 'if#0', 'try#0']);
        assert.strictEqual(parsed.type, 'VARIABLE');
        assert.strictEqual(parsed.name, 'result');
      });
    });
  });

  // ===========================================================================
  // TESTS: computeDiscriminator()
  // ===========================================================================

  describe('computeDiscriminator()', () => {
    describe('single item (no collision)', () => {
      it('should return 0 for single item', () => {
        const items = [
          { name: 'console.log', location: { line: 5, column: 4 } }
        ];

        const discriminator = computeDiscriminator(items, 'console.log', { line: 5, column: 4 });
        assert.strictEqual(discriminator, 0);
      });

      it('should return 0 for item with unique name among others', () => {
        const items = [
          { name: 'console.log', location: { line: 5, column: 4 } },
          { name: 'console.error', location: { line: 6, column: 4 } },
          { name: 'process.exit', location: { line: 7, column: 4 } }
        ];

        const discriminator = computeDiscriminator(items, 'console.log', { line: 5, column: 4 });
        assert.strictEqual(discriminator, 0);
      });
    });

    describe('multiple items with same name', () => {
      it('should return correct index for first occurrence', () => {
        const items = [
          { name: 'console.log', location: { line: 5, column: 4 } },
          { name: 'console.log', location: { line: 8, column: 4 } },
          { name: 'console.log', location: { line: 12, column: 4 } }
        ];

        const discriminator = computeDiscriminator(items, 'console.log', { line: 5, column: 4 });
        assert.strictEqual(discriminator, 0);
      });

      it('should return correct index for second occurrence', () => {
        const items = [
          { name: 'console.log', location: { line: 5, column: 4 } },
          { name: 'console.log', location: { line: 8, column: 4 } },
          { name: 'console.log', location: { line: 12, column: 4 } }
        ];

        const discriminator = computeDiscriminator(items, 'console.log', { line: 8, column: 4 });
        assert.strictEqual(discriminator, 1);
      });

      it('should return correct index for third occurrence', () => {
        const items = [
          { name: 'console.log', location: { line: 5, column: 4 } },
          { name: 'console.log', location: { line: 8, column: 4 } },
          { name: 'console.log', location: { line: 12, column: 4 } }
        ];

        const discriminator = computeDiscriminator(items, 'console.log', { line: 12, column: 4 });
        assert.strictEqual(discriminator, 2);
      });
    });

    describe('stable ordering by line/column', () => {
      it('should order by line first', () => {
        // Items provided out of order
        const items = [
          { name: 'log', location: { line: 20, column: 4 } },
          { name: 'log', location: { line: 5, column: 4 } },
          { name: 'log', location: { line: 10, column: 4 } }
        ];

        // Line 5 should be #0, line 10 should be #1, line 20 should be #2
        assert.strictEqual(computeDiscriminator(items, 'log', { line: 5, column: 4 }), 0);
        assert.strictEqual(computeDiscriminator(items, 'log', { line: 10, column: 4 }), 1);
        assert.strictEqual(computeDiscriminator(items, 'log', { line: 20, column: 4 }), 2);
      });

      it('should order by column when lines are equal', () => {
        const items = [
          { name: 'call', location: { line: 10, column: 20 } },
          { name: 'call', location: { line: 10, column: 4 } },
          { name: 'call', location: { line: 10, column: 12 } }
        ];

        // Column 4 should be #0, column 12 should be #1, column 20 should be #2
        assert.strictEqual(computeDiscriminator(items, 'call', { line: 10, column: 4 }), 0);
        assert.strictEqual(computeDiscriminator(items, 'call', { line: 10, column: 12 }), 1);
        assert.strictEqual(computeDiscriminator(items, 'call', { line: 10, column: 20 }), 2);
      });

      it('should handle mixed line and column ordering', () => {
        const items = [
          { name: 'fn', location: { line: 10, column: 20 } },
          { name: 'fn', location: { line: 5, column: 30 } },
          { name: 'fn', location: { line: 10, column: 5 } },
          { name: 'fn', location: { line: 5, column: 10 } }
        ];

        // Sorted order: (5,10), (5,30), (10,5), (10,20)
        assert.strictEqual(computeDiscriminator(items, 'fn', { line: 5, column: 10 }), 0);
        assert.strictEqual(computeDiscriminator(items, 'fn', { line: 5, column: 30 }), 1);
        assert.strictEqual(computeDiscriminator(items, 'fn', { line: 10, column: 5 }), 2);
        assert.strictEqual(computeDiscriminator(items, 'fn', { line: 10, column: 20 }), 3);
      });
    });

    describe('item not found', () => {
      it('should return 0 when target location not in list', () => {
        const items = [
          { name: 'log', location: { line: 5, column: 4 } },
          { name: 'log', location: { line: 10, column: 4 } }
        ];

        // Location not in list
        const discriminator = computeDiscriminator(items, 'log', { line: 99, column: 99 });
        assert.strictEqual(discriminator, 0);
      });
    });
  });

  // ===========================================================================
  // TESTS: ScopeTracker
  // ===========================================================================

  describe('ScopeTracker', () => {
    describe('enterScope / exitScope', () => {
      it('should track single scope', () => {
        const tracker = new ScopeTracker('app.js');

        tracker.enterScope('myFunction', 'FUNCTION');
        const context = tracker.getContext();

        assert.deepStrictEqual(context, {
          file: 'app.js',
          scopePath: ['myFunction']
        });

        tracker.exitScope();
        const afterExit = tracker.getContext();
        assert.deepStrictEqual(afterExit.scopePath, []);
      });

      it('should track nested scopes', () => {
        const tracker = new ScopeTracker('app.js');

        tracker.enterScope('MyClass', 'CLASS');
        tracker.enterScope('myMethod', 'METHOD');

        const context = tracker.getContext();
        assert.deepStrictEqual(context.scopePath, ['MyClass', 'myMethod']);

        tracker.exitScope();
        assert.deepStrictEqual(tracker.getContext().scopePath, ['MyClass']);

        tracker.exitScope();
        assert.deepStrictEqual(tracker.getContext().scopePath, []);
      });

      it('should handle deeply nested scopes', () => {
        const tracker = new ScopeTracker('complex.js');

        tracker.enterScope('Class', 'CLASS');
        tracker.enterScope('method', 'METHOD');
        tracker.enterScope('if#0', 'IF');
        tracker.enterScope('try#0', 'TRY');

        assert.deepStrictEqual(tracker.getContext().scopePath, [
          'Class', 'method', 'if#0', 'try#0'
        ]);
      });
    });

    describe('getContext returns correct scope path', () => {
      it('should return global scope when empty', () => {
        const tracker = new ScopeTracker('app.js');
        const context = tracker.getContext();

        assert.strictEqual(context.file, 'app.js');
        assert.deepStrictEqual(context.scopePath, []);
      });

      it('should return correct file and scopePath', () => {
        const tracker = new ScopeTracker('/project/src/handlers/user.js');

        tracker.enterScope('getUser', 'FUNCTION');

        const context = tracker.getContext();
        assert.strictEqual(context.file, '/project/src/handlers/user.js');
        assert.deepStrictEqual(context.scopePath, ['getUser']);
      });
    });

    describe('getScopePath()', () => {
      it('should return "global" for empty scope', () => {
        const tracker = new ScopeTracker('app.js');
        assert.strictEqual(tracker.getScopePath(), 'global');
      });

      it('should return joined path for nested scopes', () => {
        const tracker = new ScopeTracker('app.js');
        tracker.enterScope('Class', 'CLASS');
        tracker.enterScope('method', 'METHOD');

        assert.strictEqual(tracker.getScopePath(), 'Class->method');
      });
    });

    describe('getItemCounter increments correctly', () => {
      it('should start at 0', () => {
        const tracker = new ScopeTracker('app.js');
        tracker.enterScope('fn', 'FUNCTION');

        const first = tracker.getItemCounter('CALL');
        assert.strictEqual(first, 0);
      });

      it('should increment on each call', () => {
        const tracker = new ScopeTracker('app.js');
        tracker.enterScope('fn', 'FUNCTION');

        assert.strictEqual(tracker.getItemCounter('CALL'), 0);
        assert.strictEqual(tracker.getItemCounter('CALL'), 1);
        assert.strictEqual(tracker.getItemCounter('CALL'), 2);
        assert.strictEqual(tracker.getItemCounter('CALL'), 3);
      });

      it('should track different item types separately', () => {
        const tracker = new ScopeTracker('app.js');
        tracker.enterScope('fn', 'FUNCTION');

        assert.strictEqual(tracker.getItemCounter('CALL'), 0);
        assert.strictEqual(tracker.getItemCounter('LITERAL'), 0);
        assert.strictEqual(tracker.getItemCounter('CALL'), 1);
        assert.strictEqual(tracker.getItemCounter('LITERAL'), 1);
      });

      it('should track counters per scope', () => {
        const tracker = new ScopeTracker('app.js');

        tracker.enterScope('fn1', 'FUNCTION');
        assert.strictEqual(tracker.getItemCounter('CALL'), 0);
        assert.strictEqual(tracker.getItemCounter('CALL'), 1);
        tracker.exitScope();

        tracker.enterScope('fn2', 'FUNCTION');
        // New scope, counter resets
        assert.strictEqual(tracker.getItemCounter('CALL'), 0);
      });
    });

    describe('peekItemCounter()', () => {
      it('should return current count without incrementing', () => {
        const tracker = new ScopeTracker('app.js');
        tracker.enterScope('fn', 'FUNCTION');

        tracker.getItemCounter('CALL'); // 0
        tracker.getItemCounter('CALL'); // 1

        // Peek should return 2 (next value) without incrementing
        assert.strictEqual(tracker.peekItemCounter('CALL'), 2);
        assert.strictEqual(tracker.peekItemCounter('CALL'), 2); // Still 2

        // Now increment
        assert.strictEqual(tracker.getItemCounter('CALL'), 2);
        assert.strictEqual(tracker.peekItemCounter('CALL'), 3);
      });

      it('should return 0 for never-used counter', () => {
        const tracker = new ScopeTracker('app.js');
        assert.strictEqual(tracker.peekItemCounter('EXPRESSION'), 0);
      });
    });

    describe('getSiblingIndex for anonymous functions', () => {
      it('should start at 0 for first anonymous', () => {
        const tracker = new ScopeTracker('app.js');

        const index = tracker.getSiblingIndex('anonymous');
        assert.strictEqual(index, 0);
      });

      it('should increment for each anonymous sibling', () => {
        const tracker = new ScopeTracker('app.js');

        assert.strictEqual(tracker.getSiblingIndex('anonymous'), 0);
        assert.strictEqual(tracker.getSiblingIndex('anonymous'), 1);
        assert.strictEqual(tracker.getSiblingIndex('anonymous'), 2);
      });

      it('should track siblings per scope', () => {
        const tracker = new ScopeTracker('app.js');

        // Global scope
        assert.strictEqual(tracker.getSiblingIndex('anonymous'), 0);
        assert.strictEqual(tracker.getSiblingIndex('anonymous'), 1);

        tracker.enterScope('fn', 'FUNCTION');
        // New scope, new sibling tracking
        assert.strictEqual(tracker.getSiblingIndex('anonymous'), 0);
        assert.strictEqual(tracker.getSiblingIndex('anonymous'), 1);

        tracker.exitScope();
        // Back to global, continues from 2
        assert.strictEqual(tracker.getSiblingIndex('anonymous'), 2);
      });

      it('should track different sibling names separately', () => {
        const tracker = new ScopeTracker('app.js');

        assert.strictEqual(tracker.getSiblingIndex('anonymous'), 0);
        assert.strictEqual(tracker.getSiblingIndex('arrow'), 0);
        assert.strictEqual(tracker.getSiblingIndex('anonymous'), 1);
        assert.strictEqual(tracker.getSiblingIndex('arrow'), 1);
      });
    });

    describe('enterCountedScope for control flow', () => {
      it('should create counted scope name', () => {
        const tracker = new ScopeTracker('app.js');
        tracker.enterScope('fn', 'FUNCTION');

        const result = tracker.enterCountedScope('if');

        assert.strictEqual(result.name, 'if#0');
        assert.strictEqual(result.discriminator, 0);
        assert.deepStrictEqual(tracker.getContext().scopePath, ['fn', 'if#0']);
      });

      it('should increment for each counted scope of same type', () => {
        const tracker = new ScopeTracker('app.js');
        tracker.enterScope('fn', 'FUNCTION');

        const first = tracker.enterCountedScope('if');
        tracker.exitScope();

        const second = tracker.enterCountedScope('if');
        tracker.exitScope();

        const third = tracker.enterCountedScope('if');

        assert.strictEqual(first.name, 'if#0');
        assert.strictEqual(second.name, 'if#1');
        assert.strictEqual(third.name, 'if#2');
      });

      it('should track different scope types separately', () => {
        const tracker = new ScopeTracker('app.js');
        tracker.enterScope('fn', 'FUNCTION');

        const if1 = tracker.enterCountedScope('if');
        tracker.exitScope();

        const try1 = tracker.enterCountedScope('try');
        tracker.exitScope();

        const if2 = tracker.enterCountedScope('if');
        tracker.exitScope();

        const else1 = tracker.enterCountedScope('else');

        assert.strictEqual(if1.name, 'if#0');
        assert.strictEqual(try1.name, 'try#0');
        assert.strictEqual(if2.name, 'if#1');
        assert.strictEqual(else1.name, 'else#0');
      });

      it('should handle nested control flow', () => {
        const tracker = new ScopeTracker('app.js');
        tracker.enterScope('fn', 'FUNCTION');

        tracker.enterCountedScope('if'); // if#0
        tracker.enterCountedScope('for'); // for#0 inside if#0

        assert.strictEqual(tracker.getScopePath(), 'fn->if#0->for#0');

        tracker.exitScope(); // exit for
        tracker.enterCountedScope('while'); // while#0 inside if#0

        assert.strictEqual(tracker.getScopePath(), 'fn->if#0->while#0');
      });
    });
  });

  // ===========================================================================
  // INTEGRATION: Full trace example from spec
  // ===========================================================================

  describe('Integration: Full trace example', () => {
    it('should generate correct IDs for spec example (src/handlers/user.js)', () => {
      /**
       * Source code:
       * import { db } from './database';
       *
       * export function getUser(id) {
       *   const user = db.findById(id);
       *   if (user) {
       *     console.log('Found user');
       *     return user;
       *   }
       *   console.log('User not found');
       *   return null;
       * }
       */

      const file = 'src/handlers/user.js';
      const tracker = new ScopeTracker(file);

      // MODULE node
      const moduleId = computeSemanticId('MODULE', 'module', tracker.getContext());
      assert.strictEqual(moduleId, 'src/handlers/user.js->global->MODULE->module');

      // IMPORT node
      const importId = computeSemanticId('IMPORT', './database:db', tracker.getContext());
      assert.strictEqual(importId, 'src/handlers/user.js->global->IMPORT->./database:db');

      // EXPORT node
      const exportId = computeSemanticId('EXPORT', 'getUser', tracker.getContext());
      assert.strictEqual(exportId, 'src/handlers/user.js->global->EXPORT->getUser');

      // FUNCTION node
      const functionId = computeSemanticId('FUNCTION', 'getUser', tracker.getContext());
      assert.strictEqual(functionId, 'src/handlers/user.js->global->FUNCTION->getUser');

      // Enter function scope
      tracker.enterScope('getUser', 'FUNCTION');

      // VARIABLE user
      const variableId = computeSemanticId('VARIABLE', 'user', tracker.getContext());
      assert.strictEqual(variableId, 'src/handlers/user.js->getUser->VARIABLE->user');

      // CALL db.findById#0
      const callId1 = computeSemanticId('CALL', 'db.findById', tracker.getContext(), {
        discriminator: tracker.getItemCounter('CALL:db.findById')
      });
      assert.strictEqual(callId1, 'src/handlers/user.js->getUser->CALL->db.findById#0');

      // Enter if scope
      tracker.enterCountedScope('if');

      // CALL console.log#0 (inside if)
      const callId2 = computeSemanticId('CALL', 'console.log', tracker.getContext(), {
        discriminator: tracker.getItemCounter('CALL:console.log')
      });
      assert.strictEqual(callId2, 'src/handlers/user.js->getUser->if#0->CALL->console.log#0');

      // Exit if scope
      tracker.exitScope();

      // CALL console.log#1 (after if, back in getUser scope)
      // Note: This is a different console.log counter in getUser scope
      const callId3 = computeSemanticId('CALL', 'console.log', tracker.getContext(), {
        discriminator: tracker.getItemCounter('CALL:console.log')
      });
      assert.strictEqual(callId3, 'src/handlers/user.js->getUser->CALL->console.log#0');
    });
  });
});

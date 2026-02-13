/**
 * SemanticId v2 Module Tests
 *
 * Tests for v2 semantic ID generation, parsing, and content hashing.
 *
 * v2 format: file->TYPE->name[in:namedParent,h:xxxx]#N
 *
 * Key improvement over v1: anonymous scopes (if, for, try) are not encoded
 * in the ID. Adding/removing blocks doesn't cascade ID changes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  computeSemanticIdV2,
  parseSemanticIdV2,
  computeContentHash,
  ScopeTracker
} from '@grafema/core';

// =============================================================================
// TESTS: computeSemanticIdV2()
// =============================================================================

describe('SemanticId v2', () => {
  describe('computeSemanticIdV2()', () => {
    it('should generate ID for top-level function (no parent)', () => {
      const id = computeSemanticIdV2('FUNCTION', 'processData', 'src/app.js');
      assert.strictEqual(id, 'src/app.js->FUNCTION->processData');
    });

    it('should generate ID for nested method', () => {
      const id = computeSemanticIdV2('FUNCTION', 'login', 'src/app.js', 'UserService');
      assert.strictEqual(id, 'src/app.js->FUNCTION->login[in:UserService]');
    });

    it('should generate ID with content hash', () => {
      const id = computeSemanticIdV2('CALL', 'console.log', 'src/app.js', 'processData', 'a1b2');
      assert.strictEqual(id, 'src/app.js->CALL->console.log[in:processData,h:a1b2]');
    });

    it('should generate ID with hash and counter', () => {
      const id = computeSemanticIdV2('CALL', 'console.log', 'src/app.js', 'processData', 'a1b2', 1);
      assert.strictEqual(id, 'src/app.js->CALL->console.log[in:processData,h:a1b2]#1');
    });

    it('should omit counter when 0', () => {
      const id = computeSemanticIdV2('CALL', 'console.log', 'src/app.js', 'processData', 'a1b2', 0);
      assert.strictEqual(id, 'src/app.js->CALL->console.log[in:processData,h:a1b2]');
    });

    it('should generate ID for top-level constant (no parent)', () => {
      const id = computeSemanticIdV2('CONSTANT', 'API_URL', 'config.js');
      assert.strictEqual(id, 'config.js->CONSTANT->API_URL');
    });

    it('should generate ID with hash but no parent (top-level collision)', () => {
      const id = computeSemanticIdV2('CALL', 'init', 'config.js', undefined, 'beef');
      assert.strictEqual(id, 'config.js->CALL->init[h:beef]');
    });

    it('should handle names with dots', () => {
      const id = computeSemanticIdV2('CALL', 'console.log', 'src/app.js', 'main');
      assert.strictEqual(id, 'src/app.js->CALL->console.log[in:main]');
    });

    it('should handle file paths with special characters', () => {
      const id = computeSemanticIdV2('CLASS', 'UserAuthService', 'src/handlers/user-auth.service.ts');
      assert.strictEqual(id, 'src/handlers/user-auth.service.ts->CLASS->UserAuthService');
    });

    it('should handle names with $ and _', () => {
      const id = computeSemanticIdV2('FUNCTION', '$effect', 'src/svelte.js');
      assert.strictEqual(id, 'src/svelte.js->FUNCTION->$effect');
    });
  });

  // ===========================================================================
  // TESTS: parseSemanticIdV2()
  // ===========================================================================

  describe('parseSemanticIdV2()', () => {
    describe('v2 format parsing', () => {
      it('should parse minimal v2 ID (file, type, name only)', () => {
        const result = parseSemanticIdV2('src/app.js->FUNCTION->processData');
        assert.deepStrictEqual(result, {
          file: 'src/app.js',
          type: 'FUNCTION',
          name: 'processData',
          namedParent: undefined,
          contentHash: undefined,
          counter: undefined
        });
      });

      it('should parse v2 ID with namedParent', () => {
        const result = parseSemanticIdV2('src/app.js->FUNCTION->login[in:UserService]');
        assert.deepStrictEqual(result, {
          file: 'src/app.js',
          type: 'FUNCTION',
          name: 'login',
          namedParent: 'UserService',
          contentHash: undefined,
          counter: undefined
        });
      });

      it('should parse v2 ID with all fields', () => {
        const result = parseSemanticIdV2('src/app.js->CALL->console.log[in:processData,h:a1b2]#1');
        assert.deepStrictEqual(result, {
          file: 'src/app.js',
          type: 'CALL',
          name: 'console.log',
          namedParent: 'processData',
          contentHash: 'a1b2',
          counter: 1
        });
      });

      it('should parse v2 ID with hash but no parent', () => {
        const result = parseSemanticIdV2('config.js->CALL->init[h:beef]');
        assert.deepStrictEqual(result, {
          file: 'config.js',
          type: 'CALL',
          name: 'init',
          namedParent: undefined,
          contentHash: 'beef',
          counter: undefined
        });
      });

      it('should parse v2 ID with name containing dots', () => {
        const result = parseSemanticIdV2('src/app.js->CALL->console.log[in:main]');
        assert.strictEqual(result.name, 'console.log');
        assert.strictEqual(result.namedParent, 'main');
      });
    });

    describe('singleton format', () => {
      it('should parse net:stdio singleton', () => {
        const result = parseSemanticIdV2('net:stdio->__stdio__');
        assert.strictEqual(result.file, '');
        assert.strictEqual(result.type, 'SINGLETON');
        assert.strictEqual(result.name, '__stdio__');
      });

      it('should parse net:request singleton', () => {
        const result = parseSemanticIdV2('net:request->__network__');
        assert.strictEqual(result.file, '');
        assert.strictEqual(result.type, 'SINGLETON');
        assert.strictEqual(result.name, '__network__');
      });
    });

    describe('external module format', () => {
      it('should parse EXTERNAL_MODULE', () => {
        const result = parseSemanticIdV2('EXTERNAL_MODULE->lodash');
        assert.strictEqual(result.file, '');
        assert.strictEqual(result.type, 'EXTERNAL_MODULE');
        assert.strictEqual(result.name, 'lodash');
      });
    });

    describe('invalid IDs', () => {
      it('should return null for empty string', () => {
        assert.strictEqual(parseSemanticIdV2(''), null);
      });

      it('should return null for single part', () => {
        assert.strictEqual(parseSemanticIdV2('something'), null);
      });

      it('should return null for v1 IDs (4+ parts with scope path)', () => {
        // v1 format has scope path between file and type
        assert.strictEqual(
          parseSemanticIdV2('src/app.js->global->FUNCTION->processData'),
          null
        );
      });

      it('should return null for v1 nested IDs', () => {
        assert.strictEqual(
          parseSemanticIdV2('src/app.js->UserService->processRequest->if#0->CALL->console.log#0'),
          null
        );
      });
    });

    describe('round-trip: compute -> parse -> verify', () => {
      const cases = [
        { desc: 'top-level function', args: ['FUNCTION', 'processData', 'src/app.js'] },
        { desc: 'nested method', args: ['FUNCTION', 'login', 'src/app.js', 'UserService'] },
        { desc: 'with hash', args: ['CALL', 'console.log', 'src/app.js', 'processData', 'a1b2'] },
        { desc: 'with hash and counter', args: ['CALL', 'console.log', 'src/app.js', 'processData', 'a1b2', 1] },
        { desc: 'top-level constant', args: ['CONSTANT', 'API_URL', 'config.js'] },
        { desc: 'hash no parent', args: ['CALL', 'init', 'config.js', undefined, 'beef'] },
      ];

      for (const { desc, args } of cases) {
        it(`should round-trip: ${desc}`, () => {
          const id = computeSemanticIdV2(...args);
          const parsed = parseSemanticIdV2(id);
          assert.ok(parsed, `Failed to parse: ${id}`);
          const recomputed = computeSemanticIdV2(
            parsed.type, parsed.name, parsed.file,
            parsed.namedParent, parsed.contentHash, parsed.counter
          );
          assert.strictEqual(recomputed, id);
        });
      }
    });
  });

  // ===========================================================================
  // TESTS: computeContentHash()
  // ===========================================================================

  describe('computeContentHash()', () => {
    it('should be deterministic (same hints = same hash)', () => {
      const hash1 = computeContentHash({ arity: 1, firstLiteralArg: 'hello' });
      const hash2 = computeContentHash({ arity: 1, firstLiteralArg: 'hello' });
      assert.strictEqual(hash1, hash2);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = computeContentHash({ arity: 1, firstLiteralArg: 'hello' });
      const hash2 = computeContentHash({ arity: 2, firstLiteralArg: 'world' });
      assert.notStrictEqual(hash1, hash2);
    });

    it('should return 4-hex-char string', () => {
      const hash = computeContentHash({ arity: 3 });
      assert.match(hash, /^[0-9a-f]{4}$/);
    });

    it('should handle empty hints', () => {
      const hash = computeContentHash({});
      assert.match(hash, /^[0-9a-f]{4}$/);
    });

    it('should differ on arity alone', () => {
      const hash1 = computeContentHash({ arity: 0 });
      const hash2 = computeContentHash({ arity: 1 });
      assert.notStrictEqual(hash1, hash2);
    });

    it('should differ on firstLiteralArg alone', () => {
      const hash1 = computeContentHash({ firstLiteralArg: 'start' });
      const hash2 = computeContentHash({ firstLiteralArg: 'end' });
      assert.notStrictEqual(hash1, hash2);
    });

    it('should handle special characters in hints', () => {
      const hash = computeContentHash({ firstLiteralArg: 'héllo wörld! @#$%' });
      assert.match(hash, /^[0-9a-f]{4}$/);
    });
  });

  // ===========================================================================
  // TESTS: ScopeTracker.getNamedParent()
  // ===========================================================================

  describe('ScopeTracker.getNamedParent()', () => {
    it('should return undefined for empty stack', () => {
      const tracker = new ScopeTracker('app.js');
      assert.strictEqual(tracker.getNamedParent(), undefined);
    });

    it('should return undefined for only counted scopes', () => {
      const tracker = new ScopeTracker('app.js');
      tracker.enterCountedScope('if');
      tracker.enterCountedScope('try');
      assert.strictEqual(tracker.getNamedParent(), undefined);
    });

    it('should return named function at top', () => {
      const tracker = new ScopeTracker('app.js');
      tracker.enterScope('fetchData', 'FUNCTION');
      assert.strictEqual(tracker.getNamedParent(), 'fetchData');
    });

    it('should return named function when inside counted scope', () => {
      const tracker = new ScopeTracker('app.js');
      tracker.enterScope('fetchData', 'FUNCTION');
      tracker.enterCountedScope('if');
      assert.strictEqual(tracker.getNamedParent(), 'fetchData');
    });

    it('should return innermost named scope (nested named scopes)', () => {
      const tracker = new ScopeTracker('app.js');
      tracker.enterScope('UserService', 'CLASS');
      tracker.enterScope('login', 'FUNCTION');
      tracker.enterCountedScope('if');
      assert.strictEqual(tracker.getNamedParent(), 'login');
    });

    it('should return class name when inside class directly', () => {
      const tracker = new ScopeTracker('app.js');
      tracker.enterScope('UserService', 'CLASS');
      assert.strictEqual(tracker.getNamedParent(), 'UserService');
    });

    it('should handle deeply nested counted scopes', () => {
      const tracker = new ScopeTracker('app.js');
      tracker.enterScope('handler', 'FUNCTION');
      tracker.enterCountedScope('try');
      tracker.enterCountedScope('if');
      tracker.enterCountedScope('for');
      assert.strictEqual(tracker.getNamedParent(), 'handler');
    });

    it('should skip anonymous function scopes', () => {
      const tracker = new ScopeTracker('app.js');
      tracker.enterScope('handler', 'FUNCTION');
      tracker.enterScope('anonymous', 'FUNCTION');
      assert.strictEqual(tracker.getNamedParent(), 'handler');
    });

    it('should skip indexed anonymous function scopes (anonymous[N])', () => {
      const tracker = new ScopeTracker('app.js');
      tracker.enterScope('handler', 'FUNCTION');
      tracker.enterScope('anonymous[0]', 'FUNCTION');
      assert.strictEqual(tracker.getNamedParent(), 'handler');
    });

    it('should skip anonymous inside counted scopes', () => {
      const tracker = new ScopeTracker('app.js');
      tracker.enterScope('MyClass', 'CLASS');
      tracker.enterScope('anonymous[2]', 'FUNCTION');
      tracker.enterCountedScope('if');
      assert.strictEqual(tracker.getNamedParent(), 'MyClass');
    });

    it('should return undefined when only anonymous scopes exist', () => {
      const tracker = new ScopeTracker('app.js');
      tracker.enterScope('anonymous', 'FUNCTION');
      tracker.enterScope('anonymous[0]', 'FUNCTION');
      assert.strictEqual(tracker.getNamedParent(), undefined);
    });

    it('should update after exitScope', () => {
      const tracker = new ScopeTracker('app.js');
      tracker.enterScope('outer', 'FUNCTION');
      tracker.enterScope('inner', 'FUNCTION');
      assert.strictEqual(tracker.getNamedParent(), 'inner');

      tracker.exitScope();
      assert.strictEqual(tracker.getNamedParent(), 'outer');

      tracker.exitScope();
      assert.strictEqual(tracker.getNamedParent(), undefined);
    });
  });
});

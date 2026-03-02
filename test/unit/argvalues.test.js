/**
 * Tests for argValues metadata on CALL nodes (REG-591, Commit 1)
 *
 * The argValues field on CALL node metadata extracts string literal values
 * from function call arguments. This enables domain plugins to inspect
 * argument values without re-parsing the AST.
 *
 * argValues[i] is:
 *   - A string if argument i is a StringLiteral or a TemplateLiteral with no expressions
 *   - null if argument i is anything else (Identifier, numeric, boolean, expression, etc.)
 *
 * argValues.length always equals the number of arguments in the call.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkFile, jsRegistry } from '../../packages/core-v2/dist/index.js';

/**
 * Helper: walk code and return the first CALL node matching the given name.
 */
async function findCallNode(code, callName) {
  const result = await walkFile(code, 'test.ts', jsRegistry);
  return result.nodes.find(n => n.type === 'CALL' && n.name === callName);
}

/**
 * Helper: walk code and return the first CALL node whose name includes the given pattern.
 * Useful for method calls like 'app.get' where the full name is 'app.get'.
 */
async function findCallNodeByPattern(code, pattern) {
  const result = await walkFile(code, 'test.ts', jsRegistry);
  return result.nodes.find(n => n.type === 'CALL' && n.name.includes(pattern));
}

describe('argValues in CALL node metadata (REG-591)', () => {

  describe('String literal arguments', () => {
    it('should extract string literal arg values', async () => {
      const code = `foo('hello', 'world');`;
      const callNode = await findCallNode(code, 'foo');
      assert.ok(callNode, 'foo CALL node should exist');
      assert.ok(callNode.metadata, 'CALL node should have metadata');
      assert.deepStrictEqual(
        callNode.metadata.argValues,
        ['hello', 'world'],
        'argValues should contain both string literal values'
      );
    });
  });

  describe('Mixed argument types', () => {
    it('should return null for non-string-literal arguments', async () => {
      const code = `foo('path', handler, 42);`;
      const callNode = await findCallNode(code, 'foo');
      assert.ok(callNode, 'foo CALL node should exist');
      assert.deepStrictEqual(
        callNode.metadata.argValues,
        ['path', null, null],
        'argValues: string for literal, null for identifier and numeric'
      );
    });
  });

  describe('No arguments', () => {
    it('should return empty array for zero-argument call', async () => {
      const code = `foo();`;
      const callNode = await findCallNode(code, 'foo');
      assert.ok(callNode, 'foo CALL node should exist');
      assert.deepStrictEqual(
        callNode.metadata.argValues,
        [],
        'argValues should be empty for zero-arg call'
      );
    });
  });

  describe('Template literals', () => {
    it('should extract value from template literal with no expressions', async () => {
      const code = 'foo(`/api/v1`);';
      const callNode = await findCallNode(code, 'foo');
      assert.ok(callNode, 'foo CALL node should exist');
      assert.deepStrictEqual(
        callNode.metadata.argValues,
        ['/api/v1'],
        'argValues should extract template literal without expressions'
      );
    });

    it('should return null for template literal with expressions', async () => {
      const code = 'foo(`/api/${v}`);';
      const callNode = await findCallNode(code, 'foo');
      assert.ok(callNode, 'foo CALL node should exist');
      assert.deepStrictEqual(
        callNode.metadata.argValues,
        [null],
        'argValues should be null for template literal with expressions'
      );
    });
  });

  describe('Numeric and boolean arguments', () => {
    it('should return null for numeric and boolean arguments', async () => {
      const code = `foo(42, true);`;
      const callNode = await findCallNode(code, 'foo');
      assert.ok(callNode, 'foo CALL node should exist');
      assert.deepStrictEqual(
        callNode.metadata.argValues,
        [null, null],
        'argValues should be null for numeric and boolean literals'
      );
    });
  });

  describe('All non-string arguments', () => {
    it('should return all nulls for identifier-only arguments', async () => {
      const code = `foo(x, y, z);`;
      const callNode = await findCallNode(code, 'foo');
      assert.ok(callNode, 'foo CALL node should exist');
      assert.deepStrictEqual(
        callNode.metadata.argValues,
        [null, null, null],
        'argValues should be all nulls for identifier arguments'
      );
    });
  });

  describe('Method call with string first argument', () => {
    it('should extract argValues from method calls like app.get', async () => {
      const code = `app.get('/users', handler);`;
      const callNode = await findCallNodeByPattern(code, 'app.get');
      assert.ok(callNode, 'app.get CALL node should exist');
      assert.deepStrictEqual(
        callNode.metadata.argValues,
        ['/users', null],
        'argValues should extract route path from method call'
      );
      // Verify existing metadata fields are preserved
      assert.equal(callNode.metadata.method, 'get', 'method metadata preserved');
      assert.equal(callNode.metadata.object, 'app', 'object metadata preserved');
    });
  });

  describe('argValues array length invariant', () => {
    it('should always have length equal to argument count', async () => {
      const testCases = [
        { code: `f();`, name: 'f', expectedLen: 0 },
        { code: `f(a);`, name: 'f', expectedLen: 1 },
        { code: `f(a, b, c, d, e);`, name: 'f', expectedLen: 5 },
        { code: `f('a', 'b', 'c');`, name: 'f', expectedLen: 3 },
      ];

      for (const tc of testCases) {
        const callNode = await findCallNode(tc.code, tc.name);
        assert.ok(callNode, `${tc.name} CALL node should exist for: ${tc.code}`);
        assert.equal(
          callNode.metadata.argValues.length,
          tc.expectedLen,
          `argValues.length should be ${tc.expectedLen} for ${tc.code}`
        );
      }
    });
  });
});

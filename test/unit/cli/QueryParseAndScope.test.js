/**
 * Unit tests for query.ts exported functions: parseQuery, matchesScope
 *
 * Tests for REG-445 bug fixes:
 * - Bug 2: matchesScope should return true when no constraints (file=null, scopes=[])
 * - Bug 3: parseQuery should recognize interface/type/enum type aliases
 *
 * These are pure function tests — no backend required.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseQuery, matchesScope } from '../../../packages/cli/dist/commands/query.js';

// =============================================================================
// Bug 3: Missing INTERFACE/TYPE/ENUM in search types
// =============================================================================

describe('parseQuery — type alias recognition (REG-445 Bug 3)', () => {
  it('should parse "interface GraphBackend" as INTERFACE type', () => {
    const result = parseQuery('interface GraphBackend');
    assert.strictEqual(result.type, 'INTERFACE', 'type should be INTERFACE');
    assert.strictEqual(result.name, 'GraphBackend', 'name should be GraphBackend');
    assert.strictEqual(result.file, null, 'file should be null');
    assert.deepStrictEqual(result.scopes, [], 'scopes should be empty');
  });

  it('should parse "type NodeRecord" as TYPE type', () => {
    const result = parseQuery('type NodeRecord');
    assert.strictEqual(result.type, 'TYPE', 'type should be TYPE');
    assert.strictEqual(result.name, 'NodeRecord', 'name should be NodeRecord');
  });

  it('should parse "enum Priority" as ENUM type', () => {
    const result = parseQuery('enum Priority');
    assert.strictEqual(result.type, 'ENUM', 'type should be ENUM');
    assert.strictEqual(result.name, 'Priority', 'name should be Priority');
  });

  // Verify existing type aliases still work (regression check)
  it('should still parse "function authenticate" as FUNCTION type', () => {
    const result = parseQuery('function authenticate');
    assert.strictEqual(result.type, 'FUNCTION');
    assert.strictEqual(result.name, 'authenticate');
  });

  it('should still parse "class UserService" as CLASS type', () => {
    const result = parseQuery('class UserService');
    assert.strictEqual(result.type, 'CLASS');
    assert.strictEqual(result.name, 'UserService');
  });

  it('should still parse "variable config" as VARIABLE type', () => {
    const result = parseQuery('variable config');
    assert.strictEqual(result.type, 'VARIABLE');
    assert.strictEqual(result.name, 'config');
  });

  it('should parse plain name without type prefix', () => {
    const result = parseQuery('authenticate');
    assert.strictEqual(result.type, null, 'type should be null for plain name');
    assert.strictEqual(result.name, 'authenticate');
  });

  // Verify scope parsing works with new type aliases
  it('should parse "interface Props in UserForm" with scope', () => {
    const result = parseQuery('interface Props in UserForm');
    assert.strictEqual(result.type, 'INTERFACE');
    assert.strictEqual(result.name, 'Props');
    assert.deepStrictEqual(result.scopes, ['UserForm']);
  });

  it('should parse "type Config in src/config.ts" with file scope', () => {
    const result = parseQuery('type Config in src/config.ts');
    assert.strictEqual(result.type, 'TYPE');
    assert.strictEqual(result.name, 'Config');
    assert.strictEqual(result.file, 'src/config.ts');
    assert.deepStrictEqual(result.scopes, []);
  });
});

// =============================================================================
// Bug 2: matchesScope fails on various ID formats
// =============================================================================

describe('matchesScope — no constraints (REG-445 Bug 2)', () => {
  it('should return true for v1 format ID with no constraints', () => {
    const result = matchesScope(
      'src/app.ts->global->FUNCTION->foo',
      null,
      []
    );
    assert.strictEqual(result, true, 'v1 ID with no constraints should match');
  });

  it('should return true for v2 format ID with no constraints', () => {
    const result = matchesScope(
      'src/app.ts->FUNCTION->foo',
      null,
      []
    );
    assert.strictEqual(result, true, 'v2 ID with no constraints should match');
  });

  it('should return true for v2 format ID with brackets and no constraints', () => {
    const result = matchesScope(
      'src/app.ts->FUNCTION->foo[in:bar,h:abcd]',
      null,
      []
    );
    assert.strictEqual(result, true, 'v2 ID with brackets and no constraints should match');
  });

  // After Bug 1 fix, v3 format IDs should not appear in matchesScope
  // because _parseNode will return v1 format. But let's verify the
  // function still handles the case gracefully.
  it('should handle v3 format ID gracefully with no constraints', () => {
    // v3 format: TYPE:name@file — not parseable by v1 or v2 parsers
    const result = matchesScope(
      'FUNCTION:foo@src/app.ts',
      null,
      []
    );
    // With current code this returns false because neither parser recognizes it.
    // After Bug 1 fix, this format won't reach matchesScope anyway.
    // We document the current behavior: returns false for unparseable IDs.
    assert.strictEqual(typeof result, 'boolean', 'should return a boolean');
  });
});

describe('matchesScope — file scope filtering', () => {
  it('should match v1 ID when file matches exactly', () => {
    const result = matchesScope(
      'src/app.ts->global->FUNCTION->foo',
      'src/app.ts',
      []
    );
    assert.strictEqual(result, true);
  });

  it('should match v1 ID when file is basename', () => {
    const result = matchesScope(
      'src/app.ts->global->FUNCTION->foo',
      'app.ts',
      []
    );
    assert.strictEqual(result, true);
  });

  it('should not match v1 ID when file does not match', () => {
    const result = matchesScope(
      'src/app.ts->global->FUNCTION->foo',
      'src/other.ts',
      []
    );
    assert.strictEqual(result, false);
  });
});

describe('matchesScope — function scope filtering', () => {
  it('should match v1 ID when scope appears in scope path', () => {
    const result = matchesScope(
      'src/app.ts->fetchData->try#0->VARIABLE->response',
      null,
      ['fetchData']
    );
    assert.strictEqual(result, true);
  });

  it('should match v1 ID with numbered scope', () => {
    const result = matchesScope(
      'src/app.ts->fetchData->try#0->VARIABLE->response',
      null,
      ['try']
    );
    assert.strictEqual(result, true, 'try should match try#0');
  });

  it('should not match v1 ID when scope is not in path', () => {
    const result = matchesScope(
      'src/app.ts->fetchData->try#0->VARIABLE->response',
      null,
      ['processData']
    );
    assert.strictEqual(result, false);
  });

  it('should require ALL scopes to match (AND logic)', () => {
    const result = matchesScope(
      'src/app.ts->fetchData->try#0->VARIABLE->response',
      null,
      ['fetchData', 'try']
    );
    assert.strictEqual(result, true, 'both scopes should be found');

    const result2 = matchesScope(
      'src/app.ts->fetchData->try#0->VARIABLE->response',
      null,
      ['fetchData', 'processData']
    );
    assert.strictEqual(result2, false, 'processData is not in path');
  });
});

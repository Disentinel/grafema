/**
 * Tests for PARAMETER node column positions (REG-550)
 *
 * Verifies that createParameterNodes produces correct `column` values
 * for all parameter types: simple identifiers, default values, rest,
 * object destructuring, and array destructuring.
 *
 * These tests call createParameterNodes directly with mock Babel AST nodes,
 * avoiding the overhead of full project analysis.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { ScopeTracker } from '@grafema/core';
import { createParameterNodes } from '../../packages/core/dist/plugins/analysis/ast/utils/createParameterNodes.js';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a minimal ScopeTracker positioned inside a function scope.
 * createParameterNodes uses scopeTracker.getContext() and getNamedParent().
 */
function makeScopeTracker() {
  const st = new ScopeTracker('test.js');
  st.enterScope('testFunc', 'FUNCTION');
  return st;
}

/**
 * Build a mock Babel Identifier node with precise loc.
 */
function makeIdentifier(name, line, column) {
  return {
    type: 'Identifier',
    name,
    loc: { start: { line, column } }
  };
}

/**
 * Build a mock Babel AssignmentPattern node (default param).
 * The `left` is the identifier, `right` is the default value.
 */
function makeAssignmentPattern(leftNode, rightNode) {
  return {
    type: 'AssignmentPattern',
    left: leftNode,
    right: rightNode || { type: 'ObjectExpression', properties: [] },
    loc: leftNode.loc
  };
}

/**
 * Build a mock Babel RestElement node.
 * The `argument` is the identifier after `...`.
 */
function makeRestElement(argumentNode) {
  return {
    type: 'RestElement',
    argument: argumentNode,
    loc: argumentNode.loc
  };
}

/**
 * Build a mock Babel ObjectPattern node.
 * Properties are ObjectProperty nodes wrapping value nodes.
 */
function makeObjectPattern(properties, line, column) {
  return {
    type: 'ObjectPattern',
    properties,
    loc: { start: { line: line || 1, column: column || 0 } }
  };
}

/**
 * Build a mock ObjectProperty for { key: value } patterns.
 * For shorthand { x }, key and value are both identifiers with the same name.
 */
function makeObjectProperty(keyName, valueNode, keyLine, keyColumn) {
  return {
    type: 'ObjectProperty',
    key: { type: 'Identifier', name: keyName, loc: { start: { line: keyLine || 1, column: keyColumn || 0 } } },
    value: valueNode,
    computed: false,
    shorthand: false
  };
}

/**
 * Build a mock Babel ArrayPattern node.
 */
function makeArrayPattern(elements, line, column) {
  return {
    type: 'ArrayPattern',
    elements,
    loc: { start: { line: line || 1, column: column || 0 } }
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('createParameterNodes — column positions (REG-550)', () => {
  let scopeTracker;
  let parameters;

  beforeEach(() => {
    scopeTracker = makeScopeTracker();
    parameters = [];
  });

  // -------------------------------------------------------------------------
  // Simple Identifier parameters
  // -------------------------------------------------------------------------

  it('should store correct column for simple identifier params', () => {
    // function foo(p, q) {
    // columns:     13 16
    const params = [
      makeIdentifier('p', 1, 13),
      makeIdentifier('q', 1, 16)
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const pParam = parameters.find(p => p.name === 'p');
    const qParam = parameters.find(p => p.name === 'q');

    assert.ok(pParam, 'Should have PARAMETER node for p');
    assert.ok(qParam, 'Should have PARAMETER node for q');
    assert.strictEqual(pParam.column, 13, 'p should be at column 13');
    assert.strictEqual(qParam.column, 16, 'q should be at column 16');
  });

  // -------------------------------------------------------------------------
  // Default value parameter (AssignmentPattern with Identifier left)
  // -------------------------------------------------------------------------

  it('should store correct column for default value param (identifier before =)', () => {
    // function foo(options = {}) {
    // column:      13
    const params = [
      makeAssignmentPattern(
        makeIdentifier('options', 1, 13),
        { type: 'ObjectExpression', properties: [] }
      )
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const optionsParam = parameters.find(p => p.name === 'options');
    assert.ok(optionsParam, 'Should have PARAMETER node for options');
    assert.strictEqual(optionsParam.column, 13, 'options should be at column 13');
  });

  // -------------------------------------------------------------------------
  // Rest parameter
  // -------------------------------------------------------------------------

  it('should store correct column for rest param (identifier after ...)', () => {
    // function foo(...args) {
    // column:        16
    const params = [
      makeRestElement(makeIdentifier('args', 1, 16))
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const argsParam = parameters.find(p => p.name === 'args');
    assert.ok(argsParam, 'Should have PARAMETER node for args');
    assert.strictEqual(argsParam.column, 16, 'args should be at column 16');
    assert.strictEqual(argsParam.isRest, true, 'args should be marked as rest');
  });

  // -------------------------------------------------------------------------
  // Object destructuring
  // -------------------------------------------------------------------------

  it('should store correct column for each property in object destructuring', () => {
    // function foo({ x, y }) {
    // columns:       15 18
    const params = [
      makeObjectPattern([
        makeObjectProperty('x', makeIdentifier('x', 1, 15), 1, 15),
        makeObjectProperty('y', makeIdentifier('y', 1, 18), 1, 18)
      ], 1, 13)
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const xParam = parameters.find(p => p.name === 'x');
    const yParam = parameters.find(p => p.name === 'y');

    assert.ok(xParam, 'Should have PARAMETER node for x');
    assert.ok(yParam, 'Should have PARAMETER node for y');
    assert.strictEqual(xParam.column, 15, 'x should be at column 15');
    assert.strictEqual(yParam.column, 18, 'y should be at column 18');
  });

  // -------------------------------------------------------------------------
  // Array destructuring
  // -------------------------------------------------------------------------

  it('should store correct column for array destructured params', () => {
    // function foo([first, second]) {
    // columns:      14     21
    const params = [
      makeArrayPattern([
        makeIdentifier('first', 1, 14),
        makeIdentifier('second', 1, 21)
      ], 1, 13)
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const firstParam = parameters.find(p => p.name === 'first');
    const secondParam = parameters.find(p => p.name === 'second');

    assert.ok(firstParam, 'Should have PARAMETER node for first');
    assert.ok(secondParam, 'Should have PARAMETER node for second');
    assert.strictEqual(firstParam.column, 14, 'first should be at column 14');
    assert.strictEqual(secondParam.column, 21, 'second should be at column 21');
  });

  // -------------------------------------------------------------------------
  // Renamed destructured param: { old: newName }
  // -------------------------------------------------------------------------

  it('should store correct column for renamed destructured param', () => {
    // function foo({ old: newName }) {
    // column:              20
    const params = [
      makeObjectPattern([
        makeObjectProperty('old', makeIdentifier('newName', 1, 20), 1, 15)
      ], 1, 13)
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const newNameParam = parameters.find(p => p.name === 'newName');
    assert.ok(newNameParam, 'Should have PARAMETER node for newName');
    assert.strictEqual(newNameParam.column, 20, 'newName should be at column 20');
  });

  // -------------------------------------------------------------------------
  // Nested destructured param: { data: { user } }
  // -------------------------------------------------------------------------

  it('should store correct column for nested destructured param', () => {
    // function foo({ data: { user } }) {
    // column:                23
    const params = [
      makeObjectPattern([
        makeObjectProperty('data',
          makeObjectPattern([
            makeObjectProperty('user', makeIdentifier('user', 1, 23), 1, 23)
          ], 1, 21),
          1, 15
        )
      ], 1, 13)
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const userParam = parameters.find(p => p.name === 'user');
    assert.ok(userParam, 'Should have PARAMETER node for user');
    assert.strictEqual(userParam.column, 23, 'user should be at column 23');
  });

  // -------------------------------------------------------------------------
  // Destructured param with default: { x = 42 }
  // -------------------------------------------------------------------------

  it('should store correct column for destructured param with default value', () => {
    // function foo({ x = 42 }) {
    // column:        15
    const params = [
      makeObjectPattern([
        makeObjectProperty('x',
          makeAssignmentPattern(
            makeIdentifier('x', 1, 15),
            { type: 'NumericLiteral', value: 42 }
          ),
          1, 15
        )
      ], 1, 13)
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const xParam = parameters.find(p => p.name === 'x');
    assert.ok(xParam, 'Should have PARAMETER node for x');
    assert.strictEqual(xParam.column, 15, 'x should be at column 15');
  });

  // -------------------------------------------------------------------------
  // Mixed simple + destructured: (a, { b, c }, d)
  // -------------------------------------------------------------------------

  it('should store correct column for mixed simple and destructured params', () => {
    // function foo(a, { b, c }, d) {
    // columns:     13  18 21   26
    const params = [
      makeIdentifier('a', 1, 13),
      makeObjectPattern([
        makeObjectProperty('b', makeIdentifier('b', 1, 18), 1, 18),
        makeObjectProperty('c', makeIdentifier('c', 1, 21), 1, 21)
      ], 1, 16),
      makeIdentifier('d', 1, 26)
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const aParam = parameters.find(p => p.name === 'a');
    const bParam = parameters.find(p => p.name === 'b');
    const cParam = parameters.find(p => p.name === 'c');
    const dParam = parameters.find(p => p.name === 'd');

    assert.ok(aParam, 'Should have PARAMETER node for a');
    assert.ok(bParam, 'Should have PARAMETER node for b');
    assert.ok(cParam, 'Should have PARAMETER node for c');
    assert.ok(dParam, 'Should have PARAMETER node for d');

    assert.strictEqual(aParam.column, 13, 'a should be at column 13');
    assert.strictEqual(bParam.column, 18, 'b should be at column 18');
    assert.strictEqual(cParam.column, 21, 'c should be at column 21');
    assert.strictEqual(dParam.column, 26, 'd should be at column 26');
  });

  // -------------------------------------------------------------------------
  // Pattern-level default: ({ x, y } = {})
  // -------------------------------------------------------------------------

  it('should store correct column for pattern-level default params', () => {
    // function foo({ x, y } = {}) {
    // columns:       15 18
    const params = [
      makeAssignmentPattern(
        makeObjectPattern([
          makeObjectProperty('x', makeIdentifier('x', 1, 15), 1, 15),
          makeObjectProperty('y', makeIdentifier('y', 1, 18), 1, 18)
        ], 1, 13),
        { type: 'ObjectExpression', properties: [] }
      )
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const xParam = parameters.find(p => p.name === 'x');
    const yParam = parameters.find(p => p.name === 'y');

    assert.ok(xParam, 'Should have PARAMETER node for x');
    assert.ok(yParam, 'Should have PARAMETER node for y');
    assert.strictEqual(xParam.column, 15, 'x should be at column 15');
    assert.strictEqual(yParam.column, 18, 'y should be at column 18');
  });

  // -------------------------------------------------------------------------
  // Rest in destructuring: ({ a, ...rest })
  // -------------------------------------------------------------------------

  it('should store correct column for rest in destructuring', () => {
    // function foo({ a, ...rest }) {
    // columns:       15    21
    const restIdent = makeIdentifier('rest', 1, 21);
    const params = [
      makeObjectPattern([
        makeObjectProperty('a', makeIdentifier('a', 1, 15), 1, 15),
        makeRestElement(restIdent)
      ], 1, 13)
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const aParam = parameters.find(p => p.name === 'a');
    const restParam = parameters.find(p => p.name === 'rest');

    assert.ok(aParam, 'Should have PARAMETER node for a');
    assert.ok(restParam, 'Should have PARAMETER node for rest');
    assert.strictEqual(aParam.column, 15, 'a should be at column 15');
    assert.strictEqual(restParam.column, 21, 'rest should be at column 21');
  });

  // -------------------------------------------------------------------------
  // Column is a number, not undefined
  // -------------------------------------------------------------------------

  it('should store column as a number, not undefined', () => {
    const params = [
      makeIdentifier('x', 1, 13)
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const xParam = parameters.find(p => p.name === 'x');
    assert.ok(xParam, 'Should have PARAMETER node for x');
    assert.strictEqual(typeof xParam.column, 'number', 'column should be a number');
  });

  // -------------------------------------------------------------------------
  // Column zero is valid (not falsy-coerced)
  // -------------------------------------------------------------------------

  it('should handle column 0 correctly (not falsy-coerced)', () => {
    // A parameter at the very start of the line
    const params = [
      makeIdentifier('x', 1, 0)
    ];

    createParameterNodes(params, 'fn-id', 'test.js', 1, parameters, scopeTracker);

    const xParam = parameters.find(p => p.name === 'x');
    assert.ok(xParam, 'Should have PARAMETER node for x');
    assert.strictEqual(xParam.column, 0, 'column 0 should be preserved, not coerced');
  });
});

/**
 * Location Utilities Tests (REG-122)
 *
 * Tests for the location extraction utilities that provide defensive
 * checks for AST node location access.
 *
 * Convention: 0:0 means "unknown location" when AST node lacks position data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  getNodeLocation,
  getLine,
  getColumn,
  getEndLocation,
  UNKNOWN_LOCATION,
  type NodeLocation
} from '@grafema/core';

// =============================================================================
// Helper: Create mock AST nodes
// =============================================================================

type MockNode = {
  type: string;
  name?: string;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  } | null;
};

function createNodeWithLoc(
  startLine: number,
  startCol: number,
  endLine?: number,
  endCol?: number
): MockNode {
  return {
    type: 'Identifier',
    name: 'test',
    loc: {
      start: { line: startLine, column: startCol },
      end: { line: endLine ?? startLine, column: endCol ?? startCol }
    }
  };
}

function createNodeWithoutLoc(): MockNode {
  return {
    type: 'Identifier',
    name: 'test'
  };
}

function createNodeWithNullLoc(): MockNode {
  return {
    type: 'Identifier',
    name: 'test',
    loc: null
  };
}

// =============================================================================
// TESTS: UNKNOWN_LOCATION constant
// =============================================================================

describe('location utilities (REG-122)', () => {
  describe('UNKNOWN_LOCATION', () => {
    it('should be { line: 0, column: 0 }', () => {
      assert.deepStrictEqual(UNKNOWN_LOCATION, { line: 0, column: 0 });
    });

    it('should be const (readonly)', () => {
      // TypeScript prevents modification at compile time
      // At runtime, we just verify the structure
      assert.strictEqual(UNKNOWN_LOCATION.line, 0);
      assert.strictEqual(UNKNOWN_LOCATION.column, 0);
    });
  });

  // ===========================================================================
  // TESTS: getNodeLocation
  // ===========================================================================

  describe('getNodeLocation', () => {
    it('should extract line and column from valid node', () => {
      const node = createNodeWithLoc(10, 5);
      const loc = getNodeLocation(node as unknown as import('@babel/types').Node);
      assert.strictEqual(loc.line, 10);
      assert.strictEqual(loc.column, 5);
    });

    it('should return 0:0 for null node', () => {
      const loc = getNodeLocation(null);
      assert.strictEqual(loc.line, 0);
      assert.strictEqual(loc.column, 0);
    });

    it('should return 0:0 for undefined node', () => {
      const loc = getNodeLocation(undefined);
      assert.strictEqual(loc.line, 0);
      assert.strictEqual(loc.column, 0);
    });

    it('should return 0:0 for node without loc property', () => {
      const node = createNodeWithoutLoc();
      const loc = getNodeLocation(node as unknown as import('@babel/types').Node);
      assert.strictEqual(loc.line, 0);
      assert.strictEqual(loc.column, 0);
    });

    it('should return 0:0 for node with null loc', () => {
      const node = createNodeWithNullLoc();
      const loc = getNodeLocation(node as unknown as import('@babel/types').Node);
      assert.strictEqual(loc.line, 0);
      assert.strictEqual(loc.column, 0);
    });

    it('should handle line 1, column 0 (first position)', () => {
      const node = createNodeWithLoc(1, 0);
      const loc = getNodeLocation(node as unknown as import('@babel/types').Node);
      assert.strictEqual(loc.line, 1);
      assert.strictEqual(loc.column, 0);
    });

    it('should handle large line numbers', () => {
      const node = createNodeWithLoc(99999, 500);
      const loc = getNodeLocation(node as unknown as import('@babel/types').Node);
      assert.strictEqual(loc.line, 99999);
      assert.strictEqual(loc.column, 500);
    });

    it('should return readonly NodeLocation', () => {
      const node = createNodeWithLoc(10, 5);
      const loc: NodeLocation = getNodeLocation(node as unknown as import('@babel/types').Node);
      // TypeScript should enforce readonly at compile time
      assert.ok(typeof loc.line === 'number');
      assert.ok(typeof loc.column === 'number');
    });
  });

  // ===========================================================================
  // TESTS: getLine
  // ===========================================================================

  describe('getLine', () => {
    it('should extract line from valid node', () => {
      const node = createNodeWithLoc(42, 10);
      assert.strictEqual(getLine(node as unknown as import('@babel/types').Node), 42);
    });

    it('should return 0 for null node', () => {
      assert.strictEqual(getLine(null), 0);
    });

    it('should return 0 for undefined node', () => {
      assert.strictEqual(getLine(undefined), 0);
    });

    it('should return 0 for node without loc', () => {
      const node = createNodeWithoutLoc();
      assert.strictEqual(getLine(node as unknown as import('@babel/types').Node), 0);
    });

    it('should return 0 for node with null loc', () => {
      const node = createNodeWithNullLoc();
      assert.strictEqual(getLine(node as unknown as import('@babel/types').Node), 0);
    });

    it('should handle line 1 (first line)', () => {
      const node = createNodeWithLoc(1, 0);
      assert.strictEqual(getLine(node as unknown as import('@babel/types').Node), 1);
    });
  });

  // ===========================================================================
  // TESTS: getColumn
  // ===========================================================================

  describe('getColumn', () => {
    it('should extract column from valid node', () => {
      const node = createNodeWithLoc(1, 25);
      assert.strictEqual(getColumn(node as unknown as import('@babel/types').Node), 25);
    });

    it('should return 0 for null node', () => {
      assert.strictEqual(getColumn(null), 0);
    });

    it('should return 0 for undefined node', () => {
      assert.strictEqual(getColumn(undefined), 0);
    });

    it('should return 0 for node without loc', () => {
      const node = createNodeWithoutLoc();
      assert.strictEqual(getColumn(node as unknown as import('@babel/types').Node), 0);
    });

    it('should handle column 0 correctly (not falsy)', () => {
      const node = createNodeWithLoc(1, 0);
      // Column 0 is valid - should not be treated as falsy
      assert.strictEqual(getColumn(node as unknown as import('@babel/types').Node), 0);
    });
  });

  // ===========================================================================
  // TESTS: getEndLocation
  // ===========================================================================

  describe('getEndLocation', () => {
    it('should extract end location from valid node', () => {
      const node = createNodeWithLoc(10, 5, 15, 20);
      const loc = getEndLocation(node as unknown as import('@babel/types').Node);
      assert.strictEqual(loc.line, 15);
      assert.strictEqual(loc.column, 20);
    });

    it('should return 0:0 for null node', () => {
      const loc = getEndLocation(null);
      assert.strictEqual(loc.line, 0);
      assert.strictEqual(loc.column, 0);
    });

    it('should return 0:0 for undefined node', () => {
      const loc = getEndLocation(undefined);
      assert.strictEqual(loc.line, 0);
      assert.strictEqual(loc.column, 0);
    });

    it('should return 0:0 for node without loc', () => {
      const node = createNodeWithoutLoc();
      const loc = getEndLocation(node as unknown as import('@babel/types').Node);
      assert.strictEqual(loc.line, 0);
      assert.strictEqual(loc.column, 0);
    });

    it('should handle same start and end (single character)', () => {
      const node = createNodeWithLoc(5, 10, 5, 11);
      const loc = getEndLocation(node as unknown as import('@babel/types').Node);
      assert.strictEqual(loc.line, 5);
      assert.strictEqual(loc.column, 11);
    });
  });

  // ===========================================================================
  // TESTS: Edge cases and consistency
  // ===========================================================================

  describe('edge cases', () => {
    it('should be consistent: getNodeLocation vs getLine + getColumn', () => {
      const node = createNodeWithLoc(100, 50);
      const babelNode = node as unknown as import('@babel/types').Node;
      const fullLoc = getNodeLocation(babelNode);
      const line = getLine(babelNode);
      const column = getColumn(babelNode);

      assert.strictEqual(fullLoc.line, line);
      assert.strictEqual(fullLoc.column, column);
    });

    it('should handle undefined start in loc (defensive)', () => {
      const node = {
        type: 'Identifier',
        name: 'test',
        loc: {} // loc exists but start is undefined
      };
      const loc = getNodeLocation(node as unknown as import('@babel/types').Node);
      assert.strictEqual(loc.line, 0);
      assert.strictEqual(loc.column, 0);
    });

    it('should handle partial start in loc (only line)', () => {
      const node = {
        type: 'Identifier',
        name: 'test',
        loc: {
          start: { line: 10 } // column is undefined
        }
      };
      const loc = getNodeLocation(node as unknown as import('@babel/types').Node);
      assert.strictEqual(loc.line, 10);
      assert.strictEqual(loc.column, 0); // Fallback for undefined column
    });
  });

  // ===========================================================================
  // TESTS: Type safety
  // ===========================================================================

  describe('type safety', () => {
    it('should return number, not number | undefined', () => {
      const node = createNodeWithoutLoc();
      const babelNode = node as unknown as import('@babel/types').Node;

      const line: number = getLine(babelNode);
      const column: number = getColumn(babelNode);
      const loc: NodeLocation = getNodeLocation(babelNode);

      // These should compile - no undefined possible
      assert.strictEqual(typeof line, 'number');
      assert.strictEqual(typeof column, 'number');
      assert.strictEqual(typeof loc.line, 'number');
      assert.strictEqual(typeof loc.column, 'number');
    });
  });
});

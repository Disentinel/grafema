/**
 * ArgumentExpression Tests
 *
 * Tests for ArgumentExpressionNode - EXPRESSION nodes with call argument context.
 * These tests define the expected behavior before implementation (TDD).
 *
 * ArgumentExpression extends ExpressionNode with parentCallId and argIndex fields
 * for tracking which call and argument position this expression appears in.
 *
 * TDD: These tests will FAIL initially - implementation comes after.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Note: These imports will fail until ArgumentExpressionNode is implemented
// This is expected TDD behavior - tests define the contract first
let ArgumentExpressionNode, NodeFactory, ExpressionNode;
try {
  const core = await import('@grafema/core');
  ArgumentExpressionNode = core.ArgumentExpressionNode;
  NodeFactory = core.NodeFactory;
  ExpressionNode = core.ExpressionNode;
} catch (e) {
  // Expected to fail before implementation
}

describe('ArgumentExpressionNode', () => {
  describe('ArgumentExpressionNode.create()', () => {
    it('should create ArgumentExpression with required fields', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      const node = ArgumentExpressionNode.create(
        'BinaryExpression',
        '/src/app.js',
        25,
        10,
        {
          parentCallId: '/src/app.js:CALL_SITE:execute:20:5',
          argIndex: 0,
          operator: '+'
        }
      );

      assert.strictEqual(node.type, 'EXPRESSION');
      assert.strictEqual(node.expressionType, 'BinaryExpression');
      assert.strictEqual(node.file, '/src/app.js');
      assert.strictEqual(node.line, 25);
      assert.strictEqual(node.column, 10);
      assert.strictEqual(node.operator, '+');
      assert.strictEqual(node.parentCallId, '/src/app.js:CALL_SITE:execute:20:5');
      assert.strictEqual(node.argIndex, 0);
    });

    it('should generate ID in colon format', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      const node = ArgumentExpressionNode.create(
        'BinaryExpression',
        '/src/app.js',
        25,
        10,
        {
          parentCallId: '/src/app.js:CALL_SITE:execute:20:5',
          argIndex: 0
        }
      );

      // ID should use colon format: {file}:EXPRESSION:{expressionType}:{line}:{column}
      assert.strictEqual(node.id, '/src/app.js:EXPRESSION:BinaryExpression:25:10');
      assert.ok(node.id.includes(':EXPRESSION:'));
      assert.ok(!node.id.includes('EXPRESSION#'));
    });

    it('should generate ID with counter suffix when provided', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      const node = ArgumentExpressionNode.create(
        'BinaryExpression',
        '/src/app.js',
        25,
        10,
        {
          parentCallId: '/src/app.js:CALL_SITE:execute:20:5',
          argIndex: 0,
          counter: 3
        }
      );

      // Counter should be appended to ID for disambiguation
      assert.strictEqual(node.id, '/src/app.js:EXPRESSION:BinaryExpression:25:10:3');
    });

    it('should throw error if parentCallId is missing', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      assert.throws(() => {
        ArgumentExpressionNode.create(
          'BinaryExpression',
          '/src/app.js',
          25,
          10,
          {
            argIndex: 0  // Missing parentCallId
          }
        );
      }, /parentCallId is required/);
    });

    it('should throw error if argIndex is missing', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      assert.throws(() => {
        ArgumentExpressionNode.create(
          'BinaryExpression',
          '/src/app.js',
          25,
          10,
          {
            parentCallId: '/src/app.js:CALL_SITE:execute:20:5'
            // Missing argIndex
          }
        );
      }, /argIndex is required/);
    });

    it('should accept argIndex: 0 as valid', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      const node = ArgumentExpressionNode.create(
        'BinaryExpression',
        '/src/app.js',
        25,
        10,
        {
          parentCallId: '/src/app.js:CALL_SITE:execute:20:5',
          argIndex: 0
        }
      );

      assert.strictEqual(node.argIndex, 0);
    });

    it('should inherit base ExpressionNode validation', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      // Should validate expressionType requirement
      assert.throws(() => {
        ArgumentExpressionNode.create(
          '',  // Empty expressionType
          '/src/app.js',
          25,
          10,
          {
            parentCallId: '/src/app.js:CALL_SITE:execute:20:5',
            argIndex: 0
          }
        );
      }, /expressionType is required/);

      // Should validate file requirement
      assert.throws(() => {
        ArgumentExpressionNode.create(
          'BinaryExpression',
          '',  // Empty file
          25,
          10,
          {
            parentCallId: '/src/app.js:CALL_SITE:execute:20:5',
            argIndex: 0
          }
        );
      }, /file is required/);
    });

    it('should support all ExpressionNode optional fields', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      const node = ArgumentExpressionNode.create(
        'MemberExpression',
        '/src/app.js',
        30,
        15,
        {
          parentCallId: '/src/app.js:CALL_SITE:execute:20:5',
          argIndex: 1,
          object: 'obj',
          property: 'method',
          computed: false,
          path: 'obj.method'
        }
      );

      assert.strictEqual(node.object, 'obj');
      assert.strictEqual(node.property, 'method');
      assert.strictEqual(node.computed, false);
      assert.strictEqual(node.path, 'obj.method');
    });
  });

  describe('ArgumentExpressionNode.validate()', () => {
    it('should validate required fields', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      const invalidNode = {
        id: '/src/app.js:EXPRESSION:BinaryExpression:25:10',
        type: 'EXPRESSION',
        expressionType: 'BinaryExpression',
        file: '/src/app.js',
        line: 25,
        column: 10,
        name: 'BinaryExpression'
        // Missing parentCallId and argIndex
      };

      const errors = ArgumentExpressionNode.validate(invalidNode);

      assert.ok(errors.length > 0);
      assert.ok(errors.some(e => e.includes('parentCallId')));
      assert.ok(errors.some(e => e.includes('argIndex')));
    });

    it('should pass validation with all required fields', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      const validNode = {
        id: '/src/app.js:EXPRESSION:BinaryExpression:25:10',
        type: 'EXPRESSION',
        expressionType: 'BinaryExpression',
        file: '/src/app.js',
        line: 25,
        column: 10,
        name: 'BinaryExpression',
        operator: '+',
        parentCallId: '/src/app.js:CALL_SITE:execute:20:5',
        argIndex: 0
      };

      const errors = ArgumentExpressionNode.validate(validNode);

      assert.strictEqual(errors.length, 0);
    });

    it('should inherit base ExpressionNode validation errors', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      const invalidNode = {
        id: '/src/app.js:EXPRESSION:BinaryExpression:25:10',
        type: 'WRONG_TYPE',  // Invalid type
        expressionType: 'BinaryExpression',
        file: '/src/app.js',
        line: 25,
        column: 10,
        name: 'BinaryExpression',
        parentCallId: '/src/app.js:CALL_SITE:execute:20:5',
        argIndex: 0
      };

      const errors = ArgumentExpressionNode.validate(invalidNode);

      assert.ok(errors.length > 0);
      assert.ok(errors.some(e => e.includes('type')));
    });
  });

  describe('NodeFactory.createArgumentExpression()', () => {
    it('should create ArgumentExpression via NodeFactory', () => {
      if (!NodeFactory) {
        throw new Error('NodeFactory.createArgumentExpression not implemented yet (expected for TDD)');
      }

      const node = NodeFactory.createArgumentExpression(
        'LogicalExpression',
        '/src/app.js',
        40,
        20,
        {
          parentCallId: '/src/app.js:CALL_SITE:validate:35:10',
          argIndex: 1,
          operator: '&&'
        }
      );

      assert.strictEqual(node.type, 'EXPRESSION');
      assert.strictEqual(node.expressionType, 'LogicalExpression');
      assert.strictEqual(node.operator, '&&');
      assert.strictEqual(node.parentCallId, '/src/app.js:CALL_SITE:validate:35:10');
      assert.strictEqual(node.argIndex, 1);
    });

    it('should generate colon-based IDs via NodeFactory', () => {
      if (!NodeFactory) {
        throw new Error('NodeFactory.createArgumentExpression not implemented yet (expected for TDD)');
      }

      const node = NodeFactory.createArgumentExpression(
        'BinaryExpression',
        '/src/test.js',
        10,
        5,
        {
          parentCallId: '/src/test.js:CALL_SITE:run:8:2',
          argIndex: 0
        }
      );

      assert.ok(node.id.includes(':EXPRESSION:'));
      assert.ok(!node.id.includes('EXPRESSION#'));
      assert.strictEqual(node.id, '/src/test.js:EXPRESSION:BinaryExpression:10:5');
    });

    it('should delegate to ArgumentExpressionNode.create()', () => {
      if (!NodeFactory || !ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode/NodeFactory not implemented yet (expected for TDD)');
      }

      const options = {
        parentCallId: '/src/app.js:CALL_SITE:execute:20:5',
        argIndex: 2,
        operator: '||'
      };

      const factoryNode = NodeFactory.createArgumentExpression(
        'LogicalExpression',
        '/src/app.js',
        50,
        15,
        options
      );

      const directNode = ArgumentExpressionNode.create(
        'LogicalExpression',
        '/src/app.js',
        50,
        15,
        options
      );

      // Should produce identical results
      assert.deepStrictEqual(factoryNode, directNode);
    });
  });

  describe('ID format validation', () => {
    it('should use colon separator, not hash', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      const node = ArgumentExpressionNode.create(
        'BinaryExpression',
        '/src/app.js',
        25,
        10,
        {
          parentCallId: '/src/app.js:CALL_SITE:execute:20:5',
          argIndex: 0
        }
      );

      // ID format: {file}:EXPRESSION:{expressionType}:{line}:{column}
      assert.match(node.id, /^[^#]+:EXPRESSION:[^#]+:\d+:\d+$/);
      assert.ok(!node.id.includes('#'));
    });

    it('should place EXPRESSION as type marker in ID', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      const node = ArgumentExpressionNode.create(
        'LogicalExpression',
        '/src/test.js',
        15,
        8,
        {
          parentCallId: '/src/test.js:CALL_SITE:check:10:3',
          argIndex: 0
        }
      );

      const parts = node.id.split(':');
      assert.strictEqual(parts[1], 'EXPRESSION');
      assert.strictEqual(parts[2], 'LogicalExpression');
    });

    it('should preserve line and column in ID', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      const node = ArgumentExpressionNode.create(
        'BinaryExpression',
        '/src/app.js',
        123,
        456,
        {
          parentCallId: '/src/app.js:CALL_SITE:execute:100:10',
          argIndex: 0
        }
      );

      assert.ok(node.id.includes(':123:456'));
    });
  });

  describe('REQUIRED and OPTIONAL field constants', () => {
    it('should extend ExpressionNode.REQUIRED with ArgumentExpression fields', () => {
      if (!ArgumentExpressionNode || !ExpressionNode) {
        throw new Error('ArgumentExpressionNode/ExpressionNode not implemented yet (expected for TDD)');
      }

      // ArgumentExpression REQUIRED should include base fields + parentCallId, argIndex
      assert.ok(Array.isArray(ArgumentExpressionNode.REQUIRED));
      assert.ok(ArgumentExpressionNode.REQUIRED.includes('parentCallId'));
      assert.ok(ArgumentExpressionNode.REQUIRED.includes('argIndex'));

      // Should inherit base required fields
      assert.ok(ArgumentExpressionNode.REQUIRED.includes('expressionType'));
      assert.ok(ArgumentExpressionNode.REQUIRED.includes('file'));
      assert.ok(ArgumentExpressionNode.REQUIRED.includes('line'));
    });

    it('should extend ExpressionNode.OPTIONAL with counter field', () => {
      if (!ArgumentExpressionNode) {
        throw new Error('ArgumentExpressionNode not implemented yet (expected for TDD)');
      }

      assert.ok(Array.isArray(ArgumentExpressionNode.OPTIONAL));
      assert.ok(ArgumentExpressionNode.OPTIONAL.includes('counter'));
    });
  });
});

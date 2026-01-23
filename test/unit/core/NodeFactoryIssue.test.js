/**
 * NodeFactory.createIssue Tests
 *
 * TDD tests for NodeFactory.createIssue method (REG-95).
 *
 * Tests:
 * - createIssue() basic functionality
 * - Passing options/context to underlying IssueNode
 * - Integration with NodeFactory.validate()
 *
 * These tests define the contract - implementation follows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Note: This import will fail until createIssue is implemented.
// That's expected TDD behavior - tests first, implementation second.
import { NodeFactory } from '@grafema/core';

// =============================================================================
// NodeFactory.createIssue Tests
// =============================================================================

describe('NodeFactory.createIssue', () => {
  describe('Basic issue node creation', () => {
    it('should create issue node with required fields only', () => {
      const node = NodeFactory.createIssue(
        'security',         // category
        'error',            // severity
        'SQL injection vulnerability detected',  // message
        'SQLInjectionValidator',  // plugin
        '/src/db.js',       // file
        42,                 // line
        10                  // column
      );

      assert.strictEqual(node.type, 'issue:security');
      assert.strictEqual(node.category, 'security');
      assert.strictEqual(node.severity, 'error');
      assert.strictEqual(node.message, 'SQL injection vulnerability detected');
      assert.strictEqual(node.plugin, 'SQLInjectionValidator');
      assert.strictEqual(node.file, '/src/db.js');
      assert.strictEqual(node.line, 42);
      assert.strictEqual(node.column, 10);
      assert.ok(node.id.startsWith('issue:security#'));
    });

    it('should create issue node with default column', () => {
      const node = NodeFactory.createIssue(
        'performance',
        'warning',
        'Slow operation detected',
        'PerformanceChecker',
        '/src/slow.js',
        100
        // column omitted - should default to 0
      );

      assert.strictEqual(node.column, 0);
    });

    it('should create issue node with context option', () => {
      const context = {
        nondeterministicSources: ['request.body', 'userInput'],
        affectedQuery: 'SELECT * FROM users WHERE id = ?'
      };

      const node = NodeFactory.createIssue(
        'security',
        'error',
        'SQL injection detected',
        'SQLInjectionValidator',
        '/src/db.js',
        42,
        10,
        { context }
      );

      assert.deepStrictEqual(node.context, context);
    });
  });

  describe('Different issue types', () => {
    it('should create security issue', () => {
      const node = NodeFactory.createIssue(
        'security',
        'error',
        'Security vulnerability',
        'SecurityPlugin',
        '/src/app.js',
        10,
        0
      );

      assert.strictEqual(node.type, 'issue:security');
      assert.strictEqual(node.category, 'security');
    });

    it('should create performance issue', () => {
      const node = NodeFactory.createIssue(
        'performance',
        'warning',
        'Performance issue',
        'PerformancePlugin',
        '/src/app.js',
        10,
        0
      );

      assert.strictEqual(node.type, 'issue:performance');
      assert.strictEqual(node.category, 'performance');
    });

    it('should create style issue', () => {
      const node = NodeFactory.createIssue(
        'style',
        'info',
        'Style suggestion',
        'StylePlugin',
        '/src/app.js',
        10,
        0
      );

      assert.strictEqual(node.type, 'issue:style');
      assert.strictEqual(node.category, 'style');
    });

    it('should create smell issue', () => {
      const node = NodeFactory.createIssue(
        'smell',
        'warning',
        'Code smell detected',
        'SmellPlugin',
        '/src/app.js',
        10,
        0
      );

      assert.strictEqual(node.type, 'issue:smell');
      assert.strictEqual(node.category, 'smell');
    });

    it('should create custom category issue', () => {
      const node = NodeFactory.createIssue(
        'custom-lint-rule',
        'info',
        'Custom rule triggered',
        'CustomPlugin',
        '/src/app.js',
        10,
        0
      );

      assert.strictEqual(node.type, 'issue:custom-lint-rule');
      assert.strictEqual(node.category, 'custom-lint-rule');
    });
  });

  describe('ID generation', () => {
    it('should generate deterministic IDs', () => {
      const node1 = NodeFactory.createIssue(
        'security', 'error', 'msg', 'plugin', '/file.js', 10, 5
      );
      const node2 = NodeFactory.createIssue(
        'security', 'error', 'msg', 'plugin', '/file.js', 10, 5
      );

      assert.strictEqual(node1.id, node2.id, 'Same inputs should produce same ID');
    });

    it('should generate different IDs for different locations', () => {
      const node1 = NodeFactory.createIssue(
        'security', 'error', 'msg', 'plugin', '/file.js', 10, 5
      );
      const node2 = NodeFactory.createIssue(
        'security', 'error', 'msg', 'plugin', '/file.js', 20, 5
      );

      assert.notStrictEqual(node1.id, node2.id, 'Different locations should produce different IDs');
    });
  });

  describe('Validation via NodeFactory.validate', () => {
    it('should pass validation for valid issue node', () => {
      const node = NodeFactory.createIssue(
        'security',
        'error',
        'SQL injection detected',
        'SQLInjectionValidator',
        '/src/db.js',
        42,
        10
      );

      const errors = NodeFactory.validate(node);

      assert.strictEqual(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('should pass validation for issue with context', () => {
      const node = NodeFactory.createIssue(
        'performance',
        'warning',
        'Slow operation',
        'PerformanceChecker',
        '/src/app.js',
        100,
        5,
        { context: { duration: 5000, threshold: 1000 } }
      );

      const errors = NodeFactory.validate(node);

      assert.strictEqual(errors.length, 0);
    });
  });

  describe('Error handling', () => {
    it('should throw when category is empty', () => {
      assert.throws(() => {
        NodeFactory.createIssue('', 'error', 'msg', 'plugin', '/file.js', 10);
      }, /category is required/i);
    });

    it('should throw when severity is invalid', () => {
      assert.throws(() => {
        NodeFactory.createIssue('security', 'critical', 'msg', 'plugin', '/file.js', 10);
      }, /invalid severity/i);
    });

    it('should throw when message is empty', () => {
      assert.throws(() => {
        NodeFactory.createIssue('security', 'error', '', 'plugin', '/file.js', 10);
      }, /message is required/i);
    });

    it('should throw when plugin is empty', () => {
      assert.throws(() => {
        NodeFactory.createIssue('security', 'error', 'msg', '', '/file.js', 10);
      }, /plugin is required/i);
    });

    it('should throw when file is empty', () => {
      assert.throws(() => {
        NodeFactory.createIssue('security', 'error', 'msg', 'plugin', '', 10);
      }, /file is required/i);
    });
  });

  describe('Node properties', () => {
    it('should set createdAt timestamp', () => {
      const before = Date.now();

      const node = NodeFactory.createIssue(
        'security', 'error', 'msg', 'plugin', '/file.js', 10
      );

      const after = Date.now();

      assert.ok(node.createdAt >= before && node.createdAt <= after);
    });

    it('should truncate name to 100 chars', () => {
      const longMessage = 'X'.repeat(200);

      const node = NodeFactory.createIssue(
        'security', 'error', longMessage, 'plugin', '/file.js', 10
      );

      assert.strictEqual(node.name.length, 100);
      assert.strictEqual(node.message.length, 200); // Full message preserved
    });
  });
});

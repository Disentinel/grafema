/**
 * IssueNode Tests
 *
 * TDD tests for IssueNode contract class (REG-95).
 *
 * Tests:
 * - ID Generation (deterministic, hash-based)
 * - Node Creation (with required/optional fields)
 * - ID Parsing (extracting category and hash)
 * - Type Checking (isIssueType)
 * - Validation (field requirements, severity values)
 *
 * These tests define the contract - implementation follows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Note: This import will fail until IssueNode is implemented.
// That's expected TDD behavior - tests first, implementation second.
import { IssueNode } from '@grafema/core';

// =============================================================================
// 1. ID Generation Tests
// =============================================================================

describe('IssueNode.generateId', () => {
  describe('Deterministic ID generation', () => {
    it('should produce deterministic IDs - same inputs = same output', () => {
      const id1 = IssueNode.generateId(
        'security',
        'SQLInjectionValidator',
        '/src/db.js',
        42,
        10,
        'Potential SQL injection detected'
      );

      const id2 = IssueNode.generateId(
        'security',
        'SQLInjectionValidator',
        '/src/db.js',
        42,
        10,
        'Potential SQL injection detected'
      );

      assert.strictEqual(id1, id2, 'Same inputs should produce same ID');
    });

    it('should produce different IDs for different inputs', () => {
      const id1 = IssueNode.generateId(
        'security',
        'SQLInjectionValidator',
        '/src/db.js',
        42,
        10,
        'Potential SQL injection detected'
      );

      const id2 = IssueNode.generateId(
        'security',
        'SQLInjectionValidator',
        '/src/db.js',
        43, // Different line
        10,
        'Potential SQL injection detected'
      );

      assert.notStrictEqual(id1, id2, 'Different inputs should produce different IDs');
    });

    it('should produce different IDs for different categories', () => {
      const id1 = IssueNode.generateId(
        'security',
        'Validator',
        '/src/app.js',
        10,
        0,
        'Issue message'
      );

      const id2 = IssueNode.generateId(
        'performance',
        'Validator',
        '/src/app.js',
        10,
        0,
        'Issue message'
      );

      assert.notStrictEqual(id1, id2, 'Different categories should produce different IDs');
    });

    it('should produce different IDs for different plugins', () => {
      const id1 = IssueNode.generateId(
        'security',
        'PluginA',
        '/src/app.js',
        10,
        0,
        'Issue message'
      );

      const id2 = IssueNode.generateId(
        'security',
        'PluginB',
        '/src/app.js',
        10,
        0,
        'Issue message'
      );

      assert.notStrictEqual(id1, id2, 'Different plugins should produce different IDs');
    });

    it('should produce different IDs for different messages', () => {
      const id1 = IssueNode.generateId(
        'security',
        'Validator',
        '/src/app.js',
        10,
        0,
        'First issue'
      );

      const id2 = IssueNode.generateId(
        'security',
        'Validator',
        '/src/app.js',
        10,
        0,
        'Second issue'
      );

      assert.notStrictEqual(id1, id2, 'Different messages should produce different IDs');
    });
  });

  describe('ID format verification', () => {
    it('should generate ID with pattern: issue:<category>#<hash12>', () => {
      const id = IssueNode.generateId(
        'security',
        'SQLInjectionValidator',
        '/src/db.js',
        42,
        10,
        'Potential SQL injection detected'
      );

      // Format: issue:security#<12-char-hash>
      assert.ok(id.startsWith('issue:security#'), `ID should start with issue:security#, got: ${id}`);

      const hash = id.split('#')[1];
      assert.strictEqual(hash.length, 12, `Hash should be 12 chars, got: ${hash.length}`);
    });

    it('should use SHA256 for hash generation', () => {
      const id = IssueNode.generateId(
        'performance',
        'PerformanceChecker',
        '/src/slow.js',
        100,
        5,
        'Slow operation'
      );

      // SHA256 produces hex output, first 12 chars should be valid hex
      const hash = id.split('#')[1];
      assert.ok(/^[0-9a-f]{12}$/i.test(hash), `Hash should be valid hex, got: ${hash}`);
    });
  });
});

// =============================================================================
// 2. Node Creation Tests
// =============================================================================

describe('IssueNode.create', () => {
  describe('Valid node creation', () => {
    it('should create valid issue node with all required fields', () => {
      const node = IssueNode.create(
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

    it('should use column 0 as default when not provided', () => {
      const node = IssueNode.create(
        'performance',
        'warning',
        'Slow operation detected',
        'PerformanceChecker',
        '/src/slow.js',
        100
        // column not provided
      );

      assert.strictEqual(node.column, 0);
    });

    it('should set createdAt to current time', () => {
      const before = Date.now();

      const node = IssueNode.create(
        'style',
        'info',
        'Consider using const instead of let',
        'StyleChecker',
        '/src/app.js',
        10,
        0
      );

      const after = Date.now();

      assert.ok(
        node.createdAt >= before && node.createdAt <= after,
        `createdAt should be between ${before} and ${after}, got: ${node.createdAt}`
      );
    });

    it('should truncate name to 100 chars', () => {
      const longMessage = 'A'.repeat(200);

      const node = IssueNode.create(
        'smell',
        'warning',
        longMessage,
        'SmellDetector',
        '/src/app.js',
        10,
        0
      );

      assert.strictEqual(node.name.length, 100);
      assert.strictEqual(node.name, 'A'.repeat(100));
      // Full message should still be available
      assert.strictEqual(node.message.length, 200);
    });

    it('should include context if provided', () => {
      const context = {
        nondeterministicSources: ['request.body', 'userInput'],
        affectedQuery: 'SELECT * FROM users WHERE id = ?'
      };

      const node = IssueNode.create(
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

    it('should create different types for different categories', () => {
      const securityNode = IssueNode.create(
        'security', 'error', 'msg', 'plugin', '/file.js', 1
      );
      const perfNode = IssueNode.create(
        'performance', 'warning', 'msg', 'plugin', '/file.js', 2
      );
      const styleNode = IssueNode.create(
        'style', 'info', 'msg', 'plugin', '/file.js', 3
      );
      const smellNode = IssueNode.create(
        'smell', 'warning', 'msg', 'plugin', '/file.js', 4
      );
      const customNode = IssueNode.create(
        'custom-category', 'info', 'msg', 'plugin', '/file.js', 5
      );

      assert.strictEqual(securityNode.type, 'issue:security');
      assert.strictEqual(perfNode.type, 'issue:performance');
      assert.strictEqual(styleNode.type, 'issue:style');
      assert.strictEqual(smellNode.type, 'issue:smell');
      assert.strictEqual(customNode.type, 'issue:custom-category');
    });
  });

  describe('Validation of required fields', () => {
    it('should throw if category is missing', () => {
      assert.throws(() => {
        IssueNode.create(
          '',               // empty category
          'error',
          'message',
          'plugin',
          '/file.js',
          10
        );
      }, /category is required/i);
    });

    it('should throw if severity is invalid', () => {
      assert.throws(() => {
        IssueNode.create(
          'security',
          'critical',       // invalid - should be error/warning/info
          'message',
          'plugin',
          '/file.js',
          10
        );
      }, /invalid severity/i);
    });

    it('should throw if severity is missing', () => {
      assert.throws(() => {
        IssueNode.create(
          'security',
          '',               // empty severity
          'message',
          'plugin',
          '/file.js',
          10
        );
      }, /severity is required/i);
    });

    it('should throw if message is missing', () => {
      assert.throws(() => {
        IssueNode.create(
          'security',
          'error',
          '',               // empty message
          'plugin',
          '/file.js',
          10
        );
      }, /message is required/i);
    });

    it('should throw if plugin is missing', () => {
      assert.throws(() => {
        IssueNode.create(
          'security',
          'error',
          'message',
          '',               // empty plugin
          '/file.js',
          10
        );
      }, /plugin is required/i);
    });

    it('should throw if file is missing', () => {
      assert.throws(() => {
        IssueNode.create(
          'security',
          'error',
          'message',
          'plugin',
          '',               // empty file
          10
        );
      }, /file is required/i);
    });
  });

  describe('Severity values', () => {
    it('should accept error severity', () => {
      const node = IssueNode.create(
        'security', 'error', 'msg', 'plugin', '/file.js', 1
      );
      assert.strictEqual(node.severity, 'error');
    });

    it('should accept warning severity', () => {
      const node = IssueNode.create(
        'security', 'warning', 'msg', 'plugin', '/file.js', 1
      );
      assert.strictEqual(node.severity, 'warning');
    });

    it('should accept info severity', () => {
      const node = IssueNode.create(
        'security', 'info', 'msg', 'plugin', '/file.js', 1
      );
      assert.strictEqual(node.severity, 'info');
    });
  });
});

// =============================================================================
// 3. ID Parsing Tests
// =============================================================================

describe('IssueNode.parseId', () => {
  describe('Valid ID parsing', () => {
    it('should parse valid issue ID', () => {
      const parsed = IssueNode.parseId('issue:security#a3f2b1c4d5e6');

      assert.ok(parsed, 'Should return parsed object');
      assert.strictEqual(parsed.category, 'security');
      assert.strictEqual(parsed.hash, 'a3f2b1c4d5e6');
    });

    it('should parse custom category ID', () => {
      const parsed = IssueNode.parseId('issue:my-custom-category#abcdef123456');

      assert.ok(parsed);
      assert.strictEqual(parsed.category, 'my-custom-category');
      assert.strictEqual(parsed.hash, 'abcdef123456');
    });

    it('should parse ID with longer hash', () => {
      const parsed = IssueNode.parseId('issue:performance#abcdef1234567890');

      assert.ok(parsed);
      assert.strictEqual(parsed.category, 'performance');
      assert.strictEqual(parsed.hash, 'abcdef1234567890');
    });
  });

  describe('Invalid ID handling', () => {
    it('should return null for invalid format', () => {
      const parsed = IssueNode.parseId('FUNCTION:myFunc');

      assert.strictEqual(parsed, null);
    });

    it('should return null for empty string', () => {
      const parsed = IssueNode.parseId('');

      assert.strictEqual(parsed, null);
    });

    it('should return null for missing hash', () => {
      const parsed = IssueNode.parseId('issue:security');

      assert.strictEqual(parsed, null);
    });

    it('should return null for guarantee type', () => {
      const parsed = IssueNode.parseId('guarantee:queue#orders');

      assert.strictEqual(parsed, null);
    });

    it('should return null for null input', () => {
      const parsed = IssueNode.parseId(null);

      assert.strictEqual(parsed, null);
    });

    it('should return null for undefined input', () => {
      const parsed = IssueNode.parseId(undefined);

      assert.strictEqual(parsed, null);
    });
  });
});

// =============================================================================
// 4. Type Checking Tests
// =============================================================================

describe('IssueNode.isIssueType', () => {
  describe('Valid issue types', () => {
    it('should return true for issue:security', () => {
      assert.strictEqual(IssueNode.isIssueType('issue:security'), true);
    });

    it('should return true for issue:performance', () => {
      assert.strictEqual(IssueNode.isIssueType('issue:performance'), true);
    });

    it('should return true for issue:style', () => {
      assert.strictEqual(IssueNode.isIssueType('issue:style'), true);
    });

    it('should return true for issue:smell', () => {
      assert.strictEqual(IssueNode.isIssueType('issue:smell'), true);
    });

    it('should return true for issue:custom', () => {
      assert.strictEqual(IssueNode.isIssueType('issue:custom'), true);
    });

    it('should return true for issue:my-custom-category', () => {
      assert.strictEqual(IssueNode.isIssueType('issue:my-custom-category'), true);
    });
  });

  describe('Non-issue types', () => {
    it('should return false for FUNCTION', () => {
      assert.strictEqual(IssueNode.isIssueType('FUNCTION'), false);
    });

    it('should return false for guarantee:queue', () => {
      assert.strictEqual(IssueNode.isIssueType('guarantee:queue'), false);
    });

    it('should return false for MODULE', () => {
      assert.strictEqual(IssueNode.isIssueType('MODULE'), false);
    });

    it('should return false for http:route', () => {
      assert.strictEqual(IssueNode.isIssueType('http:route'), false);
    });

    it('should return false for empty string', () => {
      assert.strictEqual(IssueNode.isIssueType(''), false);
    });

    it('should return false for null', () => {
      assert.strictEqual(IssueNode.isIssueType(null), false);
    });

    it('should return false for undefined', () => {
      assert.strictEqual(IssueNode.isIssueType(undefined), false);
    });
  });
});

// =============================================================================
// 5. Validation Tests
// =============================================================================

describe('IssueNode.validate', () => {
  describe('Valid node validation', () => {
    it('should return empty array for valid node', () => {
      const node = IssueNode.create(
        'security',
        'error',
        'SQL injection detected',
        'SQLInjectionValidator',
        '/src/db.js',
        42,
        10
      );

      const errors = IssueNode.validate(node);

      assert.ok(Array.isArray(errors), 'Should return array');
      assert.strictEqual(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('should return empty array for node with context', () => {
      const node = IssueNode.create(
        'performance',
        'warning',
        'Slow operation',
        'PerformanceChecker',
        '/src/app.js',
        100,
        5,
        { context: { duration: 5000 } }
      );

      const errors = IssueNode.validate(node);

      assert.strictEqual(errors.length, 0);
    });
  });

  describe('Invalid node validation', () => {
    it('should return errors for missing category', () => {
      const node = {
        id: 'issue:security#abc123def456',
        type: 'issue:security',
        name: 'Test',
        file: '/test.js',
        line: 1,
        // category missing
        severity: 'error',
        message: 'Test message',
        plugin: 'TestPlugin',
        createdAt: Date.now()
      };

      const errors = IssueNode.validate(node);

      assert.ok(errors.length > 0, 'Should have validation errors');
      assert.ok(
        errors.some(e => e.toLowerCase().includes('category')),
        `Should mention category, got: ${JSON.stringify(errors)}`
      );
    });

    it('should return errors for invalid severity', () => {
      const node = {
        id: 'issue:security#abc123def456',
        type: 'issue:security',
        name: 'Test',
        file: '/test.js',
        line: 1,
        category: 'security',
        severity: 'critical', // invalid
        message: 'Test message',
        plugin: 'TestPlugin',
        createdAt: Date.now()
      };

      const errors = IssueNode.validate(node);

      assert.ok(errors.length > 0, 'Should have validation errors');
      assert.ok(
        errors.some(e => e.toLowerCase().includes('severity')),
        `Should mention severity, got: ${JSON.stringify(errors)}`
      );
    });

    it('should return errors for missing message', () => {
      const node = {
        id: 'issue:security#abc123def456',
        type: 'issue:security',
        name: 'Test',
        file: '/test.js',
        line: 1,
        category: 'security',
        severity: 'error',
        // message missing
        plugin: 'TestPlugin',
        createdAt: Date.now()
      };

      const errors = IssueNode.validate(node);

      assert.ok(errors.length > 0, 'Should have validation errors');
      assert.ok(
        errors.some(e => e.toLowerCase().includes('message')),
        `Should mention message, got: ${JSON.stringify(errors)}`
      );
    });

    it('should return errors for missing plugin', () => {
      const node = {
        id: 'issue:security#abc123def456',
        type: 'issue:security',
        name: 'Test',
        file: '/test.js',
        line: 1,
        category: 'security',
        severity: 'error',
        message: 'Test message',
        // plugin missing
        createdAt: Date.now()
      };

      const errors = IssueNode.validate(node);

      assert.ok(errors.length > 0, 'Should have validation errors');
      assert.ok(
        errors.some(e => e.toLowerCase().includes('plugin')),
        `Should mention plugin, got: ${JSON.stringify(errors)}`
      );
    });

    it('should return errors for wrong type prefix', () => {
      const node = {
        id: 'guarantee:queue#orders',
        type: 'guarantee:queue', // wrong type
        name: 'Test',
        file: '/test.js',
        line: 1,
        category: 'security',
        severity: 'error',
        message: 'Test message',
        plugin: 'TestPlugin',
        createdAt: Date.now()
      };

      const errors = IssueNode.validate(node);

      assert.ok(errors.length > 0, 'Should have validation errors');
      assert.ok(
        errors.some(e => e.includes('issue:*')),
        `Should mention expected issue:* type, got: ${JSON.stringify(errors)}`
      );
    });
  });
});

// =============================================================================
// 6. getCategories Tests
// =============================================================================

describe('IssueNode.getCategories', () => {
  it('should return array of known categories', () => {
    const categories = IssueNode.getCategories();

    assert.ok(Array.isArray(categories), 'Should return array');
    assert.ok(categories.length >= 4, 'Should have at least 4 categories');
  });

  it('should include security category', () => {
    const categories = IssueNode.getCategories();

    assert.ok(categories.includes('security'));
  });

  it('should include performance category', () => {
    const categories = IssueNode.getCategories();

    assert.ok(categories.includes('performance'));
  });

  it('should include style category', () => {
    const categories = IssueNode.getCategories();

    assert.ok(categories.includes('style'));
  });

  it('should include smell category', () => {
    const categories = IssueNode.getCategories();

    assert.ok(categories.includes('smell'));
  });
});

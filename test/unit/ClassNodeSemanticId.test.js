/**
 * ClassNode Semantic ID Tests
 *
 * Tests for ClassNode migration to use ScopeContext + Location
 * for stable semantic IDs.
 *
 * Format: {file}->{scope_path}->CLASS->{name}
 *
 * TDD: Tests written first per Kent Beck's methodology.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ScopeTracker, ClassNode } from '@grafema/core';

describe('ClassNode with Semantic ID', () => {
  describe('createWithContext() - new semantic ID API', () => {
    it('should create top-level class with semantic ID', () => {
      const tracker = new ScopeTracker('src/models/User.js');
      const context = tracker.getContext();
      const location = { line: 5, column: 0 };

      const node = ClassNode.createWithContext(
        'User',
        context,
        location
      );

      assert.strictEqual(node.id, 'src/models/User.js->global->CLASS->User');
      assert.strictEqual(node.file, 'src/models/User.js');
      assert.strictEqual(node.line, 5);
      assert.strictEqual(node.column, 0);
      assert.strictEqual(node.name, 'User');
      assert.strictEqual(node.type, 'CLASS');
    });

    it('should create nested class (class inside function)', () => {
      const tracker = new ScopeTracker('src/factory.js');
      tracker.enterScope('createClass', 'FUNCTION');
      const context = tracker.getContext();
      const location = { line: 10, column: 4 };

      const node = ClassNode.createWithContext(
        'DynamicClass',
        context,
        location
      );

      assert.strictEqual(node.id, 'src/factory.js->createClass->CLASS->DynamicClass');
    });

    it('should handle exported class', () => {
      const tracker = new ScopeTracker('src/services/AuthService.js');
      const context = tracker.getContext();
      const location = { line: 1, column: 0 };

      const node = ClassNode.createWithContext(
        'AuthService',
        context,
        location,
        { exported: true }
      );

      assert.strictEqual(node.id, 'src/services/AuthService.js->global->CLASS->AuthService');
      assert.strictEqual(node.exported, true);
    });

    it('should handle class with superclass', () => {
      const tracker = new ScopeTracker('src/models/Admin.js');
      const context = tracker.getContext();
      const location = { line: 5, column: 0 };

      const node = ClassNode.createWithContext(
        'Admin',
        context,
        location,
        { superClass: 'User' }
      );

      assert.strictEqual(node.id, 'src/models/Admin.js->global->CLASS->Admin');
      assert.strictEqual(node.superClass, 'User');
    });

    it('should store methods list', () => {
      const tracker = new ScopeTracker('src/service.js');
      const context = tracker.getContext();
      const location = { line: 1, column: 0 };

      const node = ClassNode.createWithContext(
        'Service',
        context,
        location,
        { methods: ['init', 'process', 'cleanup'] }
      );

      assert.deepStrictEqual(node.methods, ['init', 'process', 'cleanup']);
    });
  });

  describe('Semantic ID stability', () => {
    it('should produce same ID when class moves to different line', () => {
      const tracker = new ScopeTracker('src/models/User.js');
      const context = tracker.getContext();

      const node1 = ClassNode.createWithContext(
        'User',
        context,
        { line: 5, column: 0 }
      );

      const node2 = ClassNode.createWithContext(
        'User',
        context,
        { line: 15, column: 0 }
      );

      assert.strictEqual(node1.id, node2.id);
      assert.strictEqual(node1.line, 5);
      assert.strictEqual(node2.line, 15);
    });

    it('should produce different IDs for different classes', () => {
      const tracker = new ScopeTracker('src/models/index.js');
      const context = tracker.getContext();

      const user = ClassNode.createWithContext('User', context, { line: 1, column: 0 });
      const admin = ClassNode.createWithContext('Admin', context, { line: 10, column: 0 });

      assert.notStrictEqual(user.id, admin.id);
    });

    it('should produce different IDs for same-named classes in different files', () => {
      const tracker1 = new ScopeTracker('src/v1/User.js');
      const tracker2 = new ScopeTracker('src/v2/User.js');

      const v1User = ClassNode.createWithContext('User', tracker1.getContext(), { line: 1, column: 0 });
      const v2User = ClassNode.createWithContext('User', tracker2.getContext(), { line: 1, column: 0 });

      assert.notStrictEqual(v1User.id, v2User.id);
    });
  });

  describe('validation', () => {
    it('should require name', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        ClassNode.createWithContext(
          '',
          tracker.getContext(),
          { line: 1, column: 0 }
        );
      }, /name is required/);
    });

    it('should require file in context', () => {
      const context = { file: '', scopePath: [] };

      assert.throws(() => {
        ClassNode.createWithContext(
          'MyClass',
          context,
          { line: 1, column: 0 }
        );
      }, /file is required/);
    });

    it('should require line in location', () => {
      const tracker = new ScopeTracker('src/app.js');

      assert.throws(() => {
        ClassNode.createWithContext(
          'MyClass',
          tracker.getContext(),
          { column: 0 }
        );
      }, /line is required/);
    });
  });

  describe('backward compatibility with create()', () => {
    it('should still support legacy create() method', () => {
      const node = ClassNode.create(
        'LegacyClass',
        'src/app.js',
        5,
        10,
        { exported: true }
      );

      assert.ok(node.id.includes('LegacyClass'));
      assert.strictEqual(node.name, 'LegacyClass');
      assert.strictEqual(node.exported, true);
    });
  });
});

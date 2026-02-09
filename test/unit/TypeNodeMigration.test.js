/**
 * TypeNode Migration Tests (REG-104)
 *
 * TDD tests for migrating TYPE node creation to TypeNode factory.
 *
 * Verifies:
 * 1. TypeNode.create() generates ID with format {file}:TYPE:{name}:{line}
 * 2. TypeNode.create() handles optional aliasOf field
 * 3. NodeFactory.createType() delegates to TypeNode.create()
 * 4. Column defaults to 0 when undefined
 * 5. TypeNode.validate() passes for factory-created nodes
 *
 * TDD Approach:
 * - TypeNode and NodeFactory.createType() ALREADY EXIST
 * - Tests verify CURRENT behavior works (should pass BEFORE migration)
 * - Migration in GraphBuilder will use these factories
 * - Tests lock the behavior to prevent regressions
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { TypeNode, NodeFactory } from '@grafema/core';

// ============================================================================
// 1. TypeNode.create() ID format verification
// ============================================================================

describe('TypeNode Migration (REG-104)', () => {
  describe('TypeNode.create() ID format', () => {
    it('should generate ID with colon separator format: {file}:TYPE:{name}:{line}', () => {
      const node = TypeNode.create(
        'UserId',
        '/project/src/types.ts',
        10,
        0
      );

      assert.strictEqual(
        node.id,
        '/project/src/types.ts:TYPE:UserId:10',
        'ID format should be {file}:TYPE:{name}:{line}'
      );
    });

    it('should NOT use # separator in ID', () => {
      const node = TypeNode.create(
        'ProductId',
        '/project/src/models.ts',
        25,
        5
      );

      assert.ok(
        !node.id.includes('#'),
        `ID should NOT contain # separator: ${node.id}`
      );
    });

    it('should follow pattern with exactly 4 colon-separated parts', () => {
      const node = TypeNode.create(
        'EntityId',
        '/src/data/entities.ts',
        42,
        0
      );

      const parts = node.id.split(':');
      assert.strictEqual(parts.length, 4, 'ID should have 4 parts separated by :');
      assert.strictEqual(parts[0], '/src/data/entities.ts', 'First part should be file');
      assert.strictEqual(parts[1], 'TYPE', 'Second part should be TYPE');
      assert.strictEqual(parts[2], 'EntityId', 'Third part should be name');
      assert.strictEqual(parts[3], '42', 'Fourth part should be line');
    });

    it('should create consistent IDs for same parameters', () => {
      const node1 = TypeNode.create('UserId', '/file.ts', 10, 0);
      const node2 = TypeNode.create('UserId', '/file.ts', 10, 0);

      assert.strictEqual(node1.id, node2.id,
        'Same parameters should produce same ID');
    });

    it('should create unique IDs for different types', () => {
      const type1 = TypeNode.create('UserId', '/types.ts', 5, 0);
      const type2 = TypeNode.create('ProductId', '/types.ts', 10, 0);
      const type3 = TypeNode.create('UserId', '/other.ts', 5, 0);

      assert.notStrictEqual(type1.id, type2.id,
        'Different names should have different IDs');
      assert.notStrictEqual(type1.id, type3.id,
        'Same name in different files should have different IDs');
    });

    it('should create unique IDs for same name at different lines', () => {
      const node1 = TypeNode.create('Status', '/file.ts', 10, 0);
      const node2 = TypeNode.create('Status', '/file.ts', 20, 0);

      assert.notStrictEqual(node1.id, node2.id,
        'Same type name at different lines should have different IDs');
    });
  });

  // ============================================================================
  // 2. TypeNode.create() with aliasOf option
  // ============================================================================

  describe('TypeNode.create() with aliasOf', () => {
    it('should include aliasOf field when provided', () => {
      const node = TypeNode.create(
        'UserId',
        '/project/src/types.ts',
        10,
        5,
        { aliasOf: 'string' }
      );

      assert.strictEqual(node.aliasOf, 'string');
      assert.strictEqual(node.column, 5);
    });

    it('should handle complex union types in aliasOf', () => {
      const node = TypeNode.create(
        'Result',
        '/project/src/types.ts',
        15,
        0,
        { aliasOf: 'string | number | null' }
      );

      assert.strictEqual(node.aliasOf, 'string | number | null');
    });

    it('should handle object type in aliasOf', () => {
      const node = TypeNode.create(
        'Config',
        '/project/src/config.ts',
        20,
        0,
        { aliasOf: '{ timeout: number; retries: number }' }
      );

      assert.strictEqual(node.aliasOf, '{ timeout: number; retries: number }');
    });

    it('should leave aliasOf undefined when not provided', () => {
      const node = TypeNode.create(
        'SimpleType',
        '/project/src/types.ts',
        30,
        0
      );

      assert.strictEqual(node.aliasOf, undefined);
    });

    it('should leave aliasOf undefined when empty options provided', () => {
      const node = TypeNode.create(
        'SimpleType',
        '/project/src/types.ts',
        30,
        0,
        {}
      );

      assert.strictEqual(node.aliasOf, undefined);
    });
  });

  // ============================================================================
  // 3. NodeFactory.createType() delegation
  // ============================================================================

  describe('NodeFactory.createType() delegation', () => {
    it('should delegate to TypeNode.create() correctly', () => {
      const viaNodeFactory = NodeFactory.createType(
        'ProductId',
        '/src/models.ts',
        42,
        10,
        { aliasOf: 'number' }
      );

      const viaTypeNode = TypeNode.create(
        'ProductId',
        '/src/models.ts',
        42,
        10,
        { aliasOf: 'number' }
      );

      assert.deepStrictEqual(viaNodeFactory, viaTypeNode,
        'NodeFactory.createType should produce same result as TypeNode.create');
    });

    it('should create TYPE node with correct type field', () => {
      const node = NodeFactory.createType(
        'UserId',
        '/src/types.ts',
        10,
        0
      );

      assert.strictEqual(node.type, 'TYPE');
    });

    it('should include all required fields', () => {
      const node = NodeFactory.createType(
        'MyType',
        '/project/src/types.ts',
        15,
        5,
        { aliasOf: 'string' }
      );

      assert.strictEqual(node.type, 'TYPE');
      assert.strictEqual(node.name, 'MyType');
      assert.strictEqual(node.file, '/project/src/types.ts');
      assert.strictEqual(node.line, 15);
      assert.strictEqual(node.column, 5);
      assert.strictEqual(node.aliasOf, 'string');
      assert.ok(node.id.includes(':TYPE:'));
    });

    it('should generate colon-formatted ID via NodeFactory', () => {
      const node = NodeFactory.createType(
        'EntityId',
        '/src/entities.ts',
        50,
        0
      );

      assert.strictEqual(
        node.id,
        '/src/entities.ts:TYPE:EntityId:50'
      );
    });
  });

  // ============================================================================
  // 4. Column defaults to 0
  // ============================================================================

  describe('Column handling', () => {
    it('should accept explicit column value', () => {
      const node = TypeNode.create(
        'MyType',
        '/src/types.ts',
        5,
        15  // explicit column
      );

      assert.strictEqual(node.column, 15);
    });

    it('should default column to 0 when 0 is passed', () => {
      const node = TypeNode.create(
        'MyType',
        '/src/types.ts',
        5,
        0
      );

      assert.strictEqual(node.column, 0);
    });

    it('should handle column || 0 pattern for undefined column', () => {
      // Simulates the pattern used in migration: typeAlias.column || 0
      const typeAlias = {
        name: 'MyType',
        file: '/src/types.ts',
        line: 5,
        column: undefined
      };

      const node = NodeFactory.createType(
        typeAlias.name,
        typeAlias.file,
        typeAlias.line,
        typeAlias.column || 0  // pattern from migration
      );

      assert.strictEqual(node.column, 0);
    });

    it('should preserve non-zero column through || 0 pattern', () => {
      const typeAlias = {
        name: 'MyType',
        file: '/src/types.ts',
        line: 5,
        column: 20
      };

      const node = NodeFactory.createType(
        typeAlias.name,
        typeAlias.file,
        typeAlias.line,
        typeAlias.column || 0
      );

      assert.strictEqual(node.column, 20);
    });
  });

  // ============================================================================
  // 5. TypeNode.validate() passes for factory-created nodes
  // ============================================================================

  describe('TypeNode.validate()', () => {
    it('should pass validation for basic TYPE node', () => {
      const node = TypeNode.create(
        'UserId',
        '/src/types.ts',
        10,
        0
      );

      const errors = TypeNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Should have no validation errors, got: ${errors.join(', ')}`);
    });

    it('should pass validation for TYPE node with aliasOf', () => {
      const node = TypeNode.create(
        'ProductId',
        '/src/types.ts',
        15,
        5,
        { aliasOf: 'string | number' }
      );

      const errors = TypeNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Should have no validation errors, got: ${errors.join(', ')}`);
    });

    it('should pass validation for NodeFactory-created TYPE node', () => {
      const node = NodeFactory.createType(
        'EntityId',
        '/src/entities.ts',
        25,
        0,
        { aliasOf: 'number' }
      );

      const errors = TypeNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no validation errors, got: ${errors.join(', ')}`);
    });

    it('should pass NodeFactory.validate() for TYPE node', () => {
      const node = NodeFactory.createType(
        'ConfigType',
        '/project/src/config.ts',
        30,
        0
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no validation errors, got: ${JSON.stringify(errors)}`);
    });
  });

  // ============================================================================
  // 6. Required field validation
  // ============================================================================

  describe('Required field validation', () => {
    it('should throw when name is missing', () => {
      assert.throws(() => {
        TypeNode.create('', '/file.ts', 10, 0);
      }, /name is required/);
    });

    it('should throw when file is missing', () => {
      assert.throws(() => {
        TypeNode.create('MyType', '', 10, 0);
      }, /file is required/);
    });

    it('should throw when line is missing (0)', () => {
      assert.throws(() => {
        TypeNode.create('MyType', '/file.ts', 0, 0);
      }, /line is required/);
    });

    it('should throw via NodeFactory when name is missing', () => {
      assert.throws(() => {
        NodeFactory.createType('', '/file.ts', 10, 0);
      }, /name is required/);
    });

    it('should throw via NodeFactory when file is missing', () => {
      assert.throws(() => {
        NodeFactory.createType('MyType', '', 10, 0);
      }, /file is required/);
    });

    it('should throw via NodeFactory when line is missing', () => {
      assert.throws(() => {
        NodeFactory.createType('MyType', '/file.ts', 0, 0);
      }, /line is required/);
    });
  });

  // ============================================================================
  // 7. Type constants and metadata
  // ============================================================================

  describe('TypeNode constants', () => {
    it('should have TYPE constant equal to "TYPE"', () => {
      assert.strictEqual(TypeNode.TYPE, 'TYPE');
    });

    it('should have REQUIRED array with required fields', () => {
      assert.ok(Array.isArray(TypeNode.REQUIRED));
      assert.ok(TypeNode.REQUIRED.includes('name'));
      assert.ok(TypeNode.REQUIRED.includes('file'));
      assert.ok(TypeNode.REQUIRED.includes('line'));
    });

    it('should have OPTIONAL array with optional fields', () => {
      assert.ok(Array.isArray(TypeNode.OPTIONAL));
      assert.ok(TypeNode.OPTIONAL.includes('aliasOf'));
    });
  });
});

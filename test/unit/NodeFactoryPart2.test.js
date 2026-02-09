/**
 * NodeFactory Part 2 - Factory Enhancements Tests (REG-98 Phase 2a)
 *
 * TDD tests for factory enhancements needed for GraphBuilder migration:
 * 1. ClassNode - Add `isInstantiationRef` option
 * 2. ExportNode - Add `source` and `exportType` options
 * 3. InterfaceNode - Add `isExternal` option
 *
 * These tests define the contract - implementation follows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NodeFactory, ClassNode, ExportNode, InterfaceNode } from '@grafema/core';

// ============================================================================
// 1. ClassNode Enhancement: isInstantiationRef
// ============================================================================

describe('ClassNode.create with isInstantiationRef', () => {
  describe('Default behavior (backward compatibility)', () => {
    it('should not include isInstantiationRef when not provided', () => {
      const node = ClassNode.create(
        'UserService',
        '/project/src/services/UserService.ts',
        10,
        0
      );

      // When not provided, isInstantiationRef should be undefined or false
      assert.strictEqual(node.isInstantiationRef, undefined);
    });

    it('should work with existing options without isInstantiationRef', () => {
      const node = ClassNode.create(
        'UserService',
        '/project/src/services/UserService.ts',
        10,
        0,
        {
          exported: true,
          superClass: 'BaseService',
          methods: ['create', 'update']
        }
      );

      assert.strictEqual(node.exported, true);
      assert.strictEqual(node.superClass, 'BaseService');
      assert.deepStrictEqual(node.methods, ['create', 'update']);
      assert.strictEqual(node.isInstantiationRef, undefined);
    });
  });

  describe('isInstantiationRef option', () => {
    it('should set isInstantiationRef to true when provided', () => {
      const node = ClassNode.create(
        'ExternalClass',
        '/project/src/app.ts',
        45,
        10,
        { isInstantiationRef: true }
      );

      assert.strictEqual(node.isInstantiationRef, true);
    });

    it('should set isInstantiationRef to false when explicitly provided', () => {
      const node = ClassNode.create(
        'LocalClass',
        '/project/src/app.ts',
        45,
        10,
        { isInstantiationRef: false }
      );

      assert.strictEqual(node.isInstantiationRef, false);
    });

    it('should combine isInstantiationRef with other options', () => {
      const node = ClassNode.create(
        'ExternalService',
        '/project/src/app.ts',
        45,
        10,
        {
          exported: true,
          superClass: 'BaseService',
          methods: ['init'],
          isInstantiationRef: true
        }
      );

      assert.strictEqual(node.exported, true);
      assert.strictEqual(node.superClass, 'BaseService');
      assert.deepStrictEqual(node.methods, ['init']);
      assert.strictEqual(node.isInstantiationRef, true);
    });

    it('should include isInstantiationRef in output node when true', () => {
      const node = ClassNode.create(
        'ExternalClass',
        '/project/src/app.ts',
        45,
        10,
        { isInstantiationRef: true }
      );

      // Verify the field exists in the serialized node
      const keys = Object.keys(node);
      assert.ok(keys.includes('isInstantiationRef'),
        'isInstantiationRef should be present in node keys');
    });
  });

  describe('Use case: external class reference (GraphBuilder pattern)', () => {
    it('should create node for external class instantiation', () => {
      // This mirrors GraphBuilder line ~446 usage pattern
      const className = 'ExternalLogger';
      const file = '/project/src/services/UserService.ts';
      const line = 25;

      const node = ClassNode.create(
        className,
        file,
        line,
        0,
        { isInstantiationRef: true }
      );

      assert.strictEqual(node.type, 'CLASS');
      assert.strictEqual(node.name, 'ExternalLogger');
      assert.strictEqual(node.isInstantiationRef, true);
      assert.ok(node.id.includes('CLASS'));
    });
  });

  describe('Validation with isInstantiationRef', () => {
    it('should pass validation for class node with isInstantiationRef', () => {
      const node = ClassNode.create(
        'ExternalClass',
        '/project/src/app.ts',
        45,
        10,
        { isInstantiationRef: true }
      );

      const errors = ClassNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });
  });
});

describe('NodeFactory.createClass with isInstantiationRef', () => {
  it('should support isInstantiationRef through NodeFactory', () => {
    const node = NodeFactory.createClass(
      'ExternalClass',
      '/project/src/app.ts',
      45,
      10,
      { isInstantiationRef: true }
    );

    assert.strictEqual(node.isInstantiationRef, true);
  });
});

// ============================================================================
// 2. ExportNode Enhancement: source and exportType
// ============================================================================

describe('ExportNode.create with source and exportType', () => {
  describe('Default behavior (backward compatibility)', () => {
    it('should not include source when not provided', () => {
      const node = ExportNode.create(
        'formatDate',
        '/project/src/utils.ts',
        15,
        0
      );

      assert.strictEqual(node.source, undefined);
    });

    it('should not include exportType when not provided', () => {
      const node = ExportNode.create(
        'formatDate',
        '/project/src/utils.ts',
        15,
        0
      );

      // exportType should be undefined when not explicitly set
      assert.strictEqual(node.exportType, undefined);
    });

    it('should work with existing options without new fields', () => {
      const node = ExportNode.create(
        'default',
        '/project/src/App.tsx',
        100,
        0,
        {
          exportKind: 'value',
          local: 'App',
          default: true
        }
      );

      assert.strictEqual(node.exportKind, 'value');
      assert.strictEqual(node.local, 'App');
      assert.strictEqual(node.default, true);
      assert.strictEqual(node.source, undefined);
      assert.strictEqual(node.exportType, undefined);
    });
  });

  describe('exportType option', () => {
    it('should set exportType to "default" for default exports', () => {
      const node = ExportNode.create(
        'default',
        '/project/src/App.tsx',
        100,
        0,
        { exportType: 'default' }
      );

      assert.strictEqual(node.exportType, 'default');
    });

    it('should set exportType to "named" for named exports', () => {
      const node = ExportNode.create(
        'formatDate',
        '/project/src/utils.ts',
        15,
        0,
        { exportType: 'named' }
      );

      assert.strictEqual(node.exportType, 'named');
    });

    it('should set exportType to "all" for re-export all (export *)', () => {
      const node = ExportNode.create(
        '*',
        '/project/src/index.ts',
        5,
        0,
        { exportType: 'all' }
      );

      assert.strictEqual(node.exportType, 'all');
      assert.strictEqual(node.name, '*');
    });
  });

  describe('source option', () => {
    it('should set source for re-exports', () => {
      const node = ExportNode.create(
        'helper',
        '/project/src/index.ts',
        10,
        0,
        { source: './helpers' }
      );

      assert.strictEqual(node.source, './helpers');
    });

    it('should set source for export * from', () => {
      const node = ExportNode.create(
        '*',
        '/project/src/index.ts',
        5,
        0,
        {
          exportType: 'all',
          source: './utils'
        }
      );

      assert.strictEqual(node.source, './utils');
      assert.strictEqual(node.exportType, 'all');
    });

    it('should set source for named re-exports', () => {
      const node = ExportNode.create(
        'formatDate',
        '/project/src/index.ts',
        15,
        0,
        {
          exportType: 'named',
          source: './date-utils',
          local: 'formatDate'
        }
      );

      assert.strictEqual(node.source, './date-utils');
      assert.strictEqual(node.exportType, 'named');
    });
  });

  describe('Combined options', () => {
    it('should combine exportType and source with existing options', () => {
      const node = ExportNode.create(
        'UserType',
        '/project/src/index.ts',
        20,
        0,
        {
          exportKind: 'type',
          exportType: 'named',
          source: './types',
          local: 'UserType'
        }
      );

      assert.strictEqual(node.exportKind, 'type');
      assert.strictEqual(node.exportType, 'named');
      assert.strictEqual(node.source, './types');
      assert.strictEqual(node.local, 'UserType');
    });
  });

  describe('Use cases from GraphBuilder patterns', () => {
    it('should create default export node (GraphBuilder line ~542)', () => {
      const node = ExportNode.create(
        'default',
        '/project/src/App.tsx',
        100,
        0,
        {
          exportType: 'default',
          default: true
        }
      );

      assert.strictEqual(node.type, 'EXPORT');
      assert.strictEqual(node.name, 'default');
      assert.strictEqual(node.exportType, 'default');
      assert.strictEqual(node.default, true);
    });

    it('should create named re-export node (GraphBuilder line ~561-567)', () => {
      const source = './helpers';
      const node = ExportNode.create(
        'formatDate',
        '/project/src/index.ts',
        15,
        0,
        {
          exportType: 'named',
          source: source,
          local: 'formatDate'
        }
      );

      assert.strictEqual(node.type, 'EXPORT');
      assert.strictEqual(node.exportType, 'named');
      assert.strictEqual(node.source, source);
      assert.strictEqual(node.local, 'formatDate');
    });

    it('should create export all node (GraphBuilder line ~599-603)', () => {
      const source = './utils';
      const node = ExportNode.create(
        '*',
        '/project/src/index.ts',
        5,
        0,
        {
          exportType: 'all',
          source: source
        }
      );

      assert.strictEqual(node.type, 'EXPORT');
      assert.strictEqual(node.name, '*');
      assert.strictEqual(node.exportType, 'all');
      assert.strictEqual(node.source, source);
    });

    it('should create plain named export node (GraphBuilder line ~576)', () => {
      const node = ExportNode.create(
        'formatDate',
        '/project/src/utils.ts',
        15,
        0,
        { exportType: 'named' }
      );

      assert.strictEqual(node.type, 'EXPORT');
      assert.strictEqual(node.name, 'formatDate');
      assert.strictEqual(node.exportType, 'named');
      assert.strictEqual(node.source, undefined);
    });
  });

  describe('Validation with new options', () => {
    it('should pass validation for export with exportType', () => {
      const node = ExportNode.create(
        'formatDate',
        '/project/src/utils.ts',
        15,
        8,
        { exportType: 'named' }
      );

      const errors = ExportNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('should pass validation for re-export with source', () => {
      const node = ExportNode.create(
        'helper',
        '/project/src/index.ts',
        10,
        1,
        {
          exportType: 'named',
          source: './helpers'
        }
      );

      const errors = ExportNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('should pass validation for export all', () => {
      const node = ExportNode.create(
        '*',
        '/project/src/index.ts',
        5,
        1,
        {
          exportType: 'all',
          source: './utils'
        }
      );

      const errors = ExportNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });
  });
});

describe('NodeFactory.createExport with source and exportType', () => {
  it('should support exportType through NodeFactory', () => {
    const node = NodeFactory.createExport(
      'formatDate',
      '/project/src/utils.ts',
      15,
      0,
      { exportType: 'named' }
    );

    assert.strictEqual(node.exportType, 'named');
  });

  it('should support source through NodeFactory', () => {
    const node = NodeFactory.createExport(
      '*',
      '/project/src/index.ts',
      5,
      0,
      {
        exportType: 'all',
        source: './utils'
      }
    );

    assert.strictEqual(node.source, './utils');
    assert.strictEqual(node.exportType, 'all');
  });
});

// ============================================================================
// 3. InterfaceNode Enhancement: isExternal
// ============================================================================

describe('InterfaceNode.create with isExternal', () => {
  describe('Default behavior (backward compatibility)', () => {
    it('should not include isExternal when not provided', () => {
      const node = InterfaceNode.create(
        'IUser',
        '/project/src/types.ts',
        5,
        0
      );

      assert.strictEqual(node.isExternal, undefined);
    });

    it('should work with existing options without isExternal', () => {
      const node = InterfaceNode.create(
        'IUser',
        '/project/src/types.ts',
        5,
        0,
        {
          extends: ['IEntity'],
          properties: [
            { name: 'id', type: 'string' }
          ]
        }
      );

      assert.deepStrictEqual(node.extends, ['IEntity']);
      assert.strictEqual(node.properties.length, 1);
      assert.strictEqual(node.isExternal, undefined);
    });
  });

  describe('isExternal option', () => {
    it('should set isExternal to true when provided', () => {
      const node = InterfaceNode.create(
        'ISerializable',
        '/project/src/models/User.ts',
        10,
        0,
        { isExternal: true }
      );

      assert.strictEqual(node.isExternal, true);
    });

    it('should set isExternal to false when explicitly provided', () => {
      const node = InterfaceNode.create(
        'IUser',
        '/project/src/types.ts',
        5,
        0,
        { isExternal: false }
      );

      assert.strictEqual(node.isExternal, false);
    });

    it('should combine isExternal with other options', () => {
      const node = InterfaceNode.create(
        'IExternalEntity',
        '/project/src/models/User.ts',
        10,
        0,
        {
          extends: ['IBase'],
          properties: [
            { name: 'id', type: 'string', readonly: true }
          ],
          isExternal: true
        }
      );

      assert.deepStrictEqual(node.extends, ['IBase']);
      assert.strictEqual(node.properties.length, 1);
      assert.strictEqual(node.isExternal, true);
    });

    it('should include isExternal in output node when true', () => {
      const node = InterfaceNode.create(
        'IExternalInterface',
        '/project/src/models/User.ts',
        10,
        0,
        { isExternal: true }
      );

      // Verify the field exists in the serialized node
      const keys = Object.keys(node);
      assert.ok(keys.includes('isExternal'),
        'isExternal should be present in node keys');
    });
  });

  describe('Use cases from GraphBuilder patterns', () => {
    it('should create external interface for extends (GraphBuilder line ~1094-1102)', () => {
      // When an interface extends an unknown/external interface
      const parentName = 'ISerializable';
      const file = '/project/src/models/User.ts';
      const line = 15;

      const node = InterfaceNode.create(
        parentName,
        file,
        line,
        0,
        { isExternal: true }
      );

      assert.strictEqual(node.type, 'INTERFACE');
      assert.strictEqual(node.name, 'ISerializable');
      assert.strictEqual(node.isExternal, true);
      assert.ok(node.id.includes('INTERFACE'));
    });

    it('should create external interface for implements (GraphBuilder line ~1208-1216)', () => {
      // When a class implements an unknown/external interface
      const ifaceName = 'IDisposable';
      const file = '/project/src/services/Connection.ts';
      const line = 25;

      const node = InterfaceNode.create(
        ifaceName,
        file,
        line,
        0,
        { isExternal: true }
      );

      assert.strictEqual(node.type, 'INTERFACE');
      assert.strictEqual(node.name, 'IDisposable');
      assert.strictEqual(node.isExternal, true);
    });

    it('should create local interface without isExternal', () => {
      const node = InterfaceNode.create(
        'IUser',
        '/project/src/types.ts',
        5,
        0,
        {
          extends: ['IEntity'],
          properties: [
            { name: 'name', type: 'string' }
          ]
        }
      );

      assert.strictEqual(node.type, 'INTERFACE');
      assert.strictEqual(node.name, 'IUser');
      assert.strictEqual(node.isExternal, undefined);
    });
  });

  describe('Validation with isExternal', () => {
    it('should pass validation for interface with isExternal true', () => {
      const node = InterfaceNode.create(
        'ISerializable',
        '/project/src/models/User.ts',
        10,
        1,
        { isExternal: true }
      );

      const errors = InterfaceNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('should pass validation for interface with isExternal false', () => {
      const node = InterfaceNode.create(
        'IUser',
        '/project/src/types.ts',
        5,
        1,
        { isExternal: false }
      );

      const errors = InterfaceNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('should pass validation for external interface with no properties', () => {
      // External interfaces typically have no properties as we don't know their structure
      const node = InterfaceNode.create(
        'IExternalLib',
        '/project/src/adapters/external.ts',
        20,
        1,
        { isExternal: true }
      );

      assert.deepStrictEqual(node.extends, []);
      assert.deepStrictEqual(node.properties, []);
      assert.strictEqual(node.isExternal, true);

      const errors = InterfaceNode.validate(node);
      assert.strictEqual(errors.length, 0);
    });
  });
});

describe('NodeFactory.createInterface with isExternal', () => {
  it('should support isExternal through NodeFactory', () => {
    const node = NodeFactory.createInterface(
      'ISerializable',
      '/project/src/models/User.ts',
      10,
      0,
      { isExternal: true }
    );

    assert.strictEqual(node.isExternal, true);
  });
});

// ============================================================================
// Cross-cutting concerns for Part 2 enhancements
// ============================================================================

describe('NodeFactory Part 2 - Cross-cutting concerns', () => {
  describe('All enhanced factory methods handle empty options gracefully', () => {
    it('ClassNode with undefined options still works', () => {
      const node = ClassNode.create('MyClass', '/file.ts', 1, 0);
      assert.strictEqual(node.type, 'CLASS');
      assert.strictEqual(node.isInstantiationRef, undefined);
    });

    it('ExportNode with undefined options still works', () => {
      const node = ExportNode.create('myExport', '/file.ts', 1, 0);
      assert.strictEqual(node.type, 'EXPORT');
      assert.strictEqual(node.exportType, undefined);
      assert.strictEqual(node.source, undefined);
    });

    it('InterfaceNode with undefined options still works', () => {
      const node = InterfaceNode.create('IMyInterface', '/file.ts', 1, 0);
      assert.strictEqual(node.type, 'INTERFACE');
      assert.strictEqual(node.isExternal, undefined);
    });
  });

  describe('New optional fields do not affect ID generation', () => {
    it('ClassNode ID remains consistent with isInstantiationRef', () => {
      const nodeWithout = ClassNode.create('MyClass', '/file.ts', 10, 0);
      const nodeWith = ClassNode.create('MyClass', '/file.ts', 10, 0, { isInstantiationRef: true });

      assert.strictEqual(nodeWithout.id, nodeWith.id);
    });

    it('ExportNode ID remains consistent with new options', () => {
      const nodeWithout = ExportNode.create('myExport', '/file.ts', 10, 0);
      const nodeWith = ExportNode.create('myExport', '/file.ts', 10, 0, {
        exportType: 'named',
        source: './utils'
      });

      assert.strictEqual(nodeWithout.id, nodeWith.id);
    });

    it('InterfaceNode ID remains consistent with isExternal', () => {
      const nodeWithout = InterfaceNode.create('IMyInterface', '/file.ts', 10, 0);
      const nodeWith = InterfaceNode.create('IMyInterface', '/file.ts', 10, 0, { isExternal: true });

      assert.strictEqual(nodeWithout.id, nodeWith.id);
    });
  });

  describe('Enhanced nodes pass NodeFactory.validate()', () => {
    it('ClassNode with isInstantiationRef passes validation', () => {
      const node = ClassNode.create('MyClass', '/file.ts', 1, 5, { isInstantiationRef: true });
      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('ExportNode with exportType and source passes validation', () => {
      const node = ExportNode.create('myExport', '/file.ts', 1, 8, {
        exportType: 'named',
        source: './utils'
      });
      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('InterfaceNode with isExternal passes validation', () => {
      const node = InterfaceNode.create('IMyInterface', '/file.ts', 1, 3, { isExternal: true });
      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });
  });
});

// ============================================================================
// Type-level tests (compile-time verification)
// ============================================================================

describe('TypeScript compile-time checks (runtime verification)', () => {
  describe('ClassNodeOptions type allows isInstantiationRef', () => {
    it('should accept isInstantiationRef in options object', () => {
      // This test verifies the TypeScript types allow the new field
      // If this compiles and runs, the types are correct
      const options = {
        exported: true,
        isInstantiationRef: true
      };

      const node = ClassNode.create('Test', '/file.ts', 1, 0, options);
      assert.ok(node);
    });
  });

  describe('ExportNodeOptions type allows source and exportType', () => {
    it('should accept source in options object', () => {
      const options = {
        exportKind: 'value',
        source: './utils'
      };

      const node = ExportNode.create('Test', '/file.ts', 1, 0, options);
      assert.ok(node);
    });

    it('should accept exportType in options object', () => {
      const options = {
        exportType: 'named'
      };

      const node = ExportNode.create('Test', '/file.ts', 1, 0, options);
      assert.ok(node);
    });

    it('should accept both source and exportType in options object', () => {
      const options = {
        exportType: 'all',
        source: './utils'
      };

      const node = ExportNode.create('Test', '/file.ts', 1, 0, options);
      assert.ok(node);
    });
  });

  describe('InterfaceNodeOptions type allows isExternal', () => {
    it('should accept isExternal in options object', () => {
      const options = {
        extends: ['IBase'],
        isExternal: true
      };

      const node = InterfaceNode.create('Test', '/file.ts', 1, 0, options);
      assert.ok(node);
    });
  });
});

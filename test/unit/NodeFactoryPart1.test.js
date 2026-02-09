/**
 * NodeFactory Part 1 - Factory Methods Tests
 *
 * TDD tests for 8 new factory methods:
 * 1. createClass()
 * 2. createExport()
 * 3. createExternalModule()
 * 4. createInterface()
 * 5. createType()
 * 6. createEnum()
 * 7. createDecorator()
 * 8. createExpression()
 *
 * These tests define the contract - implementation follows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NodeFactory } from '@grafema/core';

// ============================================================================
// 1. createClass() Tests
// ============================================================================

describe('NodeFactory.createClass', () => {
  describe('Basic class node creation', () => {
    it('should create class node with required fields only', () => {
      const node = NodeFactory.createClass(
        'UserService',
        '/project/src/services/UserService.ts',
        10,
        0
      );

      assert.strictEqual(node.type, 'CLASS');
      assert.strictEqual(node.name, 'UserService');
      assert.strictEqual(node.file, '/project/src/services/UserService.ts');
      assert.strictEqual(node.line, 10);
      assert.strictEqual(node.column, 0);
      // Defaults
      assert.strictEqual(node.exported, false);
      assert.strictEqual(node.superClass, undefined);
      assert.deepStrictEqual(node.methods, []);
    });

    it('should create class node with all options', () => {
      const node = NodeFactory.createClass(
        'UserService',
        '/project/src/services/UserService.ts',
        10,
        0,
        {
          exported: true,
          superClass: 'BaseService',
          methods: ['create', 'update', 'delete']
        }
      );

      assert.strictEqual(node.exported, true);
      assert.strictEqual(node.superClass, 'BaseService');
      assert.deepStrictEqual(node.methods, ['create', 'update', 'delete']);
    });
  });

  describe('ID format verification', () => {
    it('should generate ID with pattern: file:CLASS:name:line', () => {
      const node = NodeFactory.createClass(
        'UserService',
        '/project/src/services/UserService.ts',
        10,
        0
      );

      assert.strictEqual(
        node.id,
        '/project/src/services/UserService.ts:CLASS:UserService:10'
      );
    });

    it('should create unique IDs for different classes', () => {
      const class1 = NodeFactory.createClass('User', '/src/models.ts', 10, 0);
      const class2 = NodeFactory.createClass('Admin', '/src/models.ts', 30, 0);

      assert.notStrictEqual(class1.id, class2.id);
    });

    it('should create different IDs for same name in different files', () => {
      const class1 = NodeFactory.createClass('Service', '/src/a.ts', 10, 0);
      const class2 = NodeFactory.createClass('Service', '/src/b.ts', 10, 0);

      assert.notStrictEqual(class1.id, class2.id);
    });
  });

  describe('Validation of required fields', () => {
    it('should throw when name is missing', () => {
      assert.throws(() => {
        NodeFactory.createClass('', '/file.ts', 10, 0);
      }, /name is required/);
    });

    it('should throw when file is missing', () => {
      assert.throws(() => {
        NodeFactory.createClass('MyClass', '', 10, 0);
      }, /file is required/);
    });

    it('should throw when line is missing', () => {
      assert.throws(() => {
        NodeFactory.createClass('MyClass', '/file.ts', 0, 0);
      }, /line is required/);
    });
  });

  describe('NodeFactory validation', () => {
    it('should pass validation for valid class node', () => {
      const node = NodeFactory.createClass(
        'UserService',
        '/project/src/services/UserService.ts',
        10,
        5,
        { exported: true }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });
  });
});

// ============================================================================
// 2. createExport() Tests
// ============================================================================

describe('NodeFactory.createExport', () => {
  describe('Basic export node creation', () => {
    it('should create named export with required fields only', () => {
      const node = NodeFactory.createExport(
        'formatDate',
        '/project/src/utils.ts',
        15,
        0
      );

      assert.strictEqual(node.type, 'EXPORT');
      assert.strictEqual(node.name, 'formatDate');
      assert.strictEqual(node.file, '/project/src/utils.ts');
      assert.strictEqual(node.line, 15);
      assert.strictEqual(node.column, 0);
      // Defaults
      assert.strictEqual(node.exportKind, 'value');
      assert.strictEqual(node.local, 'formatDate');
      assert.strictEqual(node.default, false);
    });

    it('should create export with all options', () => {
      const node = NodeFactory.createExport(
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

      assert.strictEqual(node.name, 'default');
      assert.strictEqual(node.local, 'App');
      assert.strictEqual(node.default, true);
      assert.strictEqual(node.exportKind, 'value');
    });

    it('should create type export', () => {
      const node = NodeFactory.createExport(
        'UserType',
        '/project/src/types.ts',
        5,
        0,
        { exportKind: 'type' }
      );

      assert.strictEqual(node.exportKind, 'type');
    });
  });

  describe('ID format verification', () => {
    it('should generate ID with pattern: file:EXPORT:name:line', () => {
      const node = NodeFactory.createExport(
        'formatDate',
        '/project/src/utils.ts',
        15,
        0
      );

      assert.strictEqual(
        node.id,
        '/project/src/utils.ts:EXPORT:formatDate:15'
      );
    });

    it('should create unique IDs for different exports', () => {
      const export1 = NodeFactory.createExport('foo', '/src/utils.ts', 10, 0);
      const export2 = NodeFactory.createExport('bar', '/src/utils.ts', 20, 0);

      assert.notStrictEqual(export1.id, export2.id);
    });
  });

  describe('Validation of required fields', () => {
    it('should throw when name is missing', () => {
      assert.throws(() => {
        NodeFactory.createExport('', '/file.ts', 10, 0);
      }, /name is required/);
    });

    it('should throw when file is missing', () => {
      assert.throws(() => {
        NodeFactory.createExport('myExport', '', 10, 0);
      }, /file is required/);
    });

    it('should throw when line is missing', () => {
      assert.throws(() => {
        NodeFactory.createExport('myExport', '/file.ts', 0, 0);
      }, /line is required/);
    });
  });

  describe('NodeFactory validation', () => {
    it('should pass validation for valid export node', () => {
      const node = NodeFactory.createExport(
        'formatDate',
        '/project/src/utils.ts',
        15,
        8
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('should pass validation for default export', () => {
      const node = NodeFactory.createExport(
        'default',
        '/project/src/App.tsx',
        100,
        1,
        { default: true, local: 'App' }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0);
    });
  });
});

// ============================================================================
// 3. createExternalModule() Tests
// ============================================================================

describe('NodeFactory.createExternalModule', () => {
  describe('Basic external module node creation', () => {
    it('should create external module for npm package', () => {
      const node = NodeFactory.createExternalModule('lodash');

      assert.strictEqual(node.type, 'EXTERNAL_MODULE');
      assert.strictEqual(node.name, 'lodash');
      // External modules have no file/line context
      assert.strictEqual(node.file, '');
      assert.strictEqual(node.line, 0);
    });

    it('should create external module for scoped package', () => {
      const node = NodeFactory.createExternalModule('@tanstack/react-query');

      assert.strictEqual(node.type, 'EXTERNAL_MODULE');
      assert.strictEqual(node.name, '@tanstack/react-query');
    });

    it('should create external module for Node.js built-in', () => {
      const node = NodeFactory.createExternalModule('node:fs');

      assert.strictEqual(node.type, 'EXTERNAL_MODULE');
      assert.strictEqual(node.name, 'fs');
    });
  });

  describe('ID format verification', () => {
    it('should generate ID with pattern: EXTERNAL_MODULE:source', () => {
      const node = NodeFactory.createExternalModule('lodash');

      assert.strictEqual(node.id, 'EXTERNAL_MODULE:lodash');
    });

    it('should generate stable ID for scoped packages', () => {
      const node = NodeFactory.createExternalModule('@tanstack/react-query');

      assert.strictEqual(node.id, 'EXTERNAL_MODULE:@tanstack/react-query');
    });

    it('should create same ID for same source (singleton pattern)', () => {
      const node1 = NodeFactory.createExternalModule('react');
      const node2 = NodeFactory.createExternalModule('react');

      assert.strictEqual(node1.id, node2.id);
    });
  });

  describe('Validation of required fields', () => {
    it('should throw when source is missing', () => {
      assert.throws(() => {
        NodeFactory.createExternalModule('');
      }, /source is required/);
    });
  });

  describe('NodeFactory validation', () => {
    it('should pass validation for valid external module node', () => {
      const node = NodeFactory.createExternalModule('lodash');

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });
  });
});

// ============================================================================
// 4. createInterface() Tests
// ============================================================================

describe('NodeFactory.createInterface', () => {
  describe('Basic interface node creation', () => {
    it('should create interface with required fields only', () => {
      const node = NodeFactory.createInterface(
        'IUser',
        '/project/src/types.ts',
        5,
        0
      );

      assert.strictEqual(node.type, 'INTERFACE');
      assert.strictEqual(node.name, 'IUser');
      assert.strictEqual(node.file, '/project/src/types.ts');
      assert.strictEqual(node.line, 5);
      assert.strictEqual(node.column, 0);
      // Defaults
      assert.deepStrictEqual(node.extends, []);
      assert.deepStrictEqual(node.properties, []);
    });

    it('should create interface with all options', () => {
      const node = NodeFactory.createInterface(
        'IUser',
        '/project/src/types.ts',
        5,
        0,
        {
          extends: ['IEntity', 'ISerializable'],
          properties: [
            { name: 'id', type: 'string', readonly: true },
            { name: 'name', type: 'string' },
            { name: 'email', type: 'string', optional: true }
          ]
        }
      );

      assert.deepStrictEqual(node.extends, ['IEntity', 'ISerializable']);
      assert.strictEqual(node.properties.length, 3);
      assert.strictEqual(node.properties[0].name, 'id');
      assert.strictEqual(node.properties[0].readonly, true);
      assert.strictEqual(node.properties[2].optional, true);
    });
  });

  describe('ID format verification', () => {
    it('should generate ID with pattern: file:INTERFACE:name:line', () => {
      const node = NodeFactory.createInterface(
        'IUser',
        '/project/src/types.ts',
        5,
        0
      );

      assert.strictEqual(
        node.id,
        '/project/src/types.ts:INTERFACE:IUser:5'
      );
    });

    it('should create unique IDs for different interfaces', () => {
      const iface1 = NodeFactory.createInterface('IUser', '/src/types.ts', 5, 0);
      const iface2 = NodeFactory.createInterface('IAdmin', '/src/types.ts', 20, 0);

      assert.notStrictEqual(iface1.id, iface2.id);
    });
  });

  describe('Validation of required fields', () => {
    it('should throw when name is missing', () => {
      assert.throws(() => {
        NodeFactory.createInterface('', '/file.ts', 5, 0);
      }, /name is required/);
    });

    it('should throw when file is missing', () => {
      assert.throws(() => {
        NodeFactory.createInterface('IUser', '', 5, 0);
      }, /file is required/);
    });

    it('should throw when line is missing', () => {
      assert.throws(() => {
        NodeFactory.createInterface('IUser', '/file.ts', 0, 0);
      }, /line is required/);
    });
  });

  describe('NodeFactory validation', () => {
    it('should pass validation for valid interface node', () => {
      const node = NodeFactory.createInterface(
        'IUser',
        '/project/src/types.ts',
        5,
        3
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });
  });
});

// ============================================================================
// 5. createType() Tests
// ============================================================================

describe('NodeFactory.createType', () => {
  describe('Basic type node creation', () => {
    it('should create type alias with required fields only', () => {
      const node = NodeFactory.createType(
        'UserId',
        '/project/src/types.ts',
        10,
        0
      );

      assert.strictEqual(node.type, 'TYPE');
      assert.strictEqual(node.name, 'UserId');
      assert.strictEqual(node.file, '/project/src/types.ts');
      assert.strictEqual(node.line, 10);
      assert.strictEqual(node.column, 0);
      // Defaults
      assert.strictEqual(node.aliasOf, undefined);
    });

    it('should create type alias with aliasOf option', () => {
      const node = NodeFactory.createType(
        'UserId',
        '/project/src/types.ts',
        10,
        0,
        { aliasOf: 'string | number' }
      );

      assert.strictEqual(node.aliasOf, 'string | number');
    });

    it('should handle complex union types', () => {
      const node = NodeFactory.createType(
        'Result',
        '/project/src/types.ts',
        15,
        0,
        { aliasOf: '{ success: true; data: T } | { success: false; error: Error }' }
      );

      assert.strictEqual(
        node.aliasOf,
        '{ success: true; data: T } | { success: false; error: Error }'
      );
    });
  });

  describe('ID format verification', () => {
    it('should generate ID with pattern: file:TYPE:name:line', () => {
      const node = NodeFactory.createType(
        'UserId',
        '/project/src/types.ts',
        10,
        0
      );

      assert.strictEqual(
        node.id,
        '/project/src/types.ts:TYPE:UserId:10'
      );
    });

    it('should create unique IDs for different types', () => {
      const type1 = NodeFactory.createType('UserId', '/src/types.ts', 10, 0);
      const type2 = NodeFactory.createType('ProductId', '/src/types.ts', 15, 0);

      assert.notStrictEqual(type1.id, type2.id);
    });
  });

  describe('Validation of required fields', () => {
    it('should throw when name is missing', () => {
      assert.throws(() => {
        NodeFactory.createType('', '/file.ts', 10, 0);
      }, /name is required/);
    });

    it('should throw when file is missing', () => {
      assert.throws(() => {
        NodeFactory.createType('UserId', '', 10, 0);
      }, /file is required/);
    });

    it('should throw when line is missing', () => {
      assert.throws(() => {
        NodeFactory.createType('UserId', '/file.ts', 0, 0);
      }, /line is required/);
    });
  });

  describe('NodeFactory validation', () => {
    it('should pass validation for valid type node', () => {
      const node = NodeFactory.createType(
        'UserId',
        '/project/src/types.ts',
        10,
        6,
        { aliasOf: 'string' }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });
  });
});

// ============================================================================
// 6. createEnum() Tests
// ============================================================================

describe('NodeFactory.createEnum', () => {
  describe('Basic enum node creation', () => {
    it('should create enum with required fields only', () => {
      const node = NodeFactory.createEnum(
        'Status',
        '/project/src/types.ts',
        20,
        0
      );

      assert.strictEqual(node.type, 'ENUM');
      assert.strictEqual(node.name, 'Status');
      assert.strictEqual(node.file, '/project/src/types.ts');
      assert.strictEqual(node.line, 20);
      assert.strictEqual(node.column, 0);
      // Defaults
      assert.strictEqual(node.isConst, false);
      assert.deepStrictEqual(node.members, []);
    });

    it('should create enum with all options', () => {
      const node = NodeFactory.createEnum(
        'Status',
        '/project/src/types.ts',
        20,
        0,
        {
          isConst: true,
          members: [
            { name: 'Active', value: 'active' },
            { name: 'Inactive', value: 'inactive' },
            { name: 'Pending', value: 'pending' }
          ]
        }
      );

      assert.strictEqual(node.isConst, true);
      assert.strictEqual(node.members.length, 3);
      assert.strictEqual(node.members[0].name, 'Active');
      assert.strictEqual(node.members[0].value, 'active');
    });

    it('should handle numeric enum values', () => {
      const node = NodeFactory.createEnum(
        'Priority',
        '/project/src/types.ts',
        30,
        0,
        {
          members: [
            { name: 'Low', value: 0 },
            { name: 'Medium', value: 1 },
            { name: 'High', value: 2 }
          ]
        }
      );

      assert.strictEqual(node.members[0].value, 0);
      assert.strictEqual(node.members[2].value, 2);
    });
  });

  describe('ID format verification', () => {
    it('should generate ID with pattern: file:ENUM:name:line', () => {
      const node = NodeFactory.createEnum(
        'Status',
        '/project/src/types.ts',
        20,
        0
      );

      assert.strictEqual(
        node.id,
        '/project/src/types.ts:ENUM:Status:20'
      );
    });

    it('should create unique IDs for different enums', () => {
      const enum1 = NodeFactory.createEnum('Status', '/src/types.ts', 20, 0);
      const enum2 = NodeFactory.createEnum('Priority', '/src/types.ts', 40, 0);

      assert.notStrictEqual(enum1.id, enum2.id);
    });
  });

  describe('Validation of required fields', () => {
    it('should throw when name is missing', () => {
      assert.throws(() => {
        NodeFactory.createEnum('', '/file.ts', 20, 0);
      }, /name is required/);
    });

    it('should throw when file is missing', () => {
      assert.throws(() => {
        NodeFactory.createEnum('Status', '', 20, 0);
      }, /file is required/);
    });

    it('should throw when line is missing', () => {
      assert.throws(() => {
        NodeFactory.createEnum('Status', '/file.ts', 0, 0);
      }, /line is required/);
    });
  });

  describe('NodeFactory validation', () => {
    it('should pass validation for valid enum node', () => {
      const node = NodeFactory.createEnum(
        'Status',
        '/project/src/types.ts',
        20,
        5,
        { isConst: true }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });
  });
});

// ============================================================================
// 7. createDecorator() Tests
// ============================================================================

describe('NodeFactory.createDecorator', () => {
  describe('Basic decorator node creation', () => {
    it('should create decorator with required fields', () => {
      const node = NodeFactory.createDecorator(
        'Injectable',
        '/project/src/services/UserService.ts',
        5,
        0,
        '/project/src/services/UserService.ts:CLASS:UserService:6',
        'CLASS'
      );

      assert.strictEqual(node.type, 'DECORATOR');
      assert.strictEqual(node.name, 'Injectable');
      assert.strictEqual(node.file, '/project/src/services/UserService.ts');
      assert.strictEqual(node.line, 5);
      assert.strictEqual(node.column, 0);
      assert.strictEqual(node.targetId, '/project/src/services/UserService.ts:CLASS:UserService:6');
      assert.strictEqual(node.targetType, 'CLASS');
      // Defaults
      assert.deepStrictEqual(node.arguments, []);
    });

    it('should create decorator with arguments', () => {
      const node = NodeFactory.createDecorator(
        'Injectable',
        '/project/src/services/UserService.ts',
        5,
        0,
        '/project/src/services/UserService.ts:CLASS:UserService:6',
        'CLASS',
        { arguments: [{ providedIn: 'root' }] }
      );

      assert.deepStrictEqual(node.arguments, [{ providedIn: 'root' }]);
    });

    it('should create method decorator', () => {
      const node = NodeFactory.createDecorator(
        'Get',
        '/project/src/controllers/UserController.ts',
        15,
        2,
        '/project/src/controllers/UserController.ts:METHOD:getUser:16',
        'METHOD',
        { arguments: ['/users/:id'] }
      );

      assert.strictEqual(node.targetType, 'METHOD');
      assert.deepStrictEqual(node.arguments, ['/users/:id']);
    });

    it('should create property decorator', () => {
      const node = NodeFactory.createDecorator(
        'Column',
        '/project/src/entities/User.ts',
        10,
        2,
        '/project/src/entities/User.ts:PROPERTY:name:11',
        'PROPERTY',
        { arguments: [{ type: 'varchar', length: 255 }] }
      );

      assert.strictEqual(node.targetType, 'PROPERTY');
    });

    it('should create parameter decorator', () => {
      const node = NodeFactory.createDecorator(
        'Body',
        '/project/src/controllers/UserController.ts',
        20,
        15,
        '/project/src/controllers/UserController.ts:PARAMETER:data:20',
        'PARAMETER'
      );

      assert.strictEqual(node.targetType, 'PARAMETER');
    });
  });

  describe('ID format verification', () => {
    it('should generate ID with pattern: file:DECORATOR:name:line:column', () => {
      const node = NodeFactory.createDecorator(
        'Injectable',
        '/project/src/services/UserService.ts',
        5,
        0,
        'target-id',
        'CLASS'
      );

      assert.strictEqual(
        node.id,
        '/project/src/services/UserService.ts:DECORATOR:Injectable:5:0'
      );
    });

    it('should create unique IDs for multiple decorators on same element', () => {
      // Two decorators at different lines/columns
      const decorator1 = NodeFactory.createDecorator(
        'Injectable',
        '/src/service.ts',
        5,
        0,
        'target-id',
        'CLASS'
      );
      const decorator2 = NodeFactory.createDecorator(
        'Singleton',
        '/src/service.ts',
        6,
        0,
        'target-id',
        'CLASS'
      );

      assert.notStrictEqual(decorator1.id, decorator2.id);
    });
  });

  describe('Validation of required fields', () => {
    it('should throw when name is missing', () => {
      assert.throws(() => {
        NodeFactory.createDecorator('', '/file.ts', 5, 0, 'target', 'CLASS');
      }, /name is required/);
    });

    it('should throw when file is missing', () => {
      assert.throws(() => {
        NodeFactory.createDecorator('Injectable', '', 5, 0, 'target', 'CLASS');
      }, /file is required/);
    });

    it('should throw when line is missing', () => {
      assert.throws(() => {
        NodeFactory.createDecorator('Injectable', '/file.ts', 0, 0, 'target', 'CLASS');
      }, /line is required/);
    });

    it('should throw when targetId is missing', () => {
      assert.throws(() => {
        NodeFactory.createDecorator('Injectable', '/file.ts', 5, 0, '', 'CLASS');
      }, /targetId is required/);
    });

    it('should throw when targetType is missing', () => {
      assert.throws(() => {
        // @ts-expect-error - testing runtime validation
        NodeFactory.createDecorator('Injectable', '/file.ts', 5, 0, 'target', '');
      }, /targetType is required/);
    });
  });

  describe('NodeFactory validation', () => {
    it('should pass validation for valid decorator node', () => {
      const node = NodeFactory.createDecorator(
        'Injectable',
        '/project/src/services/UserService.ts',
        5,
        1,
        'target-id',
        'CLASS',
        { arguments: [{ providedIn: 'root' }] }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });
  });
});

// ============================================================================
// 8. createExpression() Tests
// ============================================================================

describe('NodeFactory.createExpression', () => {
  describe('Basic expression node creation', () => {
    it('should create expression with required fields only', () => {
      const node = NodeFactory.createExpression(
        'MemberExpression',
        '/project/src/app.ts',
        25,
        10
      );

      assert.strictEqual(node.type, 'EXPRESSION');
      assert.strictEqual(node.expressionType, 'MemberExpression');
      assert.strictEqual(node.file, '/project/src/app.ts');
      assert.strictEqual(node.line, 25);
      assert.strictEqual(node.column, 10);
    });
  });

  describe('MemberExpression', () => {
    it('should create MemberExpression: user.name', () => {
      const node = NodeFactory.createExpression(
        'MemberExpression',
        '/project/src/app.ts',
        25,
        10,
        {
          object: 'user',
          property: 'name',
          path: 'user.name'
        }
      );

      assert.strictEqual(node.expressionType, 'MemberExpression');
      assert.strictEqual(node.object, 'user');
      assert.strictEqual(node.property, 'name');
      assert.strictEqual(node.path, 'user.name');
      assert.strictEqual(node.computed, undefined);
    });

    it('should create computed MemberExpression: obj[key]', () => {
      const node = NodeFactory.createExpression(
        'MemberExpression',
        '/project/src/app.ts',
        30,
        5,
        {
          object: 'obj',
          property: 'key',
          computed: true,
          computedPropertyVar: 'key'
        }
      );

      assert.strictEqual(node.computed, true);
      assert.strictEqual(node.computedPropertyVar, 'key');
    });

    it('should create deep property path: user.profile.avatar.url', () => {
      const node = NodeFactory.createExpression(
        'MemberExpression',
        '/project/src/app.ts',
        35,
        10,
        {
          baseName: 'user',
          propertyPath: ['profile', 'avatar', 'url'],
          path: 'user.profile.avatar.url'
        }
      );

      assert.strictEqual(node.baseName, 'user');
      assert.deepStrictEqual(node.propertyPath, ['profile', 'avatar', 'url']);
    });

    it('should create array index access: items[0]', () => {
      const node = NodeFactory.createExpression(
        'MemberExpression',
        '/project/src/app.ts',
        40,
        5,
        {
          object: 'items',
          computed: true,
          arrayIndex: 0
        }
      );

      assert.strictEqual(node.computed, true);
      assert.strictEqual(node.arrayIndex, 0);
    });
  });

  describe('BinaryExpression', () => {
    it('should create BinaryExpression: a + b', () => {
      const node = NodeFactory.createExpression(
        'BinaryExpression',
        '/project/src/calc.ts',
        50,
        5,
        { operator: '+' }
      );

      assert.strictEqual(node.expressionType, 'BinaryExpression');
      assert.strictEqual(node.operator, '+');
    });

    it('should handle comparison operators', () => {
      const node = NodeFactory.createExpression(
        'BinaryExpression',
        '/project/src/calc.ts',
        55,
        5,
        { operator: '===' }
      );

      assert.strictEqual(node.operator, '===');
    });
  });

  describe('LogicalExpression', () => {
    it('should create LogicalExpression: a && b', () => {
      const node = NodeFactory.createExpression(
        'LogicalExpression',
        '/project/src/logic.ts',
        60,
        5,
        { operator: '&&' }
      );

      assert.strictEqual(node.expressionType, 'LogicalExpression');
      assert.strictEqual(node.operator, '&&');
    });

    it('should create nullish coalescing: a ?? b', () => {
      const node = NodeFactory.createExpression(
        'LogicalExpression',
        '/project/src/logic.ts',
        65,
        5,
        { operator: '??' }
      );

      assert.strictEqual(node.operator, '??');
    });
  });

  describe('ID format verification', () => {
    it('should generate ID with pattern: file:EXPRESSION:type:line:column', () => {
      const node = NodeFactory.createExpression(
        'MemberExpression',
        '/project/src/app.ts',
        25,
        10
      );

      assert.strictEqual(
        node.id,
        '/project/src/app.ts:EXPRESSION:MemberExpression:25:10'
      );
    });

    it('should create unique IDs for different expressions', () => {
      const expr1 = NodeFactory.createExpression('MemberExpression', '/src/app.ts', 25, 10);
      const expr2 = NodeFactory.createExpression('BinaryExpression', '/src/app.ts', 25, 20);

      assert.notStrictEqual(expr1.id, expr2.id);
    });

    it('should allow path-based ID format when path provided', () => {
      const node = NodeFactory.createExpression(
        'MemberExpression',
        '/project/src/app.ts',
        25,
        10,
        { path: 'user.name' }
      );

      // Implementation may use path for different ID format
      // Just verify ID is present and consistent
      assert.ok(node.id);
      assert.ok(node.id.includes('EXPRESSION'));
    });
  });

  describe('Validation of required fields', () => {
    it('should throw when expressionType is missing', () => {
      assert.throws(() => {
        NodeFactory.createExpression('', '/file.ts', 25, 10);
      }, /expressionType is required/);
    });

    it('should throw when file is missing', () => {
      assert.throws(() => {
        NodeFactory.createExpression('MemberExpression', '', 25, 10);
      }, /file is required/);
    });

    it('should throw when line is missing', () => {
      assert.throws(() => {
        NodeFactory.createExpression('MemberExpression', '/file.ts', 0, 10);
      }, /line is required/);
    });
  });

  describe('NodeFactory validation', () => {
    it('should pass validation for valid MemberExpression', () => {
      const node = NodeFactory.createExpression(
        'MemberExpression',
        '/project/src/app.ts',
        25,
        10,
        { object: 'user', property: 'name' }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('should pass validation for valid BinaryExpression', () => {
      const node = NodeFactory.createExpression(
        'BinaryExpression',
        '/project/src/calc.ts',
        50,
        5,
        { operator: '+' }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0);
    });
  });
});

// ============================================================================
// Cross-cutting concerns
// ============================================================================

describe('NodeFactory Part 1 - Cross-cutting concerns', () => {
  describe('All factory methods handle empty options gracefully', () => {
    it('createClass with undefined options', () => {
      const node = NodeFactory.createClass('MyClass', '/file.ts', 1, 0);
      assert.strictEqual(node.type, 'CLASS');
    });

    it('createExport with undefined options', () => {
      const node = NodeFactory.createExport('myExport', '/file.ts', 1, 0);
      assert.strictEqual(node.type, 'EXPORT');
    });

    it('createInterface with undefined options', () => {
      const node = NodeFactory.createInterface('IMyInterface', '/file.ts', 1, 0);
      assert.strictEqual(node.type, 'INTERFACE');
    });

    it('createType with undefined options', () => {
      const node = NodeFactory.createType('MyType', '/file.ts', 1, 0);
      assert.strictEqual(node.type, 'TYPE');
    });

    it('createEnum with undefined options', () => {
      const node = NodeFactory.createEnum('MyEnum', '/file.ts', 1, 0);
      assert.strictEqual(node.type, 'ENUM');
    });

    it('createExpression with undefined options', () => {
      const node = NodeFactory.createExpression('MemberExpression', '/file.ts', 1, 0);
      assert.strictEqual(node.type, 'EXPRESSION');
    });
  });

  describe('All nodes have required base fields', () => {
    it('all nodes should have id, type, name, file, line', () => {
      const nodes = [
        NodeFactory.createClass('MyClass', '/file.ts', 1, 0),
        NodeFactory.createExport('myExport', '/file.ts', 2, 0),
        NodeFactory.createExternalModule('lodash'),
        NodeFactory.createInterface('IUser', '/file.ts', 3, 0),
        NodeFactory.createType('UserId', '/file.ts', 4, 0),
        NodeFactory.createEnum('Status', '/file.ts', 5, 0),
        NodeFactory.createDecorator('Injectable', '/file.ts', 6, 0, 'target', 'CLASS'),
        NodeFactory.createExpression('MemberExpression', '/file.ts', 7, 0)
      ];

      for (const node of nodes) {
        assert.ok(node.id, `${node.type} should have id`);
        assert.ok(node.type, `Node should have type`);
        assert.ok(typeof node.file === 'string', `${node.type} should have file`);
        assert.ok(typeof node.line === 'number', `${node.type} should have line`);
      }
    });
  });
});

/**
 * NodeFactory.createImport() Tests
 *
 * Tests for migrating IMPORT node creation to NodeFactory pattern.
 * Validates semantic IDs, auto-detection, field structure, and validation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NodeFactory } from '@grafema/core';

describe('NodeFactory.createImport', () => {
  describe('Basic import node creation', () => {
    it('should create default import with semantic ID', () => {
      const node = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'default', local: 'React' }
      );

      assert.strictEqual(node.type, 'IMPORT');
      assert.strictEqual(node.name, 'React');
      assert.strictEqual(node.source, 'react');
      assert.strictEqual(node.importType, 'default');
      assert.strictEqual(node.importBinding, 'value');
      assert.strictEqual(node.imported, 'default');
      assert.strictEqual(node.local, 'React');
      // SEMANTIC ID: no line number
      assert.strictEqual(node.id, '/project/src/App.js:IMPORT:react:React');
      // Line stored as field
      assert.strictEqual(node.line, 1);
      assert.strictEqual(node.file, '/project/src/App.js');
    });

    it('should create named import with semantic ID', () => {
      const node = NodeFactory.createImport(
        'useState',
        '/project/src/App.js',
        2,
        0,
        'react',
        { imported: 'useState', local: 'useState' }
      );

      assert.strictEqual(node.type, 'IMPORT');
      assert.strictEqual(node.importType, 'named');
      assert.strictEqual(node.imported, 'useState');
      assert.strictEqual(node.local, 'useState');
      assert.strictEqual(node.id, '/project/src/App.js:IMPORT:react:useState');
      assert.strictEqual(node.line, 2);
    });

    it('should create namespace import with semantic ID', () => {
      const node = NodeFactory.createImport(
        'fs',
        '/project/src/App.js',
        3,
        0,
        'fs',
        { imported: '*', local: 'fs' }
      );

      assert.strictEqual(node.type, 'IMPORT');
      assert.strictEqual(node.importType, 'namespace');
      assert.strictEqual(node.imported, '*');
      assert.strictEqual(node.local, 'fs');
      assert.strictEqual(node.id, '/project/src/App.js:IMPORT:fs:fs');
      assert.strictEqual(node.line, 3);
    });
  });

  describe('Auto-detection of importType', () => {
    it('should auto-detect default import from imported field', () => {
      const node = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'default' }
      );

      assert.strictEqual(node.importType, 'default');
    });

    it('should auto-detect namespace import from imported field', () => {
      const node = NodeFactory.createImport(
        'fs',
        '/project/src/App.js',
        2,
        0,
        'fs',
        { imported: '*' }
      );

      assert.strictEqual(node.importType, 'namespace');
    });

    it('should auto-detect named import from imported field', () => {
      const node = NodeFactory.createImport(
        'useState',
        '/project/src/App.js',
        3,
        0,
        'react',
        { imported: 'useState' }
      );

      assert.strictEqual(node.importType, 'named');
    });

    it('should allow explicit importType override', () => {
      const node = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        {
          imported: 'default',
          importType: 'named'  // Explicit override
        }
      );

      // When explicitly provided, should use that value
      assert.strictEqual(node.importType, 'named');
    });
  });

  describe('Semantic ID stability', () => {
    it('should create stable IDs (same binding, different lines)', () => {
      const node1 = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'default' }
      );

      // Add empty line, import moves to line 2
      const node2 = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        2,  // ← Different line
        0,
        'react',
        { imported: 'default' }
      );

      // IDs should be SAME - semantic identity
      assert.strictEqual(node1.id, node2.id);
      assert.strictEqual(node1.id, '/project/src/App.js:IMPORT:react:React');

      // But line fields are different
      assert.strictEqual(node1.line, 1);
      assert.strictEqual(node2.line, 2);
    });

    it('should create different IDs for different sources', () => {
      const reactNode = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'default' }
      );

      const preactNode = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        2,
        0,
        'preact/compat',
        { imported: 'default' }
      );

      // Different sources → different IDs
      assert.notStrictEqual(reactNode.id, preactNode.id);
      assert.strictEqual(reactNode.id, '/project/src/App.js:IMPORT:react:React');
      assert.strictEqual(preactNode.id, '/project/src/App.js:IMPORT:preact/compat:React');
    });

    it('should create different IDs for different local bindings', () => {
      const node1 = NodeFactory.createImport(
        'useState',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'useState', local: 'useState' }
      );

      const node2 = NodeFactory.createImport(
        'useStateAlias',
        '/project/src/App.js',
        2,
        0,
        'react',
        { imported: 'useState', local: 'useStateAlias' }
      );

      // Different local bindings → different IDs
      assert.notStrictEqual(node1.id, node2.id);
      assert.strictEqual(node1.id, '/project/src/App.js:IMPORT:react:useState');
      assert.strictEqual(node2.id, '/project/src/App.js:IMPORT:react:useStateAlias');
    });

    it('should create different IDs for different files', () => {
      const node1 = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'default' }
      );

      const node2 = NodeFactory.createImport(
        'React',
        '/project/src/Other.js',
        1,
        0,
        'react',
        { imported: 'default' }
      );

      // Different files → different IDs
      assert.notStrictEqual(node1.id, node2.id);
      assert.strictEqual(node1.id, '/project/src/App.js:IMPORT:react:React');
      assert.strictEqual(node2.id, '/project/src/Other.js:IMPORT:react:React');
    });
  });

  describe('ImportBinding (value/type/typeof)', () => {
    it('should create value import node', () => {
      const node = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        {
          imported: 'default',
          importBinding: 'value'
        }
      );

      assert.strictEqual(node.importBinding, 'value');
    });

    it('should create type import node', () => {
      const node = NodeFactory.createImport(
        'User',
        '/project/src/types.ts',
        1,
        0,
        './user',
        {
          imported: 'User',
          importBinding: 'type'
        }
      );

      assert.strictEqual(node.importType, 'named');
      assert.strictEqual(node.importBinding, 'type');
    });

    it('should create typeof import node', () => {
      const node = NodeFactory.createImport(
        'Config',
        '/project/src/config.ts',
        1,
        0,
        './constants',
        {
          imported: 'Config',
          importBinding: 'typeof'
        }
      );

      assert.strictEqual(node.importBinding, 'typeof');
    });

    it('should default to value binding when not specified', () => {
      const node = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'default' }
      );

      assert.strictEqual(node.importBinding, 'value');
    });
  });

  describe('Default values for optional fields', () => {
    it('should use defaults when options is empty', () => {
      const node = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        {}
      );

      assert.strictEqual(node.importType, 'named'); // default when no imported field
      assert.strictEqual(node.importBinding, 'value'); // default
      assert.strictEqual(node.imported, 'React'); // defaults to name
      assert.strictEqual(node.local, 'React'); // defaults to name
      assert.strictEqual(node.column, 0); // default
    });

    it('should default imported and local to name', () => {
      const node = NodeFactory.createImport(
        'myLib',
        '/project/src/App.js',
        1,
        0,
        './myLib'
      );

      assert.strictEqual(node.imported, 'myLib');
      assert.strictEqual(node.local, 'myLib');
    });

    it('should handle column = 0 (JSASTAnalyzer limitation)', () => {
      const node = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'default' }
      );

      assert.strictEqual(node.column, 0);
    });
  });

  describe('Validation of required fields', () => {
    it('should throw when name is missing', () => {
      assert.throws(() => {
        NodeFactory.createImport('', '/file.js', 1, 0, 'react');
      }, /name is required/);
    });

    it('should throw when file is missing', () => {
      assert.throws(() => {
        NodeFactory.createImport('React', '', 1, 0, 'react');
      }, /file is required/);
    });

    it('should throw when line is undefined', () => {
      assert.throws(() => {
        NodeFactory.createImport('React', '/file.js', undefined, 0, 'react');
      }, /line is required/);
    });

    it('should accept line=0 as valid (unlike undefined)', () => {
      const node = NodeFactory.createImport(
        'React',
        '/file.js',
        0,
        0,
        'react',
        { imported: 'default' }
      );

      assert.strictEqual(node.line, 0);
      assert.strictEqual(node.type, 'IMPORT');
      assert.strictEqual(node.id, '/file.js:IMPORT:react:React');
    });

    it('should throw when source is missing', () => {
      assert.throws(() => {
        NodeFactory.createImport('React', '/file.js', 1, 0, '');
      }, /source is required/);
    });
  });

  describe('NodeFactory validation', () => {
    it('should pass validation for valid import node', () => {
      const node = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'default' }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0,
        `Expected no errors, got: ${JSON.stringify(errors)}`);
    });

    it('should pass validation for named import', () => {
      const node = NodeFactory.createImport(
        'useState',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'useState', local: 'useState' }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0);
    });

    it('should pass validation for namespace import', () => {
      const node = NodeFactory.createImport(
        'fs',
        '/project/src/App.js',
        1,
        0,
        'fs',
        { imported: '*', local: 'fs' }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0);
    });

    it('should pass validation for type import', () => {
      const node = NodeFactory.createImport(
        'User',
        '/project/src/types.ts',
        1,
        0,
        './user',
        { imported: 'User', importBinding: 'type' }
      );

      const errors = NodeFactory.validate(node);
      assert.strictEqual(errors.length, 0);
    });
  });

  describe('Edge cases and special characters', () => {
    it('should handle relative path imports', () => {
      const node = NodeFactory.createImport(
        'utils',
        '/project/src/App.js',
        1,
        0,
        './utils',
        { imported: 'utils' }
      );

      assert.strictEqual(node.source, './utils');
      assert.strictEqual(node.id, '/project/src/App.js:IMPORT:./utils:utils');
    });

    it('should handle parent directory imports', () => {
      const node = NodeFactory.createImport(
        'config',
        '/project/src/App.js',
        1,
        0,
        '../config',
        { imported: 'config' }
      );

      assert.strictEqual(node.source, '../config');
      assert.strictEqual(node.id, '/project/src/App.js:IMPORT:../config:config');
    });

    it('should handle scoped package imports', () => {
      const node = NodeFactory.createImport(
        'useQuery',
        '/project/src/App.js',
        1,
        0,
        '@tanstack/react-query',
        { imported: 'useQuery' }
      );

      assert.strictEqual(node.source, '@tanstack/react-query');
      assert.strictEqual(node.id, '/project/src/App.js:IMPORT:@tanstack/react-query:useQuery');
    });

    it('should handle imports with special characters in names', () => {
      const node = NodeFactory.createImport(
        '$effect',
        '/project/src/App.svelte',
        1,
        0,
        'svelte',
        { imported: '$effect' }
      );

      assert.strictEqual(node.name, '$effect');
      assert.strictEqual(node.imported, '$effect');
      assert.strictEqual(node.id, '/project/src/App.svelte:IMPORT:svelte:$effect');
    });

    it('should handle aliased imports', () => {
      const node = NodeFactory.createImport(
        'MyReact',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'default', local: 'MyReact' }
      );

      assert.strictEqual(node.name, 'MyReact');
      assert.strictEqual(node.imported, 'default');
      assert.strictEqual(node.local, 'MyReact');
      // ID uses local binding name
      assert.strictEqual(node.id, '/project/src/App.js:IMPORT:react:MyReact');
    });
  });

  describe('ID format verification', () => {
    it('should follow semantic ID pattern: file:IMPORT:source:local', () => {
      const node = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'default' }
      );

      const parts = node.id.split(':');
      assert.strictEqual(parts.length, 4);
      assert.strictEqual(parts[0], '/project/src/App.js');
      assert.strictEqual(parts[1], 'IMPORT');
      assert.strictEqual(parts[2], 'react');
      assert.strictEqual(parts[3], 'React');
    });

    it('should NOT include line number in ID', () => {
      const node = NodeFactory.createImport(
        'React',
        '/project/src/App.js',
        42,
        0,
        'react',
        { imported: 'default' }
      );

      // ID should not contain line number 42
      assert.ok(!node.id.includes(':42'),
        `ID should not contain line number: ${node.id}`);

      // But line should be stored as field
      assert.strictEqual(node.line, 42);
    });
  });

  describe('Multiple imports from same source', () => {
    it('should create unique IDs for multiple named imports', () => {
      const useState = NodeFactory.createImport(
        'useState',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'useState' }
      );

      const useEffect = NodeFactory.createImport(
        'useEffect',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'useEffect' }
      );

      const useCallback = NodeFactory.createImport(
        'useCallback',
        '/project/src/App.js',
        1,
        0,
        'react',
        { imported: 'useCallback' }
      );

      // All from same source and line, but different local names
      assert.notStrictEqual(useState.id, useEffect.id);
      assert.notStrictEqual(useEffect.id, useCallback.id);
      assert.notStrictEqual(useState.id, useCallback.id);

      // Verify they all have correct structure
      assert.strictEqual(useState.id, '/project/src/App.js:IMPORT:react:useState');
      assert.strictEqual(useEffect.id, '/project/src/App.js:IMPORT:react:useEffect');
      assert.strictEqual(useCallback.id, '/project/src/App.js:IMPORT:react:useCallback');
    });
  });
});

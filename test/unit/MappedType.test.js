/**
 * Mapped Type Tests (REG-305)
 *
 * Verifies:
 * 1. TypeNode.create() with mapped type metadata fields
 * 2. typeNodeToString() handles TSMappedType, TSTypeOperator, TSIndexedAccessType
 * 3. TypeScriptVisitor extracts mapped type metadata from TSTypeAliasDeclaration
 * 4. Full pipeline: TS source → parse → visit → TypeAliasInfo with mapped type data
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '@babel/parser';

import { TypeNode, NodeFactory } from '@grafema/core';
// typeNodeToString is exported from the visitor module
import { typeNodeToString } from '../../packages/core/dist/plugins/analysis/ast/visitors/TypeScriptVisitor.js';

// ============================================================================
// 1. TypeNode.create() with mapped type fields
// ============================================================================

describe('Mapped Type Support (REG-305)', () => {
  describe('TypeNode.create() with mapped type options', () => {
    it('should include mappedType: true when provided', () => {
      const node = TypeNode.create('MyReadonly', '/src/types.ts', 1, 0, {
        aliasOf: '{ readonly [K in keyof T]: T[K] }',
        mappedType: true,
        keyName: 'K',
        keyConstraint: 'keyof T',
        valueType: 'T[K]',
        mappedReadonly: true
      });

      assert.strictEqual(node.mappedType, true);
      assert.strictEqual(node.keyName, 'K');
      assert.strictEqual(node.keyConstraint, 'keyof T');
      assert.strictEqual(node.valueType, 'T[K]');
      assert.strictEqual(node.mappedReadonly, true);
    });

    it('should omit mapped fields when mappedType is not set', () => {
      const node = TypeNode.create('SimpleAlias', '/src/types.ts', 5, 0, {
        aliasOf: 'string'
      });

      assert.strictEqual(node.mappedType, undefined);
      assert.strictEqual(node.keyName, undefined);
      assert.strictEqual(node.keyConstraint, undefined);
      assert.strictEqual(node.valueType, undefined);
    });

    it('should handle mappedOptional modifier', () => {
      const node = TypeNode.create('MyPartial', '/src/types.ts', 10, 0, {
        mappedType: true,
        keyName: 'K',
        keyConstraint: 'keyof T',
        valueType: 'T[K]',
        mappedOptional: true
      });

      assert.strictEqual(node.mappedOptional, true);
    });

    it('should handle "-" modifier for removing readonly', () => {
      const node = TypeNode.create('Mutable', '/src/types.ts', 15, 0, {
        mappedType: true,
        keyName: 'K',
        keyConstraint: 'keyof T',
        valueType: 'T[K]',
        mappedReadonly: '-'
      });

      assert.strictEqual(node.mappedReadonly, '-');
    });

    it('should handle "+" modifier', () => {
      const node = TypeNode.create('Required', '/src/types.ts', 20, 0, {
        mappedType: true,
        keyName: 'K',
        keyConstraint: 'keyof T',
        valueType: 'T[K]',
        mappedOptional: '-',
        mappedReadonly: '+'
      });

      assert.strictEqual(node.mappedReadonly, '+');
      assert.strictEqual(node.mappedOptional, '-');
    });

    it('should include nameType for key remapping (as clause)', () => {
      const node = TypeNode.create('Renamed', '/src/types.ts', 25, 0, {
        mappedType: true,
        keyName: 'K',
        keyConstraint: 'keyof T',
        valueType: 'T[K]',
        nameType: 'Uppercase'
      });

      assert.strictEqual(node.nameType, 'Uppercase');
    });

    it('should pass validation with mapped type fields', () => {
      const node = TypeNode.create('MappedType', '/src/types.ts', 1, 0, {
        mappedType: true,
        keyName: 'K',
        keyConstraint: 'keyof T',
        valueType: 'T[K]',
        mappedReadonly: true
      });

      const errors = TypeNode.validate(node);
      assert.strictEqual(errors.length, 0,
        `Should have no validation errors, got: ${errors.join(', ')}`);
    });

    it('should work through NodeFactory.createType()', () => {
      const node = NodeFactory.createType('MyReadonly', '/src/types.ts', 1, 0, {
        aliasOf: '{ readonly [K in keyof T]: T[K] }',
        mappedType: true,
        keyName: 'K',
        keyConstraint: 'keyof T',
        valueType: 'T[K]',
        mappedReadonly: true
      });

      assert.strictEqual(node.mappedType, true);
      assert.strictEqual(node.keyName, 'K');
      assert.strictEqual(node.keyConstraint, 'keyof T');
      assert.strictEqual(node.valueType, 'T[K]');
      assert.strictEqual(node.mappedReadonly, true);
    });
  });

  // ============================================================================
  // 2. typeNodeToString() for new AST node types
  // ============================================================================

  describe('typeNodeToString() improvements', () => {
    it('should handle TSTypeOperator (keyof)', () => {
      const result = typeNodeToString({
        type: 'TSTypeOperator',
        operator: 'keyof',
        typeAnnotation: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'T' } }
      });
      assert.strictEqual(result, 'keyof T');
    });

    it('should handle TSTypeOperator (unique)', () => {
      const result = typeNodeToString({
        type: 'TSTypeOperator',
        operator: 'unique',
        typeAnnotation: { type: 'TSSymbolKeyword' }
      });
      assert.strictEqual(result, 'unique symbol');
    });

    it('should handle TSTypeOperator (readonly)', () => {
      const result = typeNodeToString({
        type: 'TSTypeOperator',
        operator: 'readonly',
        typeAnnotation: {
          type: 'TSArrayType',
          elementType: { type: 'TSStringKeyword' }
        }
      });
      assert.strictEqual(result, 'readonly string[]');
    });

    it('should handle TSIndexedAccessType', () => {
      const result = typeNodeToString({
        type: 'TSIndexedAccessType',
        objectType: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'T' } },
        indexType: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'K' } }
      });
      assert.strictEqual(result, 'T[K]');
    });

    it('should handle TSMappedType (readonly)', () => {
      const result = typeNodeToString({
        type: 'TSMappedType',
        readonly: true,
        optional: undefined,
        typeParameter: {
          name: 'K',
          constraint: {
            type: 'TSTypeOperator',
            operator: 'keyof',
            typeAnnotation: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'T' } }
          }
        },
        typeAnnotation: {
          type: 'TSIndexedAccessType',
          objectType: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'T' } },
          indexType: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'K' } }
        },
        nameType: null
      });
      assert.strictEqual(result, '{ readonly [K in keyof T]: T[K] }');
    });

    it('should handle TSMappedType with "-readonly" modifier', () => {
      const result = typeNodeToString({
        type: 'TSMappedType',
        readonly: '-',
        optional: undefined,
        typeParameter: {
          name: 'K',
          constraint: {
            type: 'TSTypeOperator',
            operator: 'keyof',
            typeAnnotation: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'T' } }
          }
        },
        typeAnnotation: {
          type: 'TSIndexedAccessType',
          objectType: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'T' } },
          indexType: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'K' } }
        },
        nameType: null
      });
      assert.strictEqual(result, '{ -readonly [K in keyof T]: T[K] }');
    });

    it('should handle TSMappedType with optional modifier', () => {
      const result = typeNodeToString({
        type: 'TSMappedType',
        readonly: undefined,
        optional: true,
        typeParameter: {
          name: 'P',
          constraint: {
            type: 'TSTypeOperator',
            operator: 'keyof',
            typeAnnotation: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'T' } }
          }
        },
        typeAnnotation: {
          type: 'TSIndexedAccessType',
          objectType: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'T' } },
          indexType: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'P' } }
        },
        nameType: null
      });
      assert.strictEqual(result, '{ [P in keyof T]?: T[P] }');
    });

    it('should handle TSConditionalType', () => {
      const result = typeNodeToString({
        type: 'TSConditionalType',
        checkType: { type: 'TSTypeReference', typeName: { type: 'Identifier', name: 'T' } },
        extendsType: { type: 'TSStringKeyword' },
        trueType: { type: 'TSStringKeyword' },
        falseType: { type: 'TSNumberKeyword' }
      });
      assert.strictEqual(result, 'T extends string ? string : number');
    });

    it('should handle TSInferType', () => {
      const result = typeNodeToString({
        type: 'TSInferType',
        typeParameter: { name: 'R' }
      });
      assert.strictEqual(result, 'infer R');
    });
  });

  // ============================================================================
  // 3. Integration: parse real TS code and verify TypeAliasInfo
  // ============================================================================

  describe('Integration: TypeScriptVisitor extracts mapped type metadata', () => {
    /**
     * Helper: parse TS code and run TypeScriptVisitor, return typeAliases
     */
    async function extractTypeAliases(code) {
      const { TypeScriptVisitor } = await import(
        '../../packages/core/dist/plugins/analysis/ast/visitors/TypeScriptVisitor.js'
      );

      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['typescript']
      });

      const collections = {
        interfaces: [],
        typeAliases: [],
        enums: []
      };

      const visitor = new TypeScriptVisitor(
        { file: '/test/mapped.ts' },
        collections
      );

      const handlers = visitor.getHandlers();

      // Walk the AST manually to find TSTypeAliasDeclaration nodes
      for (const stmt of ast.program.body) {
        if (stmt.type === 'TSTypeAliasDeclaration') {
          handlers.TSTypeAliasDeclaration({ node: stmt });
        }
      }

      return collections.typeAliases;
    }

    it('should detect Readonly<T> as mapped type', async () => {
      const aliases = await extractTypeAliases(`
        type MyReadonly<T> = { readonly [K in keyof T]: T[K] };
      `);

      assert.strictEqual(aliases.length, 1);
      const alias = aliases[0];

      assert.strictEqual(alias.name, 'MyReadonly');
      assert.strictEqual(alias.mappedType, true);
      assert.strictEqual(alias.keyName, 'K');
      assert.strictEqual(alias.keyConstraint, 'keyof T');
      assert.strictEqual(alias.valueType, 'T[K]');
      assert.strictEqual(alias.mappedReadonly, true);
    });

    it('should detect Partial<T> as mapped type', async () => {
      const aliases = await extractTypeAliases(`
        type MyPartial<T> = { [P in keyof T]?: T[P] };
      `);

      assert.strictEqual(aliases.length, 1);
      const alias = aliases[0];

      assert.strictEqual(alias.mappedType, true);
      assert.strictEqual(alias.keyName, 'P');
      assert.strictEqual(alias.keyConstraint, 'keyof T');
      assert.strictEqual(alias.valueType, 'T[P]');
      assert.strictEqual(alias.mappedOptional, true);
    });

    it('should detect Mutable<T> with -readonly modifier', async () => {
      const aliases = await extractTypeAliases(`
        type Mutable<T> = { -readonly [K in keyof T]: T[K] };
      `);

      assert.strictEqual(aliases.length, 1);
      const alias = aliases[0];

      assert.strictEqual(alias.mappedType, true);
      assert.strictEqual(alias.mappedReadonly, '-');
    });

    it('should detect Required<T> with -? modifier', async () => {
      const aliases = await extractTypeAliases(`
        type MyRequired<T> = { [P in keyof T]-?: T[P] };
      `);

      assert.strictEqual(aliases.length, 1);
      const alias = aliases[0];

      assert.strictEqual(alias.mappedType, true);
      assert.strictEqual(alias.mappedOptional, '-');
    });

    it('should detect key remapping with as clause', async () => {
      const aliases = await extractTypeAliases(`
        type Getters<T> = { [K in keyof T as \`get\${string & K}\`]: () => T[K] };
      `);

      assert.strictEqual(aliases.length, 1);
      const alias = aliases[0];

      assert.strictEqual(alias.mappedType, true);
      assert.strictEqual(alias.keyName, 'K');
      assert.ok(alias.nameType, 'should have nameType for as clause');
    });

    it('should NOT set mappedType for simple type aliases', async () => {
      const aliases = await extractTypeAliases(`
        type UserId = string;
        type Status = 'active' | 'inactive';
      `);

      assert.strictEqual(aliases.length, 2);
      assert.strictEqual(aliases[0].mappedType, undefined);
      assert.strictEqual(aliases[1].mappedType, undefined);
    });

    it('should produce meaningful aliasOf string instead of "unknown"', async () => {
      const aliases = await extractTypeAliases(`
        type MyReadonly<T> = { readonly [K in keyof T]: T[K] };
      `);

      assert.strictEqual(aliases.length, 1);
      assert.ok(aliases[0].aliasOf !== 'unknown',
        `aliasOf should not be "unknown", got: ${aliases[0].aliasOf}`);
      assert.ok(aliases[0].aliasOf.includes('keyof T'),
        `aliasOf should contain "keyof T", got: ${aliases[0].aliasOf}`);
    });
  });
});

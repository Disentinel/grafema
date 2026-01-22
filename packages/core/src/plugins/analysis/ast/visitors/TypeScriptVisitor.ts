/**
 * TypeScriptVisitor - handles TypeScript-specific AST nodes
 *
 * Handles:
 * - TSInterfaceDeclaration
 * - TSTypeAliasDeclaration
 * - TSEnumDeclaration
 */

import type {
  TSInterfaceDeclaration,
  TSTypeAliasDeclaration,
  TSEnumDeclaration,
  TSPropertySignature,
  TSMethodSignature,
  Identifier,
  Expression,
  TSExpressionWithTypeArguments
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers } from './ASTVisitor.js';
import type {
  InterfaceDeclarationInfo,
  InterfacePropertyInfo,
  TypeAliasInfo,
  EnumDeclarationInfo,
  EnumMemberInfo
} from '../types.js';
import { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';

/**
 * Extracts a string representation of a TypeScript type node
 */
export function typeNodeToString(node: unknown): string {
  if (!node || typeof node !== 'object') return 'unknown';

  const typeNode = node as { type: string; [key: string]: unknown };

  switch (typeNode.type) {
    case 'TSStringKeyword':
      return 'string';
    case 'TSNumberKeyword':
      return 'number';
    case 'TSBooleanKeyword':
      return 'boolean';
    case 'TSAnyKeyword':
      return 'any';
    case 'TSUnknownKeyword':
      return 'unknown';
    case 'TSVoidKeyword':
      return 'void';
    case 'TSNullKeyword':
      return 'null';
    case 'TSUndefinedKeyword':
      return 'undefined';
    case 'TSNeverKeyword':
      return 'never';
    case 'TSObjectKeyword':
      return 'object';
    case 'TSSymbolKeyword':
      return 'symbol';
    case 'TSBigIntKeyword':
      return 'bigint';
    case 'TSTypeReference':
      const typeName = typeNode.typeName as { type: string; name?: string };
      if (typeName?.type === 'Identifier') {
        return typeName.name || 'unknown';
      }
      return 'unknown';
    case 'TSArrayType':
      return `${typeNodeToString(typeNode.elementType)}[]`;
    case 'TSUnionType':
      const unionTypes = typeNode.types as unknown[];
      return unionTypes.map(t => typeNodeToString(t)).join(' | ');
    case 'TSIntersectionType':
      const intersectionTypes = typeNode.types as unknown[];
      return intersectionTypes.map(t => typeNodeToString(t)).join(' & ');
    case 'TSLiteralType':
      const literal = typeNode.literal as { value?: unknown; type: string };
      if (literal?.type === 'StringLiteral') {
        return `'${literal.value}'`;
      } else if (literal?.type === 'NumericLiteral') {
        return String(literal.value);
      } else if (literal?.type === 'BooleanLiteral') {
        return String(literal.value);
      }
      return 'unknown';
    case 'TSFunctionType':
      return 'function';
    case 'TSTupleType':
      const tupleTypes = typeNode.elementTypes as unknown[];
      return `[${tupleTypes.map(t => typeNodeToString(t)).join(', ')}]`;
    case 'TSTypeLiteral':
      return 'object';
    default:
      return 'unknown';
  }
}

export class TypeScriptVisitor extends ASTVisitor {
  private scopeTracker?: ScopeTracker;

  /**
   * @param module - Current module being analyzed
   * @param collections - Must contain interfaces, typeAliases, enums arrays
   * @param scopeTracker - Optional ScopeTracker for semantic ID generation
   */
  constructor(module: VisitorModule, collections: VisitorCollections, scopeTracker?: ScopeTracker) {
    super(module, collections);
    this.scopeTracker = scopeTracker;
  }

  getHandlers(): VisitorHandlers {
    const { module } = this;
    const {
      interfaces,
      typeAliases,
      enums
    } = this.collections;
    const scopeTracker = this.scopeTracker;

    return {
      TSInterfaceDeclaration: (path: NodePath) => {
        const node = path.node as TSInterfaceDeclaration;
        if (!node.id) return;

        const interfaceName = node.id.name;
        const interfaceId = `INTERFACE#${interfaceName}#${module.file}#${node.loc!.start.line}`;

        // Generate semantic ID if scopeTracker available
        let interfaceSemanticId: string | undefined;
        if (scopeTracker) {
          interfaceSemanticId = computeSemanticId('INTERFACE', interfaceName, scopeTracker.getContext());
        }

        // Extract extends
        const extendsNames: string[] = [];
        if (node.extends && node.extends.length > 0) {
          for (const ext of node.extends) {
            if (ext.expression.type === 'Identifier') {
              extendsNames.push((ext.expression as Identifier).name);
            }
          }
        }

        // Extract properties
        const properties: InterfacePropertyInfo[] = [];
        if (node.body && node.body.body) {
          for (const member of node.body.body) {
            if (member.type === 'TSPropertySignature') {
              const prop = member as TSPropertySignature;
              if (prop.key.type === 'Identifier') {
                properties.push({
                  name: (prop.key as Identifier).name,
                  type: prop.typeAnnotation ? typeNodeToString(prop.typeAnnotation.typeAnnotation) : undefined,
                  optional: prop.optional || false,
                  readonly: prop.readonly || false
                });
              }
            } else if (member.type === 'TSMethodSignature') {
              const method = member as TSMethodSignature;
              if (method.key.type === 'Identifier') {
                properties.push({
                  name: (method.key as Identifier).name,
                  type: 'function',
                  optional: method.optional || false,
                  readonly: false
                });
              }
            }
          }
        }

        (interfaces as InterfaceDeclarationInfo[]).push({
          id: interfaceId,
          semanticId: interfaceSemanticId,
          type: 'INTERFACE',
          name: interfaceName,
          file: module.file,
          line: node.loc!.start.line,
          column: node.loc!.start.column,
          extends: extendsNames.length > 0 ? extendsNames : undefined,
          properties
        });
      },

      TSTypeAliasDeclaration: (path: NodePath) => {
        const node = path.node as TSTypeAliasDeclaration;
        if (!node.id) return;

        const typeName = node.id.name;
        const typeId = `TYPE#${typeName}#${module.file}#${node.loc!.start.line}`;

        // Generate semantic ID if scopeTracker available
        let typeSemanticId: string | undefined;
        if (scopeTracker) {
          typeSemanticId = computeSemanticId('TYPE', typeName, scopeTracker.getContext());
        }

        // Extract the type being aliased
        const aliasOf = typeNodeToString(node.typeAnnotation);

        (typeAliases as TypeAliasInfo[]).push({
          id: typeId,
          semanticId: typeSemanticId,
          type: 'TYPE',
          name: typeName,
          file: module.file,
          line: node.loc!.start.line,
          column: node.loc!.start.column,
          aliasOf
        });
      },

      TSEnumDeclaration: (path: NodePath) => {
        const node = path.node as TSEnumDeclaration;
        if (!node.id) return;

        const enumName = node.id.name;
        const enumId = `ENUM#${enumName}#${module.file}#${node.loc!.start.line}`;

        // Generate semantic ID if scopeTracker available
        let enumSemanticId: string | undefined;
        if (scopeTracker) {
          enumSemanticId = computeSemanticId('ENUM', enumName, scopeTracker.getContext());
        }

        // Extract members
        const members: EnumMemberInfo[] = [];
        if (node.members) {
          for (const member of node.members) {
            if (member.id.type === 'Identifier') {
              const memberInfo: EnumMemberInfo = {
                name: (member.id as Identifier).name
              };

              // Extract value if present
              if (member.initializer) {
                const init = member.initializer as Expression;
                if (init.type === 'StringLiteral') {
                  memberInfo.value = (init as { value: string }).value;
                } else if (init.type === 'NumericLiteral') {
                  memberInfo.value = (init as { value: number }).value;
                }
              }

              members.push(memberInfo);
            }
          }
        }

        (enums as EnumDeclarationInfo[]).push({
          id: enumId,
          semanticId: enumSemanticId,
          type: 'ENUM',
          name: enumName,
          file: module.file,
          line: node.loc!.start.line,
          column: node.loc!.start.column,
          isConst: node.const || false,
          members
        });
      }
    };
  }
}

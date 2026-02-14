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
  Expression
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers } from './ASTVisitor.js';
import type {
  InterfaceDeclarationInfo,
  InterfacePropertyInfo,
  TypeAliasInfo,
  EnumDeclarationInfo,
  EnumMemberInfo,
  TypeParameterInfo
} from '../types.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { getLine, getColumn } from '../utils/location.js';

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

/**
 * Extracts type parameter info from a TSTypeParameterDeclaration node.
 *
 * Handles:
 * - Simple: <T>
 * - Constrained: <T extends Serializable>
 * - Defaulted: <T = string>
 * - Variance: <in T>, <out T>, <in out T>
 * - Intersection constraints: <T extends A & B>
 *
 * @param typeParameters - Babel TSTypeParameterDeclaration node (or undefined)
 * @param parentId - ID of the owning declaration
 * @param parentType - 'FUNCTION' | 'CLASS' | 'INTERFACE' | 'TYPE'
 * @param file - File path
 * @param line - Line of the declaration
 * @param column - Column of the declaration
 * @returns Array of TypeParameterInfo (empty if no type params)
 */
export function extractTypeParameters(
  typeParameters: unknown,
  parentId: string,
  parentType: 'FUNCTION' | 'CLASS' | 'INTERFACE' | 'TYPE',
  file: string,
  line: number,
  column: number
): TypeParameterInfo[] {
  if (!typeParameters || typeof typeParameters !== 'object') return [];

  const tpDecl = typeParameters as { type?: string; params?: unknown[] };
  if (tpDecl.type !== 'TSTypeParameterDeclaration' || !Array.isArray(tpDecl.params)) return [];

  const result: TypeParameterInfo[] = [];

  for (const param of tpDecl.params) {
    const tsParam = param as {
      type?: string;
      name?: string;
      constraint?: unknown;
      default?: unknown;
      in?: boolean;
      out?: boolean;
      loc?: { start?: { line?: number; column?: number } };
    };

    if (tsParam.type !== 'TSTypeParameter') continue;

    const paramName = tsParam.name;
    if (!paramName) continue;

    // Extract constraint via typeNodeToString
    const constraintType = tsParam.constraint ? typeNodeToString(tsParam.constraint) : undefined;

    // Extract default via typeNodeToString
    const defaultType = tsParam.default ? typeNodeToString(tsParam.default) : undefined;

    // Extract variance
    let variance: 'in' | 'out' | 'in out' | undefined;
    if (tsParam.in && tsParam.out) {
      variance = 'in out';
    } else if (tsParam.in) {
      variance = 'in';
    } else if (tsParam.out) {
      variance = 'out';
    }

    // Use param's own location if available, otherwise fall back to declaration location
    const paramLine = tsParam.loc?.start?.line ?? line;
    const paramColumn = tsParam.loc?.start?.column ?? column;

    result.push({
      name: paramName,
      constraintType: constraintType !== 'unknown' ? constraintType : undefined,
      defaultType: defaultType !== 'unknown' ? defaultType : undefined,
      variance,
      parentId,
      parentType,
      file,
      line: paramLine,
      column: paramColumn,
    });
  }

  return result;
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
      enums,
      typeParameters
    } = this.collections;
    const scopeTracker = this.scopeTracker;

    return {
      TSInterfaceDeclaration: (path: NodePath) => {
        const node = path.node as TSInterfaceDeclaration;
        if (!node.id) return;

        const interfaceName = node.id.name;

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

        // Extract type parameters (REG-303)
        if (typeParameters && node.typeParameters) {
          const interfaceId = `${module.file}:INTERFACE:${interfaceName}:${getLine(node)}`;
          const typeParamInfos = extractTypeParameters(
            node.typeParameters,
            interfaceId,
            'INTERFACE',
            module.file,
            getLine(node),
            getColumn(node)
          );
          for (const tp of typeParamInfos) {
            (typeParameters as TypeParameterInfo[]).push(tp);
          }
        }

        (interfaces as InterfaceDeclarationInfo[]).push({
          semanticId: interfaceSemanticId,
          type: 'INTERFACE',
          name: interfaceName,
          file: module.file,
          line: getLine(node),
          column: getColumn(node),
          extends: extendsNames.length > 0 ? extendsNames : undefined,
          properties
        });
      },

      TSTypeAliasDeclaration: (path: NodePath) => {
        const node = path.node as TSTypeAliasDeclaration;
        if (!node.id) return;

        const typeName = node.id.name;

        // Generate semantic ID if scopeTracker available
        let typeSemanticId: string | undefined;
        if (scopeTracker) {
          typeSemanticId = computeSemanticId('TYPE', typeName, scopeTracker.getContext());
        }

        // Extract the type being aliased
        const aliasOf = typeNodeToString(node.typeAnnotation);

        // Extract type parameters (REG-303)
        if (typeParameters && node.typeParameters) {
          const typeId = `${module.file}:TYPE:${typeName}:${getLine(node)}`;
          const typeParamInfos = extractTypeParameters(
            node.typeParameters,
            typeId,
            'TYPE',
            module.file,
            getLine(node),
            getColumn(node)
          );
          for (const tp of typeParamInfos) {
            (typeParameters as TypeParameterInfo[]).push(tp);
          }
        }

        (typeAliases as TypeAliasInfo[]).push({
          semanticId: typeSemanticId,
          type: 'TYPE',
          name: typeName,
          file: module.file,
          line: getLine(node),
          column: getColumn(node),
          aliasOf
        });
      },

      TSEnumDeclaration: (path: NodePath) => {
        const node = path.node as TSEnumDeclaration;
        if (!node.id) return;

        const enumName = node.id.name;

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
          semanticId: enumSemanticId,
          type: 'ENUM',
          name: enumName,
          file: module.file,
          line: getLine(node),
          column: getColumn(node),
          isConst: node.const || false,
          members
        });
      }
    };
  }
}

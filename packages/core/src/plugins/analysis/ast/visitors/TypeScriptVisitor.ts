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
  EnumMemberInfo
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
    case 'TSTypeReference': {
      const typeName = typeNode.typeName as { type: string; name?: string };
      const baseName = typeName?.type === 'Identifier' ? (typeName.name || 'unknown') : 'unknown';
      const typeParams = typeNode.typeParameters as { params?: unknown[] } | undefined;
      if (typeParams?.params?.length) {
        const paramStrs = typeParams.params.map(p => typeNodeToString(p));
        return `${baseName}<${paramStrs.join(', ')}>`;
      }
      return baseName;
    }
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
    case 'TSTypeOperator': {
      const operator = typeNode.operator as string;
      const operand = typeNodeToString(typeNode.typeAnnotation);
      return `${operator} ${operand}`;
    }
    case 'TSIndexedAccessType': {
      const object = typeNodeToString(typeNode.objectType);
      const index = typeNodeToString(typeNode.indexType);
      return `${object}[${index}]`;
    }
    case 'TSMappedType': {
      const tp = typeNode.typeParameter as { name?: string; constraint?: unknown };
      const keyName = tp?.name || 'K';
      const constraint = tp?.constraint ? typeNodeToString(tp.constraint) : '';
      const valType = typeNode.typeAnnotation ? typeNodeToString(typeNode.typeAnnotation) : 'unknown';
      const readonlyMod = typeNode.readonly === '-' ? '-readonly ' : typeNode.readonly ? 'readonly ' : '';
      const optionalMod = typeNode.optional === '-' ? '-?' : typeNode.optional ? '?' : '';
      const asClause = typeNode.nameType ? ` as ${typeNodeToString(typeNode.nameType)}` : '';
      return `{ ${readonlyMod}[${keyName} in ${constraint}${asClause}]${optionalMod}: ${valType} }`;
    }
    case 'TSConditionalType': {
      const check = typeNodeToString(typeNode.checkType);
      const ext = typeNodeToString(typeNode.extendsType);
      const trueType = typeNodeToString(typeNode.trueType);
      const falseType = typeNodeToString(typeNode.falseType);
      return `${check} extends ${ext} ? ${trueType} : ${falseType}`;
    }
    case 'TSTypeQuery': {
      const exprName = typeNode.exprName as { type: string; name?: string };
      return exprName?.type === 'Identifier' ? `typeof ${exprName.name}` : 'typeof unknown';
    }
    case 'TSParenthesizedType':
      return `(${typeNodeToString(typeNode.typeAnnotation)})`;
    case 'TSInferType': {
      const param = typeNode.typeParameter as { name?: string };
      return `infer ${param?.name || 'U'}`;
    }
    case 'TSTemplateLiteralType': {
      const quasis = typeNode.quasis as Array<{ value?: { raw?: string } }>;
      const typeTypes = typeNode.types as unknown[];
      let result = '`';
      for (let i = 0; i < quasis.length; i++) {
        result += quasis[i]?.value?.raw || '';
        if (i < (typeTypes?.length || 0)) {
          result += `\${${typeNodeToString(typeTypes[i])}}`;
        }
      }
      result += '`';
      return result;
    }
    case 'TSRestType':
      return `...${typeNodeToString(typeNode.typeAnnotation)}`;
    case 'TSOptionalType':
      return `${typeNodeToString(typeNode.typeAnnotation)}?`;
    case 'TSNamedTupleMember': {
      const label = (typeNode.label as { name?: string })?.name || '';
      const elemType = typeNodeToString(typeNode.elementType);
      return typeNode.optional ? `${label}?: ${elemType}` : `${label}: ${elemType}`;
    }
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

        // REG-304: Detect conditional type and extract branch metadata
        const typeAnnotation = node.typeAnnotation as { type: string; [key: string]: unknown };
        const isConditional = typeAnnotation?.type === 'TSConditionalType';

        const typeInfo: TypeAliasInfo = {
          semanticId: typeSemanticId,
          type: 'TYPE',
          name: typeName,
          file: module.file,
          line: getLine(node),
          column: getColumn(node),
          aliasOf,
          ...(isConditional && {
            conditionalType: true,
            checkType: typeNodeToString(typeAnnotation.checkType),
            extendsType: typeNodeToString(typeAnnotation.extendsType),
            trueType: typeNodeToString(typeAnnotation.trueType),
            falseType: typeNodeToString(typeAnnotation.falseType),
          }),
        };

        // Detect mapped types: { [K in keyof T]: T[K] }
        const annotation = node.typeAnnotation as { type: string; [key: string]: unknown };
        if (annotation?.type === 'TSMappedType') {
          typeInfo.mappedType = true;

          const tp = annotation.typeParameter as { name?: string; constraint?: unknown };
          if (tp?.name) typeInfo.keyName = tp.name;
          if (tp?.constraint) typeInfo.keyConstraint = typeNodeToString(tp.constraint);

          if (annotation.typeAnnotation) {
            typeInfo.valueType = typeNodeToString(annotation.typeAnnotation);
          }

          if (annotation.readonly !== undefined && annotation.readonly !== null) {
            typeInfo.mappedReadonly = annotation.readonly as boolean | '+' | '-';
          }
          if (annotation.optional !== undefined && annotation.optional !== null) {
            typeInfo.mappedOptional = annotation.optional as boolean | '+' | '-';
          }
          if (annotation.nameType) {
            typeInfo.nameType = typeNodeToString(annotation.nameType);
          }
        }

        (typeAliases as TypeAliasInfo[]).push(typeInfo);
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

/**
 * TypeSystemBuilder - buffers class declarations, interfaces, type aliases,
 * enums, decorators, type parameters, and promise resolution edges.
 *
 * Extracted from GraphBuilder: bufferClassDeclarationNodes, bufferClassNodes,
 * bufferImplementsEdges, bufferInterfaceNodes, bufferTypeParameterNodes,
 * bufferTypeAliasNodes, bufferEnumNodes, bufferDecoratorNodes,
 * bufferPromiseResolutionEdges.
 */

import { InterfaceNode } from '../../../../core/nodes/InterfaceNode.js';
import { EnumNode } from '../../../../core/nodes/EnumNode.js';
import { DecoratorNode } from '../../../../core/nodes/DecoratorNode.js';
import { TypeParameterNode } from '../../../../core/nodes/TypeParameterNode.js';
import { NodeFactory } from '../../../../core/NodeFactory.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import type { InterfaceNodeRecord } from '../../../../core/nodes/InterfaceNode.js';
import type {
  ModuleNode,
  ClassDeclarationInfo,
  ClassInstantiationInfo,
  InterfaceDeclarationInfo,
  TypeAliasInfo,
  EnumDeclarationInfo,
  DecoratorInfo,
  TypeParameterInfo,
  PromiseResolutionInfo,
  ASTCollections,
  GraphNode,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

/**
 * Check if a type string represents a TypeScript primitive (no EXTENDS edge needed)
 */
function isPrimitiveType(typeName: string): boolean {
  const PRIMITIVES = new Set([
    'string', 'number', 'boolean', 'void', 'null', 'undefined',
    'never', 'any', 'unknown', 'object', 'symbol', 'bigint', 'function'
  ]);
  return PRIMITIVES.has(typeName);
}

export class TypeSystemBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      classDeclarations = [],
      classInstantiations = [],
      interfaces = [],
      typeAliases = [],
      enums = [],
      decorators = [],
      typeParameters = [],
      promiseResolutions = [],
    } = data;

    this.bufferClassDeclarationNodes(classDeclarations);
    this.bufferClassNodes(module, classInstantiations, classDeclarations);
    this.bufferInterfaceNodes(module, interfaces);
    this.bufferTypeParameterNodes(typeParameters, interfaces);
    this.bufferTypeAliasNodes(module, typeAliases);
    this.bufferEnumNodes(module, enums);
    this.bufferDecoratorNodes(decorators);
    this.bufferImplementsEdges(classDeclarations, interfaces);
    this.bufferPromiseResolutionEdges(promiseResolutions);
  }

  private bufferClassDeclarationNodes(classDeclarations: ClassDeclarationInfo[]): void {
    for (const classDecl of classDeclarations) {
      const { id, type, name, file, line, column, superClass, methods, properties, staticBlocks } = classDecl;

      // Buffer CLASS node
      this.ctx.bufferNode({
        id,
        type,
        name,
        file,
        line,
        column,
        superClass
      });

      // Buffer CONTAINS edges: CLASS -> METHOD
      for (const methodId of methods) {
        this.ctx.bufferEdge({
          type: 'CONTAINS',
          src: id,
          dst: methodId
        });
      }

      // REG-271: Buffer HAS_PROPERTY edges: CLASS -> VARIABLE (private fields)
      if (properties) {
        for (const propertyId of properties) {
          this.ctx.bufferEdge({
            type: 'HAS_PROPERTY',
            src: id,
            dst: propertyId
          });
        }
      }

      // REG-271: Buffer CONTAINS edges: CLASS -> SCOPE (static blocks)
      if (staticBlocks) {
        for (const staticBlockId of staticBlocks) {
          this.ctx.bufferEdge({
            type: 'CONTAINS',
            src: id,
            dst: staticBlockId
          });
        }
      }

      // If superClass, buffer DERIVES_FROM edge with computed ID
      if (superClass) {
        // Compute superclass ID using semantic ID format
        // Assume superclass is in same file at global scope (most common case)
        // When superclass is in different file, edge will be dangling until that file analyzed
        const globalContext = { file, scopePath: [] as string[] };
        const superClassId = computeSemanticId('CLASS', superClass, globalContext);

        this.ctx.bufferEdge({
          type: 'DERIVES_FROM',
          src: id,
          dst: superClassId
        });
      }
    }
  }

  private bufferClassNodes(module: ModuleNode, classInstantiations: ClassInstantiationInfo[], classDeclarations: ClassDeclarationInfo[]): void {
    // Create lookup map: className -> declaration ID
    const declarationMap = new Map<string, string>();
    for (const decl of classDeclarations) {
      if (decl.file === module.file) {
        declarationMap.set(decl.name, decl.id);
      }
    }

    for (const instantiation of classInstantiations) {
      const { variableId, className, line: _line } = instantiation;

      let classId = declarationMap.get(className);

      if (!classId) {
        // External class - compute semantic ID
        // When class is in different file, edge will be dangling until that file analyzed
        const globalContext = { file: module.file, scopePath: [] as string[] };
        classId = computeSemanticId('CLASS', className, globalContext);

        // NO node creation - node will exist when class file analyzed
      }

      // Buffer INSTANCE_OF edge
      this.ctx.bufferEdge({
        type: 'INSTANCE_OF',
        src: variableId,
        dst: classId
      });
    }
  }

  private bufferInterfaceNodes(module: ModuleNode, interfaces: InterfaceDeclarationInfo[]): void {
    // First pass: create all interface nodes and store them
    const interfaceNodes = new Map<string, InterfaceNodeRecord>();

    for (const iface of interfaces) {
      const interfaceNode = InterfaceNode.create(
        iface.name,
        iface.file,
        iface.line,
        iface.column || 0,
        {
          extends: iface.extends,
          properties: iface.properties
        }
      );
      interfaceNodes.set(iface.name, interfaceNode);
      this.ctx.bufferNode(interfaceNode as unknown as GraphNode);

      // MODULE -> CONTAINS -> INTERFACE
      this.ctx.bufferEdge({
        type: 'CONTAINS',
        src: module.id,
        dst: interfaceNode.id
      });
    }

    // Second pass: create EXTENDS edges
    for (const iface of interfaces) {
      if (iface.extends && iface.extends.length > 0) {
        const srcNode = interfaceNodes.get(iface.name)!;

        for (const parentName of iface.extends) {
          const parentNode = interfaceNodes.get(parentName);

          if (parentNode) {
            // Same-file interface
            this.ctx.bufferEdge({
              type: 'EXTENDS',
              src: srcNode.id,
              dst: parentNode.id
            });
          } else {
            // External interface - create a reference node
            const externalInterface = NodeFactory.createInterface(
              parentName,
              iface.file,
              iface.line,
              0,
              { isExternal: true }
            );
            this.ctx.bufferNode(externalInterface as unknown as GraphNode);
            this.ctx.bufferEdge({
              type: 'EXTENDS',
              src: srcNode.id,
              dst: externalInterface.id
            });
          }
        }
      }
    }
  }

  /**
   * Buffer TYPE_PARAMETER nodes, HAS_TYPE_PARAMETER edges, and EXTENDS edges for constraints.
   *
   * For each type parameter:
   * 1. Creates TYPE_PARAMETER node with constraint/default/variance metadata
   * 2. Creates HAS_TYPE_PARAMETER edge: parent -> TYPE_PARAMETER
   * 3. If constraint is a non-primitive type reference, creates EXTENDS edge
   *    using external reference nodes (same pattern as bufferInterfaceNodes)
   */
  private bufferTypeParameterNodes(typeParameters: TypeParameterInfo[], interfaces: InterfaceDeclarationInfo[]): void {
    // Build a lookup of interface names to their IDs for same-file resolution
    const interfaceIdsByName = new Map<string, string>();
    for (const iface of interfaces) {
      const ifaceId = `${iface.file}:INTERFACE:${iface.name}:${iface.line}`;
      interfaceIdsByName.set(iface.name, ifaceId);
    }

    for (const tp of typeParameters) {
      // Create TYPE_PARAMETER node
      const tpNode = TypeParameterNode.create(
        tp.name,
        tp.parentId,
        tp.file,
        tp.line,
        tp.column,
        {
          constraint: tp.constraintType,
          defaultType: tp.defaultType,
          variance: tp.variance,
        }
      );
      this.ctx.bufferNode(tpNode as unknown as GraphNode);

      // HAS_TYPE_PARAMETER edge: parent -> TYPE_PARAMETER
      this.ctx.bufferEdge({
        type: 'HAS_TYPE_PARAMETER',
        src: tp.parentId,
        dst: tpNode.id
      });

      // EXTENDS edge for constraint (if constraint looks like a type reference, not a primitive)
      if (tp.constraintType && !isPrimitiveType(tp.constraintType)) {
        // For intersection types ("A & B"), create EXTENDS edge for each part
        const constraintParts = tp.constraintType.includes(' & ')
          ? tp.constraintType.split(' & ').map(s => s.trim())
          : [tp.constraintType];

        for (const part of constraintParts) {
          // Skip primitives, unknown, union types, array types, complex types
          if (isPrimitiveType(part) || part === 'unknown') continue;
          if (part.includes(' | ') || part.includes('[]') || part.includes('[')) continue;

          // Check if constraint type is a same-file interface
          const sameFileId = interfaceIdsByName.get(part);
          if (sameFileId) {
            // Same-file interface -- use its real ID
            this.ctx.bufferEdge({
              type: 'EXTENDS',
              src: tpNode.id,
              dst: sameFileId
            });
          } else {
            // External type -- create an external reference node (same pattern as bufferInterfaceNodes)
            const externalInterface = NodeFactory.createInterface(
              part,
              tp.file,
              tp.line,
              0,
              { isExternal: true }
            );
            this.ctx.bufferNode(externalInterface as unknown as GraphNode);
            this.ctx.bufferEdge({
              type: 'EXTENDS',
              src: tpNode.id,
              dst: externalInterface.id
            });
          }
        }
      }
    }
  }

  /**
   * Buffer TYPE alias nodes
   */
  private bufferTypeAliasNodes(module: ModuleNode, typeAliases: TypeAliasInfo[]): void {
    for (const typeAlias of typeAliases) {
      // Create TYPE node using factory (pass mapped type metadata if present)
      const typeNode = NodeFactory.createType(
        typeAlias.name,
        typeAlias.file,
        typeAlias.line,
        typeAlias.column || 0,
        {
          aliasOf: typeAlias.aliasOf,
          mappedType: typeAlias.mappedType,
          keyName: typeAlias.keyName,
          keyConstraint: typeAlias.keyConstraint,
          valueType: typeAlias.valueType,
          mappedReadonly: typeAlias.mappedReadonly,
          mappedOptional: typeAlias.mappedOptional,
          nameType: typeAlias.nameType,
          conditionalType: typeAlias.conditionalType,
          checkType: typeAlias.checkType,
          extendsType: typeAlias.extendsType,
          trueType: typeAlias.trueType,
          falseType: typeAlias.falseType,
        }
      );
      this.ctx.bufferNode(typeNode as unknown as GraphNode);

      // MODULE -> CONTAINS -> TYPE
      this.ctx.bufferEdge({
        type: 'CONTAINS',
        src: module.id,
        dst: typeNode.id
      });
    }
  }

  /**
   * Buffer ENUM nodes
   * Uses EnumNode.create() to ensure consistent ID format (colon separator)
   */
  private bufferEnumNodes(module: ModuleNode, enums: EnumDeclarationInfo[]): void {
    for (const enumDecl of enums) {
      // Use EnumNode.create() to generate proper ID (colon format)
      // Do NOT use enumDecl.id which has legacy # format from TypeScriptVisitor
      const enumNode = EnumNode.create(
        enumDecl.name,
        enumDecl.file,
        enumDecl.line,
        enumDecl.column || 0,
        {
          isConst: enumDecl.isConst || false,
          members: enumDecl.members || []
        }
      );

      this.ctx.bufferNode(enumNode as unknown as GraphNode);

      // MODULE -> CONTAINS -> ENUM
      this.ctx.bufferEdge({
        type: 'CONTAINS',
        src: module.id,
        dst: enumNode.id  // Use factory-generated ID (colon format)
      });
    }
  }

  /**
   * Buffer DECORATOR nodes and DECORATED_BY edges
   */
  private bufferDecoratorNodes(decorators: DecoratorInfo[]): void {
    for (const decorator of decorators) {
      // Create DECORATOR node using factory (generates colon-format ID)
      const decoratorNode = DecoratorNode.create(
        decorator.name,
        decorator.file,
        decorator.line,
        decorator.column || 0,
        decorator.targetId,  // Now included in the node!
        decorator.targetType,
        { arguments: decorator.arguments }
      );

      this.ctx.bufferNode(decoratorNode as unknown as GraphNode);

      // TARGET -> DECORATED_BY -> DECORATOR
      this.ctx.bufferEdge({
        type: 'DECORATED_BY',
        src: decorator.targetId,
        dst: decoratorNode.id  // Use factory-generated ID (colon format)
      });
    }
  }

  /**
   * Buffer IMPLEMENTS edges (CLASS -> INTERFACE)
   */
  private bufferImplementsEdges(classDeclarations: ClassDeclarationInfo[], interfaces: InterfaceDeclarationInfo[]): void {
    for (const classDecl of classDeclarations) {
      if (classDecl.implements && classDecl.implements.length > 0) {
        for (const ifaceName of classDecl.implements) {
          // Try to find the interface in the same file
          const iface = interfaces.find(i => i.name === ifaceName);
          if (iface) {
            // Compute interface ID using same formula as InterfaceNode.create()
            // Format: {file}:INTERFACE:{name}:{line}
            const interfaceId = `${iface.file}:INTERFACE:${iface.name}:${iface.line}`;
            this.ctx.bufferEdge({
              type: 'IMPLEMENTS',
              src: classDecl.id,
              dst: interfaceId
            });
          } else {
            // External interface - create a reference node
            const externalInterface = NodeFactory.createInterface(
              ifaceName,
              classDecl.file,
              classDecl.line,
              0,
              { isExternal: true }
            );
            this.ctx.bufferNode(externalInterface as unknown as GraphNode);
            this.ctx.bufferEdge({
              type: 'IMPLEMENTS',
              src: classDecl.id,
              dst: externalInterface.id
            });
          }
        }
      }
    }
  }

  /**
   * Buffer RESOLVES_TO edges for Promise resolution data flow (REG-334).
   *
   * Links resolve/reject CALL nodes to their parent Promise CONSTRUCTOR_CALL.
   * This enables traceValues to follow Promise data flow:
   *
   * Example:
   * ```
   * const result = new Promise((resolve) => {
   *   resolve(42);  // CALL[resolve] --RESOLVES_TO--> CONSTRUCTOR_CALL[Promise]
   * });
   * ```
   *
   * The edge direction (CALL -> CONSTRUCTOR_CALL) matches data flow semantics:
   * data flows FROM resolve(value) TO the Promise result.
   */
  private bufferPromiseResolutionEdges(promiseResolutions: PromiseResolutionInfo[]): void {
    for (const resolution of promiseResolutions) {
      this.ctx.bufferEdge({
        type: 'RESOLVES_TO',
        src: resolution.callId,
        dst: resolution.constructorCallId,
        metadata: {
          isReject: resolution.isReject
        }
      });
    }
  }
}

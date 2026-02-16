/**
 * ClassVisitor - handles class declarations and their methods
 *
 * Handles:
 * - ClassDeclaration
 * - ClassMethod (nested)
 * - ClassProperty with function values (nested)
 * - Implements (TypeScript)
 * - Decorators
 */

import type {
  ClassDeclaration,
  ClassMethod,
  ClassProperty,
  ClassPrivateProperty,
  ClassPrivateMethod,
  StaticBlock,
  PrivateName,
  Identifier,
  ArrowFunctionExpression,
  FunctionExpression,
  Decorator,
  Node
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers } from './ASTVisitor.js';
import type { AnalyzeFunctionBodyCallback } from './FunctionVisitor.js';
import type { DecoratorInfo, ParameterInfo, VariableDeclarationInfo, TypeParameterInfo } from '../types.js';
import { extractTypeParameters } from './TypeScriptVisitor.js';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { createParameterNodes } from '../utils/createParameterNodes.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { ClassNode, type ClassNodeRecord } from '../../../../core/nodes/ClassNode.js';
import { computeSemanticIdV2 } from '../../../../core/SemanticId.js';
import { getLine, getColumn } from '../utils/location.js';

/**
 * Class declaration info
 * Extends ClassNodeRecord with TypeScript-specific metadata
 */
interface ClassInfo extends ClassNodeRecord {
  implements?: string[];  // TypeScript implements (visitor extension)
  // REG-271: Additional class members
  properties?: string[];     // IDs of class properties (including private)
  staticBlocks?: string[];   // IDs of static block scopes
}

/**
 * Function node info for class methods
 */
interface ClassFunctionInfo {
  id: string;
  type: 'FUNCTION';
  name: string;
  file: string;
  line: number;
  column: number;
  async: boolean;
  generator?: boolean;
  arrowFunction?: boolean;
  isClassProperty?: boolean;
  isClassMethod?: boolean;
  className: string;
  methodKind?: 'constructor' | 'method' | 'get' | 'set';
  legacyId?: string;  // Kept for debugging/migration purposes
  // REG-271: Private methods support
  isPrivate?: boolean;
  isStatic?: boolean;
}

/**
 * Scope node info
 */
interface ScopeInfo {
  id: string;
  semanticId?: string;
  type: 'SCOPE';
  scopeType: string;
  name: string;
  conditional?: boolean;
  file: string;
  line: number;
  parentFunctionId?: string;
  // REG-271: For static blocks, the containing class ID
  parentClassId?: string;
}

export class ClassVisitor extends ASTVisitor {
  private analyzeFunctionBody: AnalyzeFunctionBodyCallback;
  private scopeTracker: ScopeTracker;

  /**
   * @param module - Current module being analyzed
   * @param collections - Must contain arrays and counter refs
   * @param analyzeFunctionBody - Callback to analyze method internals
   * @param scopeTracker - REQUIRED for semantic ID generation
   */
  constructor(
    module: VisitorModule,
    collections: VisitorCollections,
    analyzeFunctionBody: AnalyzeFunctionBodyCallback,
    scopeTracker: ScopeTracker  // REQUIRED, not optional
  ) {
    super(module, collections);
    this.analyzeFunctionBody = analyzeFunctionBody;
    this.scopeTracker = scopeTracker;
  }

  /**
   * Extract decorator information from a Decorator node
   */
  private extractDecoratorInfo(
    decorator: Decorator,
    targetId: string,
    targetType: 'CLASS' | 'METHOD' | 'PROPERTY' | 'PARAMETER',
    module: VisitorModule
  ): DecoratorInfo | null {
    let decoratorName: string;
    let decoratorArgs: unknown[] | undefined;

    // @Decorator or @Decorator()
    if (decorator.expression.type === 'Identifier') {
      decoratorName = (decorator.expression as Identifier).name;
    } else if (decorator.expression.type === 'CallExpression') {
      const callExpr = decorator.expression as { callee: { type: string; name?: string }; arguments: unknown[] };
      if (callExpr.callee.type === 'Identifier') {
        decoratorName = callExpr.callee.name!;
        // Extract arguments (cast to Node since Babel types guarantee these are AST nodes)
        decoratorArgs = callExpr.arguments.map(arg => {
          return ExpressionEvaluator.extractLiteralValue(arg as Node);
        }).filter(v => v !== null);
        if (decoratorArgs.length === 0) {
          decoratorArgs = undefined;
        }
      } else {
        return null;  // Complex decorator expression
      }
    } else {
      return null;  // Unsupported decorator type
    }

    const decoratorLine = getLine(decorator);
    const decoratorColumn = getColumn(decorator);
    const decoratorId = `DECORATOR#${decoratorName}#${module.file}#${decoratorLine}:${decoratorColumn}`;

    return {
      id: decoratorId,
      type: 'DECORATOR',
      name: decoratorName,
      file: module.file,
      line: decoratorLine,
      column: decoratorColumn,
      arguments: decoratorArgs,
      targetId,
      targetType
    };
  }

  getHandlers(): VisitorHandlers {
    const { module } = this;
    const {
      functions,
      scopes,
      classDeclarations,
      decorators,
      parameters
    } = this.collections;

    const analyzeFunctionBody = this.analyzeFunctionBody;
    const collections = this.collections;
    const scopeTracker = this.scopeTracker;

    return {
      ClassDeclaration: (classPath: NodePath) => {
        const classNode = classPath.node as ClassDeclaration;
        if (!classNode.id) return; // Skip anonymous classes

        const className = classNode.id.name;

        // Extract superClass name
        const superClassName = classNode.superClass?.type === 'Identifier'
          ? (classNode.superClass as Identifier).name
          : null;

        const classLine = getLine(classNode);
        const classColumn = getColumn(classNode);

        // Create CLASS node using NodeFactory with semantic ID
        const classRecord = ClassNode.createWithContext(
          className,
          scopeTracker.getContext(),
          { line: classLine, column: classColumn },
          { superClass: superClassName || undefined }
        );

        // Extract implements (TypeScript)
        const implementsNames: string[] = [];
        const classNodeWithImplements = classNode as ClassDeclaration & { implements?: Array<{ expression: { type: string; name?: string } }> };
        if (classNodeWithImplements.implements && classNodeWithImplements.implements.length > 0) {
          for (const impl of classNodeWithImplements.implements) {
            if (impl.expression.type === 'Identifier') {
              implementsNames.push(impl.expression.name!);
            }
          }
        }

        // Extract type parameters (REG-303)
        if (collections.typeParameters && (classNode as any).typeParameters) {
          const typeParamInfos = extractTypeParameters(
            (classNode as any).typeParameters,
            classRecord.id,
            'CLASS',
            module.file,
            classLine,
            classColumn
          );
          for (const tp of typeParamInfos) {
            (collections.typeParameters as TypeParameterInfo[]).push(tp);
          }
        }

        // Store ClassNodeRecord + TypeScript metadata
        (classDeclarations as ClassInfo[]).push({
          ...classRecord,
          implements: implementsNames.length > 0 ? implementsNames : undefined
        });

        // Enter class scope for tracking methods
        scopeTracker.enterScope(className, 'CLASS');

        // Extract class decorators
        const classNodeWithDecorators = classNode as ClassDeclaration & { decorators?: Decorator[] };
        if (classNodeWithDecorators.decorators && classNodeWithDecorators.decorators.length > 0 && decorators) {
          for (const decorator of classNodeWithDecorators.decorators) {
            const decoratorInfo = this.extractDecoratorInfo(decorator, classRecord.id, 'CLASS', module);
            if (decoratorInfo) {
              (decorators as DecoratorInfo[]).push(decoratorInfo);
            }
          }
        }

        // Get reference to current class for adding methods
        const classDeclarationsTyped = classDeclarations as ClassInfo[];
        const currentClass = classDeclarationsTyped[classDeclarationsTyped.length - 1];

        // Process class methods and properties
        classPath.traverse({
          ClassProperty: (propPath: NodePath) => {
            const propNode = propPath.node as ClassProperty;

            // Skip if not property of current class
            if (propPath.parent !== classNode.body) {
              return;
            }

            const propName = propNode.key.type === 'Identifier'
              ? propNode.key.name
              : (propNode.key as { value?: string }).value || 'anonymous';

            const propLine = getLine(propNode);
            const propColumn = getColumn(propNode);

            // Extract property decorators (even for non-function properties)
            const propNodeWithDecorators = propNode as ClassProperty & { decorators?: Decorator[] };
            if (propNodeWithDecorators.decorators && propNodeWithDecorators.decorators.length > 0 && decorators) {
              // For function properties, target will be set later; for regular properties, create a target ID
              const propertyTargetId = `PROPERTY#${className}.${propName}#${module.file}#${propLine}`;
              for (const decorator of propNodeWithDecorators.decorators) {
                const decoratorInfo = this.extractDecoratorInfo(decorator, propertyTargetId, 'PROPERTY', module);
                if (decoratorInfo) {
                  (decorators as DecoratorInfo[]).push(decoratorInfo);
                }
              }
            }

            // Only process if value is a function
            if (propNode.value &&
                (propNode.value.type === 'ArrowFunctionExpression' ||
                 propNode.value.type === 'FunctionExpression')) {

              const funcNode = propNode.value as ArrowFunctionExpression | FunctionExpression;

              // Use semantic ID as primary ID (matching FunctionVisitor pattern)
              const legacyId = `FUNCTION#${className}.${propName}#${module.file}#${propLine}:${propColumn}`;
              const functionId = computeSemanticIdV2('FUNCTION', propName, module.file, scopeTracker.getNamedParent());

              // Add method to class methods list for CONTAINS edges
              currentClass.methods.push(functionId);

              (functions as ClassFunctionInfo[]).push({
                id: functionId,
                type: 'FUNCTION',
                name: propName,
                file: module.file,
                line: propLine,
                column: propColumn,
                async: funcNode.async || false,
                generator: funcNode.type === 'FunctionExpression' ? funcNode.generator || false : false,
                arrowFunction: funcNode.type === 'ArrowFunctionExpression',
                isClassProperty: true,
                className: className,
                legacyId  // Keep for debugging/migration purposes
              });

              // Enter method scope for tracking
              scopeTracker.enterScope(propName, 'FUNCTION');

              // Create PARAMETER nodes for class property function parameters (REG-134)
              if (parameters) {
                createParameterNodes(funcNode.params, functionId, module.file, propLine, parameters as ParameterInfo[], scopeTracker);
              }

              // Create SCOPE for property function body
              const propBodyScopeId = `SCOPE#${className}.${propName}:body#${module.file}#${propLine}`;
              const propBodySemanticId = computeSemanticIdV2('SCOPE', 'body', module.file, scopeTracker.getNamedParent());
              (scopes as ScopeInfo[]).push({
                id: propBodyScopeId,
                semanticId: propBodySemanticId,
                type: 'SCOPE',
                scopeType: 'property_body',
                name: `${className}.${propName}:body`,
                conditional: false,
                file: module.file,
                line: propLine,
                parentFunctionId: functionId
              });

              const funcPath = propPath.get('value') as NodePath<ArrowFunctionExpression | FunctionExpression>;
              analyzeFunctionBody(funcPath, propBodyScopeId, module, collections);

              // Exit method scope
              scopeTracker.exitScope();
            }
          },

          ClassMethod: (methodPath: NodePath<ClassMethod>) => {
            const methodNode = methodPath.node;
            const methodName = methodNode.key.type === 'Identifier'
              ? methodNode.key.name
              : (methodNode.key as { value?: string }).value || 'anonymous';

            // Skip if not method of current class (nested classes)
            if (methodPath.parent !== classNode.body) {
              return;
            }

            const methodLine = getLine(methodNode);
            const methodColumn = getColumn(methodNode);

            // Use semantic ID as primary ID (matching FunctionVisitor pattern)
            const legacyId = `FUNCTION#${className}.${methodName}#${module.file}#${methodLine}:${methodColumn}`;
            const functionId = computeSemanticIdV2('FUNCTION', methodName, module.file, scopeTracker.getNamedParent());

            // Add method to class methods list for CONTAINS edges
            currentClass.methods.push(functionId);

            const funcData: ClassFunctionInfo = {
              id: functionId,
              type: 'FUNCTION',
              name: methodName,
              file: module.file,
              line: methodLine,
              column: methodColumn,
              async: methodNode.async || false,
              generator: methodNode.generator || false,
              isClassMethod: true,
              className: className,
              methodKind: methodNode.kind as 'constructor' | 'method' | 'get' | 'set',
              legacyId  // Keep for debugging/migration purposes
            };
            (functions as ClassFunctionInfo[]).push(funcData);

            // Extract type parameters for methods (REG-303)
            if (collections.typeParameters && (methodNode as any).typeParameters) {
              const typeParamInfos = extractTypeParameters(
                (methodNode as any).typeParameters,
                functionId,
                'FUNCTION',
                module.file,
                methodLine,
                methodColumn
              );
              for (const tp of typeParamInfos) {
                (collections.typeParameters as TypeParameterInfo[]).push(tp);
              }
            }

            // Extract method decorators
            const methodNodeWithDecorators = methodNode as ClassMethod & { decorators?: Decorator[] };
            if (methodNodeWithDecorators.decorators && methodNodeWithDecorators.decorators.length > 0 && decorators) {
              for (const decorator of methodNodeWithDecorators.decorators) {
                const decoratorInfo = this.extractDecoratorInfo(decorator, functionId, 'METHOD', module);
                if (decoratorInfo) {
                  (decorators as DecoratorInfo[]).push(decoratorInfo);
                }
              }
            }

            // Enter method scope for tracking
            scopeTracker.enterScope(methodName, 'FUNCTION');

            // Create PARAMETER nodes for class method parameters (REG-134)
            if (parameters) {
              createParameterNodes(methodNode.params, functionId, module.file, methodLine, parameters as ParameterInfo[], scopeTracker);
            }

            // Create SCOPE for method body
            const methodBodyScopeId = `SCOPE#${className}.${methodName}:body#${module.file}#${methodLine}`;
            const methodBodySemanticId = computeSemanticIdV2('SCOPE', 'body', module.file, scopeTracker.getNamedParent());
            (scopes as ScopeInfo[]).push({
              id: methodBodyScopeId,
              semanticId: methodBodySemanticId,
              type: 'SCOPE',
              scopeType: 'method_body',
              name: `${className}.${methodName}:body`,
              conditional: false,
              file: module.file,
              line: methodLine,
              parentFunctionId: functionId
            });

            analyzeFunctionBody(methodPath, methodBodyScopeId, module, collections);

            // Exit method scope
            scopeTracker.exitScope();
          },

          // REG-271: Static block handler
          StaticBlock: (staticBlockPath: NodePath) => {
            const staticBlockNode = staticBlockPath.node as StaticBlock;

            // Skip if not direct child of current class
            if (staticBlockPath.parent !== classNode.body) {
              return;
            }

            const blockLine = getLine(staticBlockNode);

            // Enter static block scope for tracking
            const { discriminator } = scopeTracker.enterCountedScope('static_block');

            // Generate semantic ID for static block scope
            const staticBlockScopeId = computeSemanticIdV2('SCOPE', `static_block#${discriminator}`, module.file, scopeTracker.getNamedParent());

            // Add to class staticBlocks array for CONTAINS edge
            if (!currentClass.staticBlocks) {
              currentClass.staticBlocks = [];
            }
            currentClass.staticBlocks.push(staticBlockScopeId);

            // Create SCOPE node for static block
            (scopes as ScopeInfo[]).push({
              id: staticBlockScopeId,
              semanticId: staticBlockScopeId,
              type: 'SCOPE',
              scopeType: 'static_block',
              name: `${className}:static_block#${discriminator}`,
              conditional: false,
              file: module.file,
              line: blockLine,
              parentClassId: currentClass.id  // For CONTAINS edge creation
            });

            // Analyze static block body using existing infrastructure
            analyzeFunctionBody(staticBlockPath as NodePath<StaticBlock>, staticBlockScopeId, module, collections);

            // Exit static block scope
            scopeTracker.exitScope();
          },

          // REG-271: Private property handler
          ClassPrivateProperty: (propPath: NodePath) => {
            const propNode = propPath.node as ClassPrivateProperty;

            // Skip if not direct child of current class
            if (propPath.parent !== classNode.body) {
              return;
            }

            // Extract name: PrivateName.id.name is WITHOUT # prefix
            // For #privateField, key.id.name = "privateField"
            const privateName = (propNode.key as PrivateName).id.name;
            const displayName = `#${privateName}`;  // Prepend # for clarity

            const propLine = getLine(propNode);
            const propColumn = getColumn(propNode);

            // Check if value is a function (arrow function or function expression)
            if (propNode.value &&
                (propNode.value.type === 'ArrowFunctionExpression' ||
                 propNode.value.type === 'FunctionExpression')) {
              // Handle as private method (function-valued property)
              const funcNode = propNode.value as ArrowFunctionExpression | FunctionExpression;

              const functionId = computeSemanticIdV2('FUNCTION', displayName, module.file, scopeTracker.getNamedParent());

              // Add to class methods list for CONTAINS edges
              currentClass.methods.push(functionId);

              (functions as ClassFunctionInfo[]).push({
                id: functionId,
                type: 'FUNCTION',
                name: displayName,
                file: module.file,
                line: propLine,
                column: propColumn,
                async: funcNode.async || false,
                generator: funcNode.type === 'FunctionExpression' ? funcNode.generator || false : false,
                arrowFunction: funcNode.type === 'ArrowFunctionExpression',
                isClassProperty: true,
                isPrivate: true,
                isStatic: propNode.static || false,
                className: className
              });

              // Enter method scope for tracking
              scopeTracker.enterScope(displayName, 'FUNCTION');

              // Create PARAMETER nodes if needed
              if (parameters) {
                createParameterNodes(funcNode.params, functionId, module.file, propLine, parameters as ParameterInfo[], scopeTracker);
              }

              // Create SCOPE for property function body
              const propBodyScopeId = computeSemanticIdV2('SCOPE', 'body', module.file, scopeTracker.getNamedParent());
              (scopes as ScopeInfo[]).push({
                id: propBodyScopeId,
                semanticId: propBodyScopeId,
                type: 'SCOPE',
                scopeType: 'property_body',
                name: `${className}.${displayName}:body`,
                conditional: false,
                file: module.file,
                line: propLine,
                parentFunctionId: functionId
              });

              const funcPath = propPath.get('value') as NodePath<ArrowFunctionExpression | FunctionExpression>;
              analyzeFunctionBody(funcPath, propBodyScopeId, module, collections);

              // Exit method scope
              scopeTracker.exitScope();
            } else {
              // Handle as private field (non-function property)
              const variableId = computeSemanticIdV2('VARIABLE', displayName, module.file, scopeTracker.getNamedParent());

              // Add to class properties list for HAS_PROPERTY edges
              if (!currentClass.properties) {
                currentClass.properties = [];
              }
              currentClass.properties.push(variableId);

              // Add to variableDeclarations for VARIABLE node creation
              (collections.variableDeclarations as VariableDeclarationInfo[]).push({
                id: variableId,
                semanticId: variableId,
                type: 'VARIABLE',
                name: displayName,
                file: module.file,
                line: propLine,
                column: propColumn,
                isPrivate: true,
                isStatic: propNode.static || false,
                isClassProperty: true,
                parentScopeId: currentClass.id  // Use class ID as parent for HAS_PROPERTY edge
              });

              // Extract decorators if present
              const propNodeWithDecorators = propNode as ClassPrivateProperty & { decorators?: Decorator[] };
              if (propNodeWithDecorators.decorators && propNodeWithDecorators.decorators.length > 0 && decorators) {
                for (const decorator of propNodeWithDecorators.decorators) {
                  const decoratorInfo = this.extractDecoratorInfo(decorator, variableId, 'PROPERTY', module);
                  if (decoratorInfo) {
                    (decorators as DecoratorInfo[]).push(decoratorInfo);
                  }
                }
              }
            }
          },

          // REG-271: Private method handler
          ClassPrivateMethod: (methodPath: NodePath) => {
            const methodNode = methodPath.node as ClassPrivateMethod;

            // Skip if not direct child of current class
            if (methodPath.parent !== classNode.body) {
              return;
            }

            // Extract name: PrivateName.id.name is WITHOUT # prefix
            const privateName = (methodNode.key as PrivateName).id.name;
            const displayName = `#${privateName}`;  // Prepend # for clarity

            const methodLine = getLine(methodNode);
            const methodColumn = getColumn(methodNode);

            // Use semantic ID as primary ID
            // For getter/setter, include kind in name for unique ID (e.g., "get:#prop", "set:#prop")
            const kind = methodNode.kind as 'get' | 'set' | 'method';
            const semanticName = (kind === 'get' || kind === 'set') ? `${kind}:${displayName}` : displayName;
            const functionId = computeSemanticIdV2('FUNCTION', semanticName, module.file, scopeTracker.getNamedParent());

            // Add method to class methods list for CONTAINS edges
            currentClass.methods.push(functionId);

            const funcData: ClassFunctionInfo = {
              id: functionId,
              type: 'FUNCTION',
              name: displayName,
              file: module.file,
              line: methodLine,
              column: methodColumn,
              async: methodNode.async || false,
              generator: methodNode.generator || false,
              isClassMethod: true,
              isPrivate: true,
              isStatic: methodNode.static || false,
              className: className,
              methodKind: methodNode.kind as 'get' | 'set' | 'method'
            };
            (functions as ClassFunctionInfo[]).push(funcData);

            // Extract method decorators
            const methodNodeWithDecorators = methodNode as ClassPrivateMethod & { decorators?: Decorator[] };
            if (methodNodeWithDecorators.decorators && methodNodeWithDecorators.decorators.length > 0 && decorators) {
              for (const decorator of methodNodeWithDecorators.decorators) {
                const decoratorInfo = this.extractDecoratorInfo(decorator, functionId, 'METHOD', module);
                if (decoratorInfo) {
                  (decorators as DecoratorInfo[]).push(decoratorInfo);
                }
              }
            }

            // Enter method scope for tracking
            scopeTracker.enterScope(displayName, 'FUNCTION');

            // Create PARAMETER nodes
            if (parameters) {
              createParameterNodes(methodNode.params, functionId, module.file, methodLine, parameters as ParameterInfo[], scopeTracker);
            }

            // Create SCOPE for method body
            const methodBodyScopeId = computeSemanticIdV2('SCOPE', 'body', module.file, scopeTracker.getNamedParent());
            (scopes as ScopeInfo[]).push({
              id: methodBodyScopeId,
              semanticId: methodBodyScopeId,
              type: 'SCOPE',
              scopeType: 'method_body',
              name: `${className}.${displayName}:body`,
              conditional: false,
              file: module.file,
              line: methodLine,
              parentFunctionId: functionId
            });

            analyzeFunctionBody(methodPath as NodePath<ClassPrivateMethod>, methodBodyScopeId, module, collections);

            // Exit method scope
            scopeTracker.exitScope();
          }
        });

        // Exit class scope
        scopeTracker.exitScope();
      }
    };
  }
}

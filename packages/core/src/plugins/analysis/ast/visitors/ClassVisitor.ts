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
  Identifier,
  ArrowFunctionExpression,
  FunctionExpression,
  Decorator,
  Node
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers } from './ASTVisitor.js';
import type { AnalyzeFunctionBodyCallback } from './FunctionVisitor.js';
import type { DecoratorInfo, ParameterInfo } from '../types.js';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { createParameterNodes } from '../utils/createParameterNodes.js';
import { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { ClassNode, type ClassNodeRecord } from '../../../../core/nodes/ClassNode.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { getLine, getColumn } from '../utils/location.js';

/**
 * Class declaration info
 * Extends ClassNodeRecord with TypeScript-specific metadata
 */
interface ClassInfo extends ClassNodeRecord {
  implements?: string[];  // TypeScript implements (visitor extension)
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
  parentFunctionId: string;
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
              const functionId = computeSemanticId('FUNCTION', propName, scopeTracker.getContext());

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
              const propBodySemanticId = computeSemanticId('SCOPE', 'body', scopeTracker.getContext());
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
            const functionId = computeSemanticId('FUNCTION', methodName, scopeTracker.getContext());

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
            const methodBodySemanticId = computeSemanticId('SCOPE', 'body', scopeTracker.getContext());
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
          }
        });

        // Exit class scope
        scopeTracker.exitScope();
      }
    };
  }
}

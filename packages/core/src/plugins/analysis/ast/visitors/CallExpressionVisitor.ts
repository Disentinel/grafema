/**
 * CallExpressionVisitor - handles function calls and constructor invocations at module level
 *
 * Handles:
 * - Direct function calls: foo()
 * - Method calls: obj.method()
 * - Event handlers: obj.on('event', handler)
 * - Constructor calls: new Foo(), new Function()
 */

import type { Node, CallExpression, NewExpression, Identifier, MemberExpression } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers, type CounterRef } from './ASTVisitor.js';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';

/**
 * Argument info for PASSES_ARGUMENT edges
 */
interface ArgumentInfo {
  callId: string;
  argIndex: number;
  file: string;
  line: number;
  column: number;
  isSpread?: boolean;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  literalValue?: unknown;
  functionLine?: number;
  functionColumn?: number;
  nestedCallLine?: number;
  nestedCallColumn?: number;
  objectName?: string;
  propertyName?: string;
  expressionType?: string;
}

/**
 * Call site info
 */
interface CallSiteInfo {
  id: string;
  type: 'CALL';
  name: string;
  file: string;
  line: number;
  column: number;
  parentScopeId: string;
  targetFunctionName: string;
  isNew?: boolean;
}

/**
 * Method call info
 */
interface MethodCallInfo {
  id: string;
  type: 'CALL';
  name: string;
  object: string;
  method: string;
  computed?: boolean;
  computedPropertyVar?: string | null;
  file: string;
  line: number;
  column: number;
  parentScopeId: string;
  isNew?: boolean;
}

/**
 * Event listener info
 */
interface EventListenerInfo {
  id: string;
  type: 'event:listener';
  name: string;
  object: string;
  file: string;
  line: number;
  parentScopeId: string;
  callbackArg: Node;
}

/**
 * Method callback info
 */
interface MethodCallbackInfo {
  methodCallId: string;
  callbackLine: number;
  callbackColumn: number;
  callbackType: string;
}

/**
 * Literal node info
 */
interface LiteralInfo {
  id: string;
  type: 'LITERAL' | 'EXPRESSION';
  value?: unknown;
  valueType?: string;
  expressionType?: string;
  operator?: string;
  name?: string;
  file: string;
  line: number;
  column: number;
  parentCallId: string;
  argIndex: number;
}

export class CallExpressionVisitor extends ASTVisitor {
  constructor(module: VisitorModule, collections: VisitorCollections) {
    super(module, collections);
  }

  /**
   * Extract argument information for PASSES_ARGUMENT edges
   */
  extractArguments(
    args: CallExpression['arguments'],
    callId: string,
    module: VisitorModule,
    callArguments: ArgumentInfo[],
    literals: LiteralInfo[],
    literalCounterRef: CounterRef
  ): void {
    args.forEach((arg, index) => {
      const argInfo: ArgumentInfo = {
        callId,
        argIndex: index,
        file: module.file,
        line: arg.loc?.start.line || 0,
        column: arg.loc?.start.column || 0
      };

      // Check for spread: ...arg
      let actualArg: Node = arg;
      if (arg.type === 'SpreadElement') {
        argInfo.isSpread = true;
        actualArg = arg.argument;  // Get the actual argument
      }

      // Literal value
      const literalValue = ExpressionEvaluator.extractLiteralValue(actualArg);
      if (literalValue !== null) {
        const literalId = `LITERAL#arg${index}#${module.file}#${argInfo.line}:${argInfo.column}:${literalCounterRef.value++}`;
        literals.push({
          id: literalId,
          type: 'LITERAL',
          value: literalValue,
          valueType: typeof literalValue,
          file: module.file,
          line: argInfo.line,
          column: argInfo.column,
          parentCallId: callId,
          argIndex: index
        });
        argInfo.targetType = 'LITERAL';
        argInfo.targetId = literalId;
        argInfo.literalValue = literalValue;
      }
      // Variable reference
      else if (actualArg.type === 'Identifier') {
        argInfo.targetType = 'VARIABLE';
        argInfo.targetName = (actualArg as Identifier).name;  // Will be resolved in GraphBuilder
      }
      // Function expression (callback)
      else if (actualArg.type === 'ArrowFunctionExpression' || actualArg.type === 'FunctionExpression') {
        argInfo.targetType = 'FUNCTION';
        argInfo.functionLine = actualArg.loc?.start.line;
        argInfo.functionColumn = actualArg.loc?.start.column;
      }
      // Call expression (nested call)
      else if (actualArg.type === 'CallExpression') {
        argInfo.targetType = 'CALL';
        // Nested calls will be processed separately, link by position
        argInfo.nestedCallLine = actualArg.loc?.start.line;
        argInfo.nestedCallColumn = actualArg.loc?.start.column;
      }
      // Member expression: obj.prop or obj[x]
      else if (actualArg.type === 'MemberExpression') {
        const memberExpr = actualArg as MemberExpression;
        argInfo.targetType = 'EXPRESSION';
        argInfo.expressionType = 'MemberExpression';
        if (memberExpr.object.type === 'Identifier') {
          argInfo.objectName = memberExpr.object.name;
        }
        if (!memberExpr.computed && memberExpr.property.type === 'Identifier') {
          argInfo.propertyName = memberExpr.property.name;
        }
      }
      // Binary/Logical expression: a + b, a && b
      else if (actualArg.type === 'BinaryExpression' || actualArg.type === 'LogicalExpression') {
        const expr = actualArg as { operator?: string; type: string };
        const operator = expr.operator || '?';
        const exprName = `<${actualArg.type}:${operator}>`;
        const expressionId = `EXPRESSION#${exprName}#${module.file}#${argInfo.line}:${argInfo.column}:${literalCounterRef.value++}`;

        // Create EXPRESSION node
        literals.push({
          id: expressionId,
          type: 'EXPRESSION',
          expressionType: actualArg.type,
          operator: operator,
          name: exprName,
          file: module.file,
          line: argInfo.line,
          column: argInfo.column,
          parentCallId: callId,
          argIndex: index
        });

        argInfo.targetType = 'EXPRESSION';
        argInfo.targetId = expressionId;
        argInfo.expressionType = actualArg.type;

        // Track DERIVES_FROM edges for identifiers in expression
        const identifiers = this.extractIdentifiers(actualArg);
        const { variableAssignments } = this.collections;
        if (variableAssignments) {
          for (const identName of identifiers) {
            variableAssignments.push({
              variableId: expressionId,
              sourceId: null,
              sourceName: identName,
              sourceType: 'DERIVES_FROM_VARIABLE',
              file: module.file
            });
          }
        }
      }
      // Object literal
      else if (actualArg.type === 'ObjectExpression') {
        argInfo.targetType = 'OBJECT_LITERAL';
      }
      // Array literal
      else if (actualArg.type === 'ArrayExpression') {
        argInfo.targetType = 'ARRAY_LITERAL';
      }
      // Other expression types
      else {
        argInfo.targetType = 'EXPRESSION';
        argInfo.expressionType = actualArg.type;
      }

      callArguments.push(argInfo);
    });
  }

  /**
   * Extract all Identifier names from an expression (recursively)
   * Used for BinaryExpression/LogicalExpression to track DERIVES_FROM edges
   */
  extractIdentifiers(node: Node | null | undefined, identifiers: Set<string> = new Set()): string[] {
    if (!node) return Array.from(identifiers);

    if (node.type === 'Identifier') {
      identifiers.add((node as Identifier).name);
    } else if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      const expr = node as { left: Node; right: Node };
      this.extractIdentifiers(expr.left, identifiers);
      this.extractIdentifiers(expr.right, identifiers);
    } else if (node.type === 'UnaryExpression') {
      const expr = node as { argument: Node };
      this.extractIdentifiers(expr.argument, identifiers);
    } else if (node.type === 'ConditionalExpression') {
      const expr = node as { test: Node; consequent: Node; alternate: Node };
      this.extractIdentifiers(expr.test, identifiers);
      this.extractIdentifiers(expr.consequent, identifiers);
      this.extractIdentifiers(expr.alternate, identifiers);
    } else if (node.type === 'MemberExpression') {
      const memberExpr = node as MemberExpression;
      // For obj.prop - track obj (but not prop as it's a property name)
      if (memberExpr.object.type === 'Identifier') {
        identifiers.add(memberExpr.object.name);
      } else {
        this.extractIdentifiers(memberExpr.object, identifiers);
      }
    } else if (node.type === 'CallExpression') {
      const callExpr = node as CallExpression;
      // For func() - track func if identifier, and all arguments
      if (callExpr.callee.type === 'Identifier') {
        identifiers.add((callExpr.callee as Identifier).name);
      }
      for (const arg of callExpr.arguments) {
        if (arg.type !== 'SpreadElement') {
          this.extractIdentifiers(arg, identifiers);
        } else {
          this.extractIdentifiers(arg.argument, identifiers);
        }
      }
    }

    return Array.from(identifiers);
  }

  /**
   * Get a stable scope ID for a function parent
   * Format must match what FunctionVisitor creates:
   * - FunctionDeclaration: FUNCTION#name#file#line
   * - ArrowFunctionExpression: FUNCTION#name#file#line:col:counter
   *
   * NOTE: We don't have access to the counter here, so for arrow functions
   * we try to match by name+file+line:col. This may not always work for
   * multiple arrow functions on the same line.
   */
  getFunctionScopeId(functionParent: NodePath, module: VisitorModule): string {
    const funcNode = functionParent.node as Node & {
      id?: { name: string } | null;
      loc?: { start: { line: number; column: number } };
      type: string;
    };
    const line = funcNode.loc?.start.line || 0;
    const col = funcNode.loc?.start.column || 0;

    // FunctionDeclaration with name
    if (funcNode.type === 'FunctionDeclaration' && funcNode.id?.name) {
      return `FUNCTION#${funcNode.id.name}#${module.file}#${line}`;
    }

    // For arrow functions and other cases, we can't perfectly match the ID
    // because FunctionVisitor uses a counter. For now, use module.id as fallback
    // to avoid creating invalid edges. The CALL node will be connected to MODULE
    // instead of the specific function.
    return module.id;
  }

  getHandlers(): VisitorHandlers {
    const { module } = this;
    const callSites = this.collections.callSites ?? [];
    const methodCalls = this.collections.methodCalls ?? [];
    const eventListeners = this.collections.eventListeners ?? [];
    const methodCallbacks = this.collections.methodCallbacks ?? [];
    const literals = this.collections.literals ?? [];
    const callArguments = this.collections.callArguments ?? [];
    const callSiteCounterRef = (this.collections.callSiteCounterRef ?? { value: 0 }) as CounterRef;
    const literalCounterRef = (this.collections.literalCounterRef ?? { value: 0 }) as CounterRef;
    const processedNodes = this.collections.processedNodes ?? { callSites: new Set(), methodCalls: new Set(), eventListeners: new Set() };

    return {
      CallExpression: (path: NodePath) => {
        const callNode = path.node as CallExpression;
        const functionParent = path.getFunctionParent();
        // Determine parent scope - if inside a function, use function's scope, otherwise module
        const parentScopeId = functionParent ? this.getFunctionScopeId(functionParent, module) : module.id;

        // Identifier calls (direct function calls)
          if (callNode.callee.type === 'Identifier') {
            const callee = callNode.callee as Identifier;
            const callId = `CALL#${callee.name}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`;

            (callSites as CallSiteInfo[]).push({
              id: callId,
              type: 'CALL',
              name: callee.name,
              file: module.file,
              line: callNode.loc!.start.line,
              column: callNode.loc!.start.column,
              parentScopeId,
              targetFunctionName: callee.name
            });

            // Extract arguments for PASSES_ARGUMENT edges
            if (callNode.arguments.length > 0) {
              this.extractArguments(
                callNode.arguments,
                callId,
                module,
                callArguments as ArgumentInfo[],
                literals as LiteralInfo[],
                literalCounterRef
              );
            }
          }
          // MemberExpression calls (method calls at module level)
          else if (callNode.callee.type === 'MemberExpression') {
            const memberCallee = callNode.callee as MemberExpression;
            const object = memberCallee.object;
            const property = memberCallee.property;
            const isComputed = memberCallee.computed;

            if ((object.type === 'Identifier' || object.type === 'ThisExpression') && property.type === 'Identifier') {
              const objectName = object.type === 'Identifier' ? (object as Identifier).name : 'this';
              // For computed access obj[x](), methodName is '<computed>' but we save the variable name
              const methodName = isComputed ? '<computed>' : (property as Identifier).name;
              const computedPropertyVar = isComputed ? (property as Identifier).name : null;

              // Special handling for .on() event handlers
              if (methodName === 'on' && callNode.arguments.length >= 2) {
                const firstArg = callNode.arguments[0];
                const secondArg = callNode.arguments[1];

                if (firstArg.type === 'StringLiteral') {
                  const eventName = firstArg.value;

                  // Dedup check
                  const nodeKey = `${callNode.start}:${callNode.end}`;
                  if (processedNodes.eventListeners.has(nodeKey)) {
                    return;
                  }
                  processedNodes.eventListeners.add(nodeKey);

                  (eventListeners as EventListenerInfo[]).push({
                    id: `event:listener#${eventName}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`,
                    type: 'event:listener',
                    name: eventName,
                    object: objectName,
                    file: module.file,
                    line: callNode.loc!.start.line,
                    parentScopeId,
                    callbackArg: secondArg
                  });
                }
              } else {
                // Regular method call
                const nodeKey = `${callNode.start}:${callNode.end}`;
                if (processedNodes.methodCalls.has(nodeKey)) {
                  return;
                }
                processedNodes.methodCalls.add(nodeKey);

                const fullName = `${objectName}.${methodName}`;
                const methodCallId = `CALL#${fullName}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`;

                (methodCalls as MethodCallInfo[]).push({
                  id: methodCallId,
                  type: 'CALL',
                  name: fullName,
                  object: objectName,
                  method: methodName,
                  computed: isComputed,
                  computedPropertyVar,  // Variable name used in obj[x]() calls
                  file: module.file,
                  line: callNode.loc!.start.line,
                  column: callNode.loc!.start.column,
                  parentScopeId
                });

                // Extract arguments for PASSES_ARGUMENT edges
                if (callNode.arguments.length > 0) {
                  this.extractArguments(
                    callNode.arguments,
                    methodCallId,
                    module,
                    callArguments as ArgumentInfo[],
                    literals as LiteralInfo[],
                    literalCounterRef
                  );

                  // Also track callbacks for HAS_CALLBACK edges
                  callNode.arguments.forEach((arg) => {
                    if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
                      (methodCallbacks as MethodCallbackInfo[]).push({
                        methodCallId,
                        callbackLine: arg.loc!.start.line,
                        callbackColumn: arg.loc!.start.column,
                        callbackType: arg.type
                      });
                    }
                  });
                }
              }
            }
          }
      },

      // NewExpression: new Foo(), new Function(), new Map(), etc.
      NewExpression: (path: NodePath) => {
        const newNode = path.node as NewExpression;
        const functionParent = path.getFunctionParent();
        const parentScopeId = functionParent ? this.getFunctionScopeId(functionParent, module) : module.id;

        // Dedup check
        const nodeKey = `new:${newNode.start}:${newNode.end}`;
        if (processedNodes.methodCalls.has(nodeKey)) {
          return;
        }
        processedNodes.methodCalls.add(nodeKey);

        // new Foo() - Identifier callee
        if (newNode.callee.type === 'Identifier') {
          const callee = newNode.callee as Identifier;
          const constructorName = callee.name;

          (callSites as CallSiteInfo[]).push({
            id: `CALL#new:${constructorName}#${module.file}#${newNode.loc!.start.line}:${newNode.loc!.start.column}:${callSiteCounterRef.value++}`,
            type: 'CALL',
            name: constructorName,
            file: module.file,
            line: newNode.loc!.start.line,
            column: newNode.loc!.start.column,
            parentScopeId,
            targetFunctionName: constructorName,
            isNew: true  // Mark as constructor call
          });
        }
        // new obj.Constructor() - MemberExpression callee
        else if (newNode.callee.type === 'MemberExpression') {
          const memberCallee = newNode.callee as MemberExpression;
          const object = memberCallee.object;
          const property = memberCallee.property;

          if (object.type === 'Identifier' && property.type === 'Identifier') {
            const objectName = (object as Identifier).name;
            const constructorName = (property as Identifier).name;
            const fullName = `${objectName}.${constructorName}`;

            (methodCalls as MethodCallInfo[]).push({
              id: `CALL#new:${fullName}#${module.file}#${newNode.loc!.start.line}:${newNode.loc!.start.column}:${callSiteCounterRef.value++}`,
              type: 'CALL',
              name: fullName,
              object: objectName,
              method: constructorName,
              file: module.file,
              line: newNode.loc!.start.line,
              column: newNode.loc!.start.column,
              parentScopeId,
              isNew: true  // Mark as constructor call
            });
          }
        }
      }
    };
  }
}

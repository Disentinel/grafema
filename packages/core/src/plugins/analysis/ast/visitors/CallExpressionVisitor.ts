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
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { MutationDetector } from './MutationDetector.js';
import { IdGenerator } from '../IdGenerator.js';
import { getLine, getColumn } from '../utils/location.js';
import { getGrafemaIgnore } from './call-expression-helpers.js';
import { ArgumentExtractor } from './ArgumentExtractor.js';
import type {
  ArgumentInfo, CallSiteInfo, MethodCallInfo, EventListenerInfo,
  MethodCallbackInfo, LiteralInfo,
} from './call-expression-types.js';

export class CallExpressionVisitor extends ASTVisitor {
  private scopeTracker?: ScopeTracker;

  /**
   * @param module - Current module being analyzed
   * @param collections - Must contain arrays and counter refs
   * @param scopeTracker - Optional ScopeTracker for semantic ID generation
   */
  constructor(module: VisitorModule, collections: VisitorCollections, scopeTracker?: ScopeTracker) {
    super(module, collections);
    this.scopeTracker = scopeTracker;
  }




  /**
   * Extract full dotted name from a MemberExpression chain.
   * For `a.b.c` returns "a.b.c". Returns null for complex expressions.
   *
   * Used by REG-395 to create CALL nodes for nested method calls like a.b.c().
   */
  static extractMemberExpressionName(node: MemberExpression): string | null {
    const parts: string[] = [];
    let current: MemberExpression | null = node;

    // Walk the chain collecting property names
    while (current) {
      if (current.computed) return null; // Can't statically resolve computed access
      if (current.property.type !== 'Identifier') return null;
      parts.unshift((current.property as Identifier).name);

      if (current.object.type === 'Identifier') {
        parts.unshift((current.object as Identifier).name);
        return parts.join('.');
      } else if (current.object.type === 'ThisExpression') {
        parts.unshift('this');
        return parts.join('.');
      } else if (current.object.type === 'MemberExpression') {
        current = current.object as MemberExpression;
      } else {
        return null; // Complex expression
      }
    }

    return null;
  }

  /**
   * Get a stable scope ID for a function parent.
   *
   * Format must match what FunctionVisitor/ClassVisitor creates (semantic ID):
   * - Module-level function: {file}->global->FUNCTION->{name}
   * - Class method: {file}->{className}->FUNCTION->{methodName}
   *
   * Reconstructs scope path by walking up the AST.
   */
  getFunctionScopeId(functionParent: NodePath, module: VisitorModule): string {
    const funcNode = functionParent.node as Node & {
      id?: { name: string } | null;
      key?: { name?: string; type: string };
      loc?: { start: { line: number; column: number } };
      type: string;
    };

    // Get function name
    let funcName: string | undefined;
    if (funcNode.type === 'FunctionDeclaration' && funcNode.id?.name) {
      funcName = funcNode.id.name;
    } else if (funcNode.type === 'ClassMethod' && funcNode.key?.type === 'Identifier') {
      funcName = funcNode.key.name;
    }

    if (!funcName) {
      // Anonymous function - fall back to module scope
      return module.id;
    }

    // Build scope path by walking up the AST
    const scopePath: string[] = [];
    let current: NodePath | null = functionParent.parentPath;

    while (current) {
      const node = current.node as Node & {
        id?: { name: string } | null;
        type: string;
      };

      if (node.type === 'ClassDeclaration' && node.id?.name) {
        scopePath.unshift(node.id.name);
        break; // Class is the outermost scope we need
      } else if (node.type === 'ClassBody') {
        // Continue up to ClassDeclaration
      } else if (node.type === 'Program') {
        break;
      }

      current = current.parentPath;
    }

    // If no class found, it's at module level (global scope)
    if (scopePath.length === 0) {
      scopePath.push('global');
    }

    // Compute semantic ID: {file}->{scopePath}->FUNCTION->{name}
    return `${module.file}->${scopePath.join('->')}->FUNCTION->${funcName}`;
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
    const scopeTracker = this.scopeTracker;

    return {
      CallExpression: (path: NodePath) => {
        const callNode = path.node as CallExpression;
        const functionParent = path.getFunctionParent();

        // Determine parent scope - if inside a function, use function's scope, otherwise module
        const parentScopeId = functionParent ? this.getFunctionScopeId(functionParent, module) : module.id;

        // REG-297: Detect isAwaited for module-level calls (parent is AwaitExpression)
        const isAwaited = path.parentPath?.isAwaitExpression() ?? false;

        // Identifier calls (direct function calls)
        // Skip if inside function - they will be processed by analyzeFunctionBody with proper scope tracking
          if (callNode.callee.type === 'Identifier') {
            if (functionParent) {
              return;
            }
            const callee = callNode.callee as Identifier;

            const line = getLine(callNode);
            const column = getColumn(callNode);

            // Generate ID using centralized IdGenerator
            const idGenerator = new IdGenerator(scopeTracker);
            const callId = idGenerator.generate(
              'CALL', callee.name, module.file,
              line, column,
              callSiteCounterRef,
              { useDiscriminator: true, discriminatorKey: `CALL:${callee.name}` }
            );

            (callSites as CallSiteInfo[]).push({
              id: callId,
              type: 'CALL',
              name: callee.name,
              file: module.file,
              line,
              column,
              parentScopeId,
              targetFunctionName: callee.name,
              isAwaited: isAwaited || undefined
            });

            // Extract arguments for PASSES_ARGUMENT edges
            if (callNode.arguments.length > 0) {
              ArgumentExtractor.extract(
                callNode.arguments,
                callId,
                module,
                callArguments as ArgumentInfo[],
                literals as LiteralInfo[],
                literalCounterRef,
                this.collections,
                scopeTracker
              );
            }
          }
          // MemberExpression calls (method calls)
          // Skip if inside function - they will be processed by analyzeFunctionBody with proper scope tracking
          else if (callNode.callee.type === 'MemberExpression') {
            if (functionParent) {
              return;
            }
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

                  const eventLine = getLine(callNode);
                  const eventColumn = getColumn(callNode);

                  (eventListeners as EventListenerInfo[]).push({
                    id: `event:listener#${eventName}#${module.file}#${eventLine}:${eventColumn}:${callSiteCounterRef.value++}`,
                    type: 'event:listener',
                    name: eventName,
                    object: objectName,
                    file: module.file,
                    line: eventLine,
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
                const methodLine = getLine(callNode);
                const methodColumn = getColumn(callNode);

                // Generate ID using centralized IdGenerator
                const idGenerator = new IdGenerator(scopeTracker);
                const methodCallId = idGenerator.generate(
                  'CALL', fullName, module.file,
                  methodLine, methodColumn,
                  callSiteCounterRef,
                  { useDiscriminator: true, discriminatorKey: `CALL:${fullName}` }
                );

                // REG-332: Check for grafema-ignore comment
                const grafemaIgnore = getGrafemaIgnore(path);

                (methodCalls as MethodCallInfo[]).push({
                  id: methodCallId,
                  type: 'CALL',
                  name: fullName,
                  object: objectName,
                  method: methodName,
                  computed: isComputed,
                  computedPropertyVar,  // Variable name used in obj[x]() calls
                  file: module.file,
                  line: methodLine,
                  column: methodColumn,
                  parentScopeId,
                  grafemaIgnore: grafemaIgnore ?? undefined,
                  isAwaited: isAwaited || undefined,
                });

                // Check for array mutation methods (push, unshift, splice)
                const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];
                if (ARRAY_MUTATION_METHODS.includes(methodName)) {
                  MutationDetector.detectArrayMutation(
                    callNode, objectName,
                    methodName as 'push' | 'unshift' | 'splice',
                    module, this.collections, scopeTracker
                  );
                }

                // Check for Object.assign() calls
                if (objectName === 'Object' && methodName === 'assign') {
                  MutationDetector.detectObjectAssign(callNode, module, this.collections, scopeTracker);
                }

                // Extract arguments for PASSES_ARGUMENT edges
                if (callNode.arguments.length > 0) {
                  ArgumentExtractor.extract(
                    callNode.arguments,
                    methodCallId,
                    module,
                    callArguments as ArgumentInfo[],
                    literals as LiteralInfo[],
                    literalCounterRef,
                    this.collections,
                    scopeTracker
                  );

                  // Also track callbacks for HAS_CALLBACK edges
                  callNode.arguments.forEach((arg) => {
                    if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
                      (methodCallbacks as MethodCallbackInfo[]).push({
                        methodCallId,
                        callbackLine: getLine(arg),
                        callbackColumn: getColumn(arg),
                        callbackType: arg.type
                      });
                    }
                  });
                }
              }
            }
            // REG-117: Nested array mutations like obj.arr.push(item)
            // REG-395: General nested method calls like a.b.c() or obj.nested.method()
            // object is MemberExpression, property is the method name
            else if (object.type === 'MemberExpression' && property.type === 'Identifier') {
              const nestedMember = object as MemberExpression;
              const methodName = isComputed ? '<computed>' : (property as Identifier).name;
              const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];

              if (ARRAY_MUTATION_METHODS.includes(methodName)) {
                // Extract base object and property from nested MemberExpression
                const base = nestedMember.object;
                const prop = nestedMember.property;

                // Only handle single-level nesting: obj.arr.push() or this.items.push()
                if ((base.type === 'Identifier' || base.type === 'ThisExpression') &&
                    !nestedMember.computed &&
                    prop.type === 'Identifier') {
                  const baseObjectName = base.type === 'Identifier' ? (base as Identifier).name : 'this';
                  const propertyName = (prop as Identifier).name;

                  MutationDetector.detectArrayMutation(
                    callNode,
                    `${baseObjectName}.${propertyName}`,  // arrayName for ID purposes
                    methodName as 'push' | 'unshift' | 'splice',
                    module, this.collections, scopeTracker,
                    true,          // isNested
                    baseObjectName,
                    propertyName
                  );
                }
              }

              // REG-395: Create CALL node for nested method calls like a.b.c()
              // Extract full object name by walking the MemberExpression chain
              const objectName = CallExpressionVisitor.extractMemberExpressionName(nestedMember);
              if (objectName) {
                const nodeKey = `${callNode.start}:${callNode.end}`;
                if (!processedNodes.methodCalls.has(nodeKey)) {
                  processedNodes.methodCalls.add(nodeKey);

                  const fullName = `${objectName}.${methodName}`;
                  const methodLine = getLine(callNode);
                  const methodColumn = getColumn(callNode);

                  const idGenerator = new IdGenerator(scopeTracker);
                  const methodCallId = idGenerator.generate(
                    'CALL', fullName, module.file,
                    methodLine, methodColumn,
                    callSiteCounterRef,
                    { useDiscriminator: true, discriminatorKey: `CALL:${fullName}` }
                  );

                  const grafemaIgnore = getGrafemaIgnore(path);

                  (methodCalls as MethodCallInfo[]).push({
                    id: methodCallId,
                    type: 'CALL',
                    name: fullName,
                    object: objectName,
                    method: methodName,
                    file: module.file,
                    line: methodLine,
                    column: methodColumn,
                    parentScopeId,
                    grafemaIgnore: grafemaIgnore ?? undefined,
                  });
                }
              }
            }
          }
      },

      // NewExpression: new Foo(), new Function(), new Map(), etc.
      // Skip if inside function - they will be processed by analyzeFunctionBody with proper scope tracking
      NewExpression: (path: NodePath) => {
        const newNode = path.node as NewExpression;
        const functionParent = path.getFunctionParent();

        // Skip if inside function - handled by analyzeFunctionBody
        if (functionParent) {
          return;
        }

        const parentScopeId = module.id;

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
          const newLine = getLine(newNode);
          const newColumn = getColumn(newNode);

          // Generate ID using centralized IdGenerator
          const idGenerator = new IdGenerator(scopeTracker);
          const newCallId = idGenerator.generate(
            'CALL', `new:${constructorName}`, module.file,
            newLine, newColumn,
            callSiteCounterRef,
            { useDiscriminator: true, discriminatorKey: `CALL:new:${constructorName}` }
          );

          (callSites as CallSiteInfo[]).push({
            id: newCallId,
            type: 'CALL',
            name: constructorName,
            file: module.file,
            line: newLine,
            column: newColumn,
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
            const memberNewLine = getLine(newNode);
            const memberNewColumn = getColumn(newNode);

            // Generate ID using centralized IdGenerator
            const idGenerator = new IdGenerator(scopeTracker);
            const newMethodCallId = idGenerator.generate(
              'CALL', `new:${fullName}`, module.file,
              memberNewLine, memberNewColumn,
              callSiteCounterRef,
              { useDiscriminator: true, discriminatorKey: `CALL:new:${fullName}` }
            );

            // REG-332: Check for grafema-ignore comment
            const grafemaIgnore = getGrafemaIgnore(path);

            (methodCalls as MethodCallInfo[]).push({
              id: newMethodCallId,
              type: 'CALL',
              name: fullName,
              object: objectName,
              method: constructorName,
              file: module.file,
              line: memberNewLine,
              column: memberNewColumn,
              parentScopeId,
              isNew: true,  // Mark as constructor call
              grafemaIgnore: grafemaIgnore ?? undefined,
            });
          }
        }
      }
    };
  }
}

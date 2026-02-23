/**
 * CallExpressionVisitor - handles function calls and constructor invocations at module level
 *
 * Handles:
 * - Direct function calls: foo()
 * - Method calls: obj.method()
 * - Event handlers: obj.on('event', handler)
 */

import type { Node, CallExpression, Identifier, MemberExpression } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers, type CounterRef } from './ASTVisitor.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { ContentHashHints } from '../../../../core/SemanticId.js';
import { MutationDetector } from './MutationDetector.js';
import { IdGenerator } from '../IdGenerator.js';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { getLine, getColumn, getEndLocation } from '../utils/location.js';
import { getGrafemaIgnore } from './call-expression-helpers.js';
import { ArgumentExtractor } from './ArgumentExtractor.js';
import type {
  ArgumentInfo, CallSiteInfo, MethodCallInfo, EventListenerInfo,
  MethodCallbackInfo, LiteralInfo,
} from './call-expression-types.js';
/** Dedup tracking used by handler methods. */
interface HandlerProcessedNodes {
  callSites: Set<string>;
  methodCalls: Set<string>;
  eventListeners: Set<string>;
  [key: string]: Set<string>;
}

/** Shared state for handler methods, extracted once in getHandlers(). */
interface HandlerState {
  module: VisitorModule;
  callSites: CallSiteInfo[];
  methodCalls: MethodCallInfo[];
  eventListeners: EventListenerInfo[];
  methodCallbacks: MethodCallbackInfo[];
  literals: LiteralInfo[];
  callArguments: ArgumentInfo[];
  callSiteCounterRef: CounterRef;
  literalCounterRef: CounterRef;
  processedNodes: HandlerProcessedNodes;
  scopeTracker?: ScopeTracker;
}

/**
 * Extract the first literal argument value from a CallExpression for content hash hints.
 */
function extractFirstLiteralArg(node: CallExpression): string | undefined {
  if (node.arguments.length === 0) return undefined;
  const firstArg = node.arguments[0];
  if (!firstArg) return undefined;

  const actualArg = firstArg.type === 'SpreadElement' ? firstArg.argument : firstArg;
  const literalValue = ExpressionEvaluator.extractLiteralValue(actualArg);
  if (literalValue !== null) {
    return String(literalValue);
  }
  return undefined;
}

export class CallExpressionVisitor extends ASTVisitor {
  private scopeTracker?: ScopeTracker;
  private sharedIdGenerator?: IdGenerator;

  constructor(module: VisitorModule, collections: VisitorCollections, scopeTracker?: ScopeTracker, sharedIdGenerator?: IdGenerator) {
    super(module, collections);
    this.scopeTracker = scopeTracker;
    this.sharedIdGenerator = sharedIdGenerator;
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
    const s: HandlerState = {
      module: this.module,
      callSites: (this.collections.callSites ?? []) as CallSiteInfo[],
      methodCalls: (this.collections.methodCalls ?? []) as MethodCallInfo[],
      eventListeners: (this.collections.eventListeners ?? []) as EventListenerInfo[],
      methodCallbacks: (this.collections.methodCallbacks ?? []) as MethodCallbackInfo[],
      literals: (this.collections.literals ?? []) as LiteralInfo[],
      callArguments: (this.collections.callArguments ?? []) as ArgumentInfo[],
      callSiteCounterRef: (this.collections.callSiteCounterRef ?? { value: 0 }) as CounterRef,
      literalCounterRef: (this.collections.literalCounterRef ?? { value: 0 }) as CounterRef,
      processedNodes: this.collections.processedNodes ?? { callSites: new Set(), methodCalls: new Set(), eventListeners: new Set() },
      scopeTracker: this.scopeTracker,
    };

    return {
      CallExpression: (path: NodePath) => {
        const callNode = path.node as CallExpression;
        const functionParent = path.getFunctionParent();

        // Skip if inside function - handled by analyzeFunctionBody
        if (functionParent) return;

        const parentScopeId = s.module.id;
        const isAwaited = path.parentPath?.isAwaitExpression() ?? false;

        if (callNode.callee.type === 'Identifier') {
          this.handleDirectCall(callNode, s, parentScopeId, isAwaited);
        } else if (callNode.callee.type === 'MemberExpression') {
          this.handleMemberCall(path, callNode, s, parentScopeId, isAwaited);
        }
      },

      // REG-534: TaggedTemplateExpression creates CALL node (html`...`, styled.div`...`)
      TaggedTemplateExpression: (path: NodePath) => {
        const tagNode = path.node as { tag: Node; loc?: { start: { line: number; column: number } }; start?: number; end?: number };
        const functionParent = path.getFunctionParent();

        // Skip if inside function - handled by analyzeFunctionBody
        if (functionParent) return;

        const parentScopeId = s.module.id;
        const tag = tagNode.tag;

        if (tag.type === 'Identifier') {
          // Simple tag: html`...`
          const tagName = (tag as Identifier).name;
          const tagLine = getLine(tagNode as Node);
          const tagColumn = getColumn(tagNode as Node);

          const callInfo: CallSiteInfo = {
            id: '',
            type: 'CALL',
            name: tagName,
            file: s.module.file,
            line: tagLine,
            column: tagColumn,
            endLine: getEndLocation(tagNode as Node).line,
            endColumn: getEndLocation(tagNode as Node).column,
            parentScopeId,
            targetFunctionName: tagName,
          };

          if (this.sharedIdGenerator) {
            const contentHints: ContentHashHints = { arity: 1, firstLiteralArg: undefined };
            this.sharedIdGenerator.generateV2('CALL', tagName, s.module.file, contentHints, callInfo);
          } else {
            const idGenerator = new IdGenerator(s.scopeTracker);
            callInfo.id = idGenerator.generate(
              'CALL', tagName, s.module.file,
              tagLine, tagColumn,
              s.callSiteCounterRef,
              { useDiscriminator: true, discriminatorKey: `CALL:${tagName}` }
            );
          }
          s.callSites.push(callInfo);
        } else if (tag.type === 'MemberExpression') {
          // Member tag: styled.div`...`
          const memberTag = tag as MemberExpression;
          const object = memberTag.object;
          const property = memberTag.property;

          if ((object.type === 'Identifier' || object.type === 'ThisExpression') && property.type === 'Identifier') {
            const objectName = object.type === 'Identifier' ? (object as Identifier).name : 'this';
            const methodName = (property as Identifier).name;
            const fullName = `${objectName}.${methodName}`;
            const tagLine = getLine(tagNode as Node);
            const tagColumn = getColumn(tagNode as Node);

            const nodeKey = `tagged:${(tagNode as { start?: number }).start}:${(tagNode as { end?: number }).end}`;
            if (!s.processedNodes.methodCalls.has(nodeKey)) {
              s.processedNodes.methodCalls.add(nodeKey);

              const methodCallInfo: MethodCallInfo = {
                id: '',
                type: 'CALL',
                name: fullName,
                object: objectName,
                method: methodName,
                file: s.module.file,
                line: tagLine,
                column: tagColumn,
                endLine: getEndLocation(tagNode as Node).line,
                endColumn: getEndLocation(tagNode as Node).column,
                parentScopeId,
              };

              if (this.sharedIdGenerator) {
                const contentHints: ContentHashHints = { arity: 1, firstLiteralArg: undefined };
                this.sharedIdGenerator.generateV2('CALL', fullName, s.module.file, contentHints, methodCallInfo);
              } else {
                const idGenerator = new IdGenerator(s.scopeTracker);
                methodCallInfo.id = idGenerator.generate(
                  'CALL', fullName, s.module.file,
                  tagLine, tagColumn,
                  s.callSiteCounterRef,
                  { useDiscriminator: true, discriminatorKey: `CALL:${fullName}` }
                );
              }
              s.methodCalls.push(methodCallInfo);
            }
          }
        }
      },
    };
  }

  /** Handle direct function calls: foo() */
  private handleDirectCall(
    callNode: CallExpression, s: HandlerState,
    parentScopeId: string, isAwaited: boolean
  ): void {
    const callee = callNode.callee as Identifier;
    const line = getLine(callNode);
    const column = getColumn(callNode);

    const callInfo: CallSiteInfo = {
      id: '', // Placeholder — resolved by generateV2 or set below
      type: 'CALL',
      name: callee.name,
      file: s.module.file,
      line,
      column,
      endLine: getEndLocation(callNode).line,
      endColumn: getEndLocation(callNode).column,
      parentScopeId,
      targetFunctionName: callee.name,
      isAwaited: isAwaited || undefined
    };

    if (this.sharedIdGenerator) {
      const contentHints: ContentHashHints = {
        arity: callNode.arguments.length,
        firstLiteralArg: extractFirstLiteralArg(callNode)
      };
      this.sharedIdGenerator.generateV2('CALL', callee.name, s.module.file, contentHints, callInfo);
    } else {
      const idGenerator = new IdGenerator(s.scopeTracker);
      callInfo.id = idGenerator.generate(
        'CALL', callee.name, s.module.file,
        line, column,
        s.callSiteCounterRef,
        { useDiscriminator: true, discriminatorKey: `CALL:${callee.name}` }
      );
    }
    const callId = callInfo.id;

    s.callSites.push(callInfo);

    if (callNode.arguments.length > 0) {
      ArgumentExtractor.extract(
        callNode.arguments, callId, s.module,
        s.callArguments, s.literals, s.literalCounterRef,
        this.collections, s.scopeTracker
      );
    }
  }

  /** Handle method calls: obj.method(), obj.on('event', handler), obj.arr.push() */
  private handleMemberCall(
    path: NodePath, callNode: CallExpression, s: HandlerState,
    parentScopeId: string, isAwaited: boolean
  ): void {
    const memberCallee = callNode.callee as MemberExpression;
    const object = memberCallee.object;
    const property = memberCallee.property;
    const isComputed = memberCallee.computed;

    if ((object.type === 'Identifier' || object.type === 'ThisExpression') && property.type === 'Identifier') {
      this.handleSimpleMethodCall(path, callNode, s, parentScopeId, isAwaited,
        memberCallee, object, property as Identifier, isComputed);
    }
    // REG-117/REG-395: Nested method calls like obj.arr.push() or a.b.c()
    else if (object.type === 'MemberExpression' && property.type === 'Identifier') {
      this.handleNestedMethodCall(path, callNode, s, parentScopeId,
        object as MemberExpression, property as Identifier, isComputed);
    }
  }

  /** Handle simple method calls: obj.method() or obj.on('event', handler) */
  private handleSimpleMethodCall(
    path: NodePath, callNode: CallExpression, s: HandlerState,
    parentScopeId: string, isAwaited: boolean,
    memberCallee: MemberExpression, object: Node, property: Identifier, isComputed: boolean
  ): void {
    const objectName = object.type === 'Identifier' ? (object as Identifier).name : 'this';
    const methodName = isComputed ? '<computed>' : property.name;
    const computedPropertyVar = isComputed ? property.name : null;

    // Special handling for .on() event handlers
    if (methodName === 'on' && callNode.arguments.length >= 2) {
      const firstArg = callNode.arguments[0];
      const secondArg = callNode.arguments[1];

      if (firstArg.type === 'StringLiteral') {
        const nodeKey = `${callNode.start}:${callNode.end}`;
        if (s.processedNodes.eventListeners.has(nodeKey)) return;
        s.processedNodes.eventListeners.add(nodeKey);

        const eventLine = getLine(callNode);
        const eventColumn = getColumn(callNode);

        s.eventListeners.push({
          id: `event:listener#${firstArg.value}#${s.module.file}#${eventLine}:${eventColumn}:${s.callSiteCounterRef.value++}`,
          type: 'event:listener',
          name: firstArg.value,
          object: objectName,
          file: s.module.file,
          line: eventLine,
          parentScopeId,
          callbackArg: secondArg
        });
      }
      return;
    }

    // Regular method call
    const nodeKey = `${callNode.start}:${callNode.end}`;
    if (s.processedNodes.methodCalls.has(nodeKey)) return;
    s.processedNodes.methodCalls.add(nodeKey);

    const fullName = `${objectName}.${methodName}`;
    const methodLine = getLine(callNode);
    const methodColumn = getColumn(callNode);

    const grafemaIgnore = getGrafemaIgnore(path);

    const methodCallInfo: MethodCallInfo = {
      id: '', // Placeholder — resolved by generateV2 or set below
      type: 'CALL',
      name: fullName,
      object: objectName,
      method: methodName,
      computed: isComputed,
      computedPropertyVar,
      file: s.module.file,
      line: methodLine,
      column: methodColumn,
      endLine: getEndLocation(callNode).line,
      endColumn: getEndLocation(callNode).column,
      parentScopeId,
      grafemaIgnore: grafemaIgnore ?? undefined,
      isAwaited: isAwaited || undefined,
    };

    if (this.sharedIdGenerator) {
      const contentHints: ContentHashHints = {
        arity: callNode.arguments.length,
        firstLiteralArg: extractFirstLiteralArg(callNode)
      };
      this.sharedIdGenerator.generateV2('CALL', fullName, s.module.file, contentHints, methodCallInfo);
    } else {
      const idGenerator = new IdGenerator(s.scopeTracker);
      methodCallInfo.id = idGenerator.generate(
        'CALL', fullName, s.module.file,
        methodLine, methodColumn,
        s.callSiteCounterRef,
        { useDiscriminator: true, discriminatorKey: `CALL:${fullName}` }
      );
    }
    const methodCallId = methodCallInfo.id;

    s.methodCalls.push(methodCallInfo);

    // Check for array mutation methods (push, unshift, splice)
    const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];
    if (ARRAY_MUTATION_METHODS.includes(methodName)) {
      MutationDetector.detectArrayMutation(
        callNode, objectName,
        methodName as 'push' | 'unshift' | 'splice',
        s.module, this.collections, s.scopeTracker
      );
    }

    // Check for Object.assign() calls
    if (objectName === 'Object' && methodName === 'assign') {
      MutationDetector.detectObjectAssign(callNode, s.module, this.collections, s.scopeTracker);
    }

    // Extract arguments for PASSES_ARGUMENT edges
    if (callNode.arguments.length > 0) {
      ArgumentExtractor.extract(
        callNode.arguments, methodCallId, s.module,
        s.callArguments, s.literals, s.literalCounterRef,
        this.collections, s.scopeTracker
      );

      // Also track callbacks for HAS_CALLBACK edges
      callNode.arguments.forEach((arg) => {
        if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
          s.methodCallbacks.push({
            methodCallId,
            callbackLine: getLine(arg),
            callbackColumn: getColumn(arg),
            callbackType: arg.type
          });
        }
      });
    }
  }

  /** Handle nested method calls: obj.arr.push(), a.b.c() (REG-117, REG-395) */
  private handleNestedMethodCall(
    path: NodePath, callNode: CallExpression, s: HandlerState,
    parentScopeId: string,
    nestedMember: MemberExpression, property: Identifier, isComputed: boolean
  ): void {
    const methodName = isComputed ? '<computed>' : property.name;
    const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];

    if (ARRAY_MUTATION_METHODS.includes(methodName)) {
      const base = nestedMember.object;
      const prop = nestedMember.property;

      if ((base.type === 'Identifier' || base.type === 'ThisExpression') &&
          !nestedMember.computed && prop.type === 'Identifier') {
        const baseObjectName = base.type === 'Identifier' ? (base as Identifier).name : 'this';
        const propertyName = (prop as Identifier).name;

        MutationDetector.detectArrayMutation(
          callNode,
          `${baseObjectName}.${propertyName}`,
          methodName as 'push' | 'unshift' | 'splice',
          s.module, this.collections, s.scopeTracker,
          true, baseObjectName, propertyName
        );
      }
    }

    // REG-395: Create CALL node for nested method calls like a.b.c()
    const objectName = CallExpressionVisitor.extractMemberExpressionName(nestedMember);
    if (objectName) {
      const nodeKey = `${callNode.start}:${callNode.end}`;
      if (!s.processedNodes.methodCalls.has(nodeKey)) {
        s.processedNodes.methodCalls.add(nodeKey);

        const fullName = `${objectName}.${methodName}`;
        const methodLine = getLine(callNode);
        const methodColumn = getColumn(callNode);

        const grafemaIgnore = getGrafemaIgnore(path);

        const methodCallInfo: MethodCallInfo = {
          id: '', // Placeholder — resolved by generateV2 or set below
          type: 'CALL',
          name: fullName,
          object: objectName,
          method: methodName,
          file: s.module.file,
          line: methodLine,
          column: methodColumn,
          endLine: getEndLocation(callNode).line,
          endColumn: getEndLocation(callNode).column,
          parentScopeId,
          grafemaIgnore: grafemaIgnore ?? undefined,
        };

        if (this.sharedIdGenerator) {
          const contentHints: ContentHashHints = {
            arity: callNode.arguments.length,
            firstLiteralArg: extractFirstLiteralArg(callNode)
          };
          this.sharedIdGenerator.generateV2('CALL', fullName, s.module.file, contentHints, methodCallInfo);
        } else {
          const idGenerator = new IdGenerator(s.scopeTracker);
          methodCallInfo.id = idGenerator.generate(
            'CALL', fullName, s.module.file,
            methodLine, methodColumn,
            s.callSiteCounterRef,
            { useDiscriminator: true, discriminatorKey: `CALL:${fullName}` }
          );
        }

        s.methodCalls.push(methodCallInfo);
      }
    }
  }

}

/**
 * CallFlowBuilder - buffers call/argument flow nodes and edges.
 *
 * Handles: argument edges (PASSES_ARGUMENT), object property edges (HAS_PROPERTY).
 */

import type {
  ModuleNode,
  FunctionInfo,
  VariableDeclarationInfo,
  ParameterInfo,
  CallSiteInfo,
  MethodCallInfo,
  CallArgumentInfo,
  ImportInfo,
  ObjectPropertyInfo,
  ASTCollections,
  GraphEdge,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

/**
 * Functions/methods known to always invoke their callback argument.
 * Only create CALLS edges for these — prevents false positives
 * for store/register patterns where the function is stored, not called.
 */
const KNOWN_CALLBACK_INVOKERS = new Set([
  // Array HOFs
  'forEach', 'map', 'filter', 'find', 'findIndex',
  'some', 'every', 'reduce', 'reduceRight', 'flatMap', 'sort',
  // Timers
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
  // Promise
  'then', 'catch', 'finally',
  // DOM/Node
  'requestAnimationFrame', 'addEventListener',
]);

export class CallFlowBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      functions,
      variableDeclarations,
      callSites,
      methodCalls = [],
      callArguments = [],
      imports = [],
      objectProperties = [],
      parameters = [],
    } = data;

    this.bufferArgumentEdges(callArguments, variableDeclarations, functions, callSites, methodCalls, imports);
    this.bufferObjectPropertyEdges(objectProperties, variableDeclarations, parameters, functions);
  }

  private bufferArgumentEdges(
    callArguments: CallArgumentInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    functions: FunctionInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    imports: ImportInfo[]
  ): void {
    for (const arg of callArguments) {
      const {
        callId,
        argIndex,
        targetType,
        targetId,
        targetName,
        file,
        isSpread,
        functionLine,
        functionColumn,
        nestedCallLine,
        nestedCallColumn
      } = arg;

      let targetNodeId = targetId;

      // Find the call node for this argument (needed for callback whitelist check)
      const call = callSites.find(c => c.id === callId)
        || methodCalls.find(c => c.id === callId);

      if (targetType === 'VARIABLE' && targetName) {
        const varNode = variableDeclarations.find(v =>
          v.name === targetName && v.file === file
        );
        if (varNode) {
          targetNodeId = varNode.id;
        }

        // REG-400: If target is a function reference, create callback CALLS edge
        if (targetName && file) {
          const callScopeId = call && 'parentScopeId' in call ? (call as CallSiteInfo).parentScopeId as string : '';
          const funcNode = this.ctx.findFunctionByName(functions, targetName, file, callScopeId);
          if (funcNode) {
            if (!targetNodeId) {
              targetNodeId = funcNode.id;
            }
            // Only create CALLS edge for known callback-invoking functions
            const callName = call && 'method' in call ? (call as MethodCallInfo).method : call?.name;
            if (callName && KNOWN_CALLBACK_INVOKERS.has(callName)) {
              this.ctx.bufferEdge({
                type: 'CALLS',
                src: callId,
                dst: funcNode.id,
                metadata: { callType: 'callback' }
              });
            }
          }
        }
      }
      // REG-402: MemberExpression callbacks (this.method)
      else if (targetType === 'EXPRESSION' && arg.expressionType === 'MemberExpression') {
        const { objectName, propertyName } = arg;

        if (objectName === 'this' && propertyName && arg.enclosingClassName) {
          // Look up target method in same class (className set during analysis via ScopeTracker)
          const methodNode = functions.find(f =>
            f.isClassMethod === true &&
            f.className === arg.enclosingClassName &&
            f.name === propertyName &&
            f.file === file
          );

          if (methodNode) {
            targetNodeId = methodNode.id;

            // Create CALLS edge for known HOFs (same pattern as REG-400)
            const callName = call && 'method' in call
              ? (call as MethodCallInfo).method : call?.name;
            if (callName && KNOWN_CALLBACK_INVOKERS.has(callName)) {
              this.ctx.bufferEdge({
                type: 'CALLS',
                src: callId,
                dst: methodNode.id,
                metadata: { callType: 'callback' }
              });
            }
          }
        }
      }
      else if (targetType === 'FUNCTION' && functionLine && functionColumn) {
        const funcNode = functions.find(f =>
          f.file === file && f.line === functionLine && f.column === functionColumn
        );
        if (funcNode) {
          targetNodeId = funcNode.id;
        }
      }
      else if (targetType === 'CALL' && nestedCallLine && nestedCallColumn) {
        const nestedCall = callSites.find(c =>
          c.file === file && c.line === nestedCallLine && c.column === nestedCallColumn
        ) || methodCalls.find(c =>
          c.file === file && c.line === nestedCallLine && c.column === nestedCallColumn
        );
        if (nestedCall) {
          targetNodeId = nestedCall.id;
        }
      }
      else if (targetType === 'LITERAL' ||
               targetType === 'OBJECT_LITERAL' ||
               targetType === 'ARRAY_LITERAL') {
        // targetId is already set by CallExpressionVisitor
        targetNodeId = targetId;
      }

      // REG-400: Import fallback — resolve function reference to IMPORT node
      // When argument is a variable name matching an imported symbol, point to IMPORT node
      if (!targetNodeId && targetName) {
        for (const imp of imports) {
          const matchingSpec = imp.specifiers.find(s => s.local === targetName);
          if (matchingSpec) {
            targetNodeId = `${file}:IMPORT:${imp.source}:${matchingSpec.local}`;
            break;
          }
        }
      }

      if (targetNodeId) {
        const edgeData: GraphEdge = {
          type: 'PASSES_ARGUMENT',
          src: callId,
          dst: targetNodeId,
          metadata: { argIndex }
        };

        if (isSpread) {
          edgeData.metadata = { ...edgeData.metadata, isSpread: true };
        }

        this.ctx.bufferEdge(edgeData);
      }
    }
  }

  /**
   * Buffer HAS_PROPERTY edges connecting OBJECT_LITERAL nodes to their property values.
   * Creates edges from object literal to its property value nodes (LITERAL, nested OBJECT_LITERAL, ARRAY_LITERAL, etc.)
   *
   * REG-329: Adds scope-aware variable resolution for VARIABLE property values.
   * Uses the same resolveVariableInScope infrastructure as mutation handlers.
   */
  private bufferObjectPropertyEdges(
    objectProperties: ObjectPropertyInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[],
    functions: FunctionInfo[]
  ): void {
    for (const prop of objectProperties) {
      // REG-329: Handle VARIABLE value types with scope resolution
      if (prop.valueType === 'VARIABLE' && prop.valueName) {
        const scopePath = prop.valueScopePath ?? [];
        const file = prop.file;

        // Resolve variable using scope chain
        const resolvedVar = this.ctx.resolveVariableInScope(
          prop.valueName, scopePath, file, variableDeclarations
        );
        const resolvedParam = !resolvedVar
          ? this.ctx.resolveParameterInScope(prop.valueName, scopePath, file, parameters)
          : null;
        // REG-417: Fallback to function declarations (function foo() is a valid value reference)
        const resolvedFunc = !resolvedVar && !resolvedParam
          ? functions.find(f => f.name === prop.valueName && f.file === file)
          : null;

        const resolvedNodeId = resolvedVar?.id ?? resolvedParam?.semanticId ?? resolvedParam?.id ?? resolvedFunc?.id;

        if (resolvedNodeId) {
          this.ctx.bufferEdge({
            type: 'HAS_PROPERTY',
            src: prop.objectId,
            dst: resolvedNodeId,
            propertyName: prop.propertyName
          });
        }
        continue;
      }

      // Existing logic for non-VARIABLE types
      if (prop.valueNodeId) {
        this.ctx.bufferEdge({
          type: 'HAS_PROPERTY',
          src: prop.objectId,
          dst: prop.valueNodeId,
          propertyName: prop.propertyName
        });
      }
    }
  }
}

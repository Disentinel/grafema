/**
 * CoreBuilder - buffers core graph structure nodes and edges.
 *
 * Handles: functions, scopes, variables, call sites, method calls,
 * property accesses, callbacks, literals, object/array literals.
 */

import type {
  ModuleNode,
  FunctionInfo,
  ScopeInfo,
  VariableDeclarationInfo,
  CallSiteInfo,
  MethodCallInfo,
  MethodCallbackInfo,
  LiteralInfo,
  PropertyAccessInfo,
  ObjectLiteralInfo,
  ArrayLiteralInfo,
  ParameterInfo,
  ClassDeclarationInfo,
  ASTCollections,
  GraphNode,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

export class CoreBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      functions,
      scopes,
      variableDeclarations,
      callSites,
      methodCalls = [],
      methodCallbacks = [],
      propertyAccesses = [],
      literals = [],
      objectLiterals = [],
      arrayLiterals = [],
      parameters = [],
      classDeclarations = [],
    } = data;

    this.bufferFunctionEdges(module, functions);
    this.bufferScopeEdges(scopes, variableDeclarations);
    this.bufferVariableEdges(variableDeclarations);
    this.bufferCallSiteEdges(callSites, functions);
    this.bufferMethodCalls(methodCalls, variableDeclarations, parameters);
    this.bufferPropertyAccessNodes(module, propertyAccesses, variableDeclarations, parameters, classDeclarations);
    this.bufferCallbackEdges(methodCallbacks, functions);
    this.bufferLiterals(literals);
    this.bufferObjectLiteralNodes(objectLiterals);
    this.bufferArrayLiteralNodes(arrayLiterals);
  }

  private bufferFunctionEdges(module: ModuleNode, functions: FunctionInfo[]): void {
    for (const func of functions) {
      const { parentScopeId, ...funcData } = func;

      // MODULE -> CONTAINS -> FUNCTION (для функций верхнего уровня)
      // или SCOPE -> CONTAINS -> FUNCTION (для вложенных функций)
      if (parentScopeId) {
        this.ctx.bufferEdge({
          type: 'CONTAINS',
          src: parentScopeId,
          dst: funcData.id
        });
      } else {
        this.ctx.bufferEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: funcData.id
        });
      }
    }
  }

  private bufferScopeEdges(scopes: ScopeInfo[], variableDeclarations: VariableDeclarationInfo[]): void {
    for (const scope of scopes) {
      const { parentFunctionId, parentScopeId, capturesFrom, ...scopeData } = scope;

      // FUNCTION -> HAS_SCOPE -> SCOPE (для function_body)
      if (parentFunctionId) {
        this.ctx.bufferEdge({
          type: 'HAS_SCOPE',
          src: parentFunctionId,
          dst: scopeData.id
        });
      }

      // SCOPE -> CONTAINS -> SCOPE (для вложенных scope, типа if внутри function)
      if (parentScopeId) {
        this.ctx.bufferEdge({
          type: 'CONTAINS',
          src: parentScopeId,
          dst: scopeData.id
        });
      }

      // CAPTURES - замыкания захватывают переменные из родительского scope
      if (capturesFrom && scopeData.scopeType === 'closure') {
        const parentVars = variableDeclarations.filter(v => v.parentScopeId === capturesFrom);
        for (const parentVar of parentVars) {
          this.ctx.bufferEdge({
            type: 'CAPTURES',
            src: scopeData.id,
            dst: parentVar.id
          });
        }
      }

      // REG-288: MODIFIES edges removed - now come from UPDATE_EXPRESSION nodes
    }
  }

  private bufferVariableEdges(variableDeclarations: VariableDeclarationInfo[]): void {
    for (const varDecl of variableDeclarations) {
      const { parentScopeId, isClassProperty, ...varData } = varDecl;

      // REG-271: Skip class properties - they get HAS_PROPERTY edges from CLASS, not DECLARES from SCOPE
      if (isClassProperty) {
        continue;
      }

      // SCOPE -> DECLARES -> VARIABLE
      this.ctx.bufferEdge({
        type: 'DECLARES',
        src: parentScopeId as string,
        dst: varData.id
      });
    }
  }

  private bufferCallSiteEdges(callSites: CallSiteInfo[], functions: FunctionInfo[]): void {
    for (const callSite of callSites) {
      const { parentScopeId, targetFunctionName, ...callData } = callSite;

      // SCOPE -> CONTAINS -> CALL_SITE
      this.ctx.bufferEdge({
        type: 'CONTAINS',
        src: parentScopeId as string,
        dst: callData.id
      });

      // CALL_SITE -> CALLS -> FUNCTION (scope-aware)
      const targetFunction = this.ctx.findFunctionByName(
        functions, targetFunctionName, callData.file as string, parentScopeId as string
      );
      if (targetFunction) {
        this.ctx.bufferEdge({
          type: 'CALLS',
          src: callData.id,
          dst: targetFunction.id
        });
      }
    }
  }

  private bufferMethodCalls(
    methodCalls: MethodCallInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const methodCall of methodCalls) {
      // Keep parentScopeId on node for queries
      this.ctx.bufferNode(methodCall as unknown as GraphNode);

      // SCOPE -> CONTAINS -> METHOD_CALL
      this.ctx.bufferEdge({
        type: 'CONTAINS',
        src: methodCall.parentScopeId as string,
        dst: methodCall.id
      });

      // REG-262: Create USES edge from METHOD_CALL to receiver variable
      // Skip 'this' - it's not a variable node
      if (methodCall.object && methodCall.object !== 'this') {
        // Handle nested member expressions: obj.nested.method() -> use base 'obj'
        const receiverName = methodCall.object.includes('.')
          ? methodCall.object.split('.')[0]
          : methodCall.object;

        // Find receiver variable in current file
        const receiverVar = variableDeclarations.find(v =>
          v.name === receiverName && v.file === methodCall.file
        );

        if (receiverVar) {
          this.ctx.bufferEdge({
            type: 'USES',
            src: methodCall.id,
            dst: receiverVar.id
          });
        } else {
          // Check parameters (function arguments)
          const receiverParam = parameters.find(p =>
            p.name === receiverName && p.file === methodCall.file
          );

          if (receiverParam) {
            this.ctx.bufferEdge({
              type: 'USES',
              src: methodCall.id,
              dst: receiverParam.id
            });
          }
        }
      }
    }
  }

  /**
   * Buffer PROPERTY_ACCESS nodes, CONTAINS edges, and READS_FROM edges (REG-395, REG-555).
   *
   * Creates nodes for property reads (obj.prop, a.b.c),
   * CONTAINS edges from the enclosing scope (function or module),
   * and READS_FROM edges to the source variable, parameter, or class node.
   */
  private bufferPropertyAccessNodes(
    module: ModuleNode,
    propertyAccesses: PropertyAccessInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[],
    classDeclarations: ClassDeclarationInfo[]
  ): void {
    for (const propAccess of propertyAccesses) {
      // Buffer node with all relevant fields
      this.ctx.bufferNode({
        id: propAccess.id,
        type: 'PROPERTY_ACCESS',
        name: propAccess.propertyName,
        objectName: propAccess.objectName,
        file: propAccess.file,
        line: propAccess.line,
        column: propAccess.column,
        endLine: propAccess.endLine,
        endColumn: propAccess.endColumn,
        semanticId: propAccess.semanticId,
        optional: propAccess.optional,
        computed: propAccess.computed
      } as GraphNode);

      // SCOPE/FUNCTION/MODULE -> CONTAINS -> PROPERTY_ACCESS
      const containsSrc = propAccess.parentScopeId ?? module.id;
      this.ctx.bufferEdge({
        type: 'CONTAINS',
        src: containsSrc,
        dst: propAccess.id
      });

      // REG-555: PROPERTY_ACCESS -> READS_FROM -> source node
      const { objectName } = propAccess;
      const scopePath = propAccess.scopePath ?? [];

      if (objectName === 'this') {
        // Link to CLASS node for this.prop reads (REG-152 pattern, REG-557 fix)
        if (propAccess.enclosingClassName) {
          const classDecl = classDeclarations.find(c =>
            c.name === propAccess.enclosingClassName && c.file === propAccess.file
          );
          if (classDecl) {
            this.ctx.bufferEdge({
              type: 'READS_FROM',
              src: propAccess.id,
              dst: classDecl.id
            });
          }
        }
      } else if (objectName === 'import.meta' || objectName.includes('.')) {
        // Skip: import.meta has no variable node, chained objects (a.b) are
        // handled transitively through the first link in the chain
      } else {
        // Resolve variable or parameter using scope chain
        const variable = this.ctx.resolveVariableInScope(objectName, scopePath, propAccess.file, variableDeclarations);
        if (variable) {
          this.ctx.bufferEdge({
            type: 'READS_FROM',
            src: propAccess.id,
            dst: variable.id
          });
        } else {
          const param = this.ctx.resolveParameterInScope(objectName, scopePath, propAccess.file, parameters);
          if (param) {
            this.ctx.bufferEdge({
              type: 'READS_FROM',
              src: propAccess.id,
              dst: param.id
            });
          }
        }
      }
    }
  }

  private bufferCallbackEdges(methodCallbacks: MethodCallbackInfo[], functions: FunctionInfo[]): void {
    for (const callback of methodCallbacks) {
      const { methodCallId, callbackLine, callbackColumn } = callback;

      const callbackFunction = functions.find(f =>
        f.line === callbackLine && f.column === callbackColumn
      );

      if (callbackFunction) {
        this.ctx.bufferEdge({
          type: 'HAS_CALLBACK',
          src: methodCallId,
          dst: callbackFunction.id
        });
      }
    }
  }

  private bufferLiterals(literals: LiteralInfo[]): void {
    for (const literal of literals) {
      const { parentCallId: _parentCallId, argIndex: _argIndex, ...literalData } = literal;
      this.ctx.bufferNode(literalData as GraphNode);
    }
  }

  /**
   * Buffer OBJECT_LITERAL nodes to the graph.
   * These are object literals passed as function arguments or nested in other literals.
   */
  private bufferObjectLiteralNodes(objectLiterals: ObjectLiteralInfo[]): void {
    for (const obj of objectLiterals) {
      this.ctx.bufferNode({
        id: obj.id,
        type: obj.type,
        name: '<object>',
        file: obj.file,
        line: obj.line,
        column: obj.column,
        parentCallId: obj.parentCallId,
        argIndex: obj.argIndex
      } as GraphNode);
    }
  }

  /**
   * Buffer ARRAY_LITERAL nodes to the graph.
   * These are array literals passed as function arguments or nested in other literals.
   */
  private bufferArrayLiteralNodes(arrayLiterals: ArrayLiteralInfo[]): void {
    for (const arr of arrayLiterals) {
      this.ctx.bufferNode({
        id: arr.id,
        type: arr.type,
        name: '<array>',
        file: arr.file,
        line: arr.line,
        column: arr.column,
        parentCallId: arr.parentCallId,
        argIndex: arr.argIndex
      } as GraphNode);
    }
  }
}

/**
 * ReturnBuilder - buffers RETURNS edges connecting return expressions to their containing functions.
 *
 * Extracted from GraphBuilder.bufferReturnEdges (REG-422).
 */

import { NodeFactory } from '../../../../core/NodeFactory.js';
import type {
  ModuleNode,
  ASTCollections,
  ReturnStatementInfo,
  CallSiteInfo,
  MethodCallInfo,
  VariableDeclarationInfo,
  ParameterInfo,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

export class ReturnBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      returnStatements = [],
      callSites = [],
      methodCalls = [],
      variableDeclarations = [],
      parameters = [],
    } = data;
    this.bufferReturnEdges(returnStatements, callSites, methodCalls, variableDeclarations, parameters);
  }

  /**
   * Buffer RETURNS edges connecting functions to their return expressions.
   *
   * Edge direction: function --RETURNS--> returnExpression
   *
   * This enables tracing data flow through function calls:
   * - Query: "What does formatDate return?"
   * - Answer: Follow outgoing RETURNS edges from function to see all possible return values
   */
  private bufferReturnEdges(
    returnStatements: ReturnStatementInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const ret of returnStatements) {
      const { parentFunctionId, returnValueType, file } = ret;

      // Skip if no value returned (bare return;)
      if (returnValueType === 'NONE') {
        continue;
      }

      let sourceNodeId: string | null = null;

      switch (returnValueType) {
        case 'LITERAL':
          // Direct reference to literal node
          sourceNodeId = ret.returnValueId ?? null;
          break;

        case 'VARIABLE': {
          // Find variable declaration by name in same file
          const varName = ret.returnValueName;
          if (varName) {
            const sourceVar = variableDeclarations.find(v =>
              v.name === varName && v.file === file
            );
            if (sourceVar) {
              sourceNodeId = sourceVar.id;
            } else {
              // Check parameters
              const sourceParam = parameters.find(p =>
                p.name === varName && p.file === file
              );
              if (sourceParam) {
                sourceNodeId = sourceParam.id;
              }
            }
          }
          break;
        }

        case 'CALL_SITE': {
          // Find call site by coordinates
          const { returnValueLine, returnValueColumn, returnValueCallName } = ret;
          if (returnValueLine && returnValueColumn) {
            const callSite = callSites.find(cs =>
              cs.line === returnValueLine &&
              cs.column === returnValueColumn &&
              (returnValueCallName ? cs.name === returnValueCallName : true)
            );
            if (callSite) {
              sourceNodeId = callSite.id;
            }
          }
          break;
        }

        case 'METHOD_CALL': {
          // Find method call by coordinates and method name
          const { returnValueLine, returnValueColumn, returnValueCallName } = ret;
          if (returnValueLine && returnValueColumn) {
            const methodCall = methodCalls.find(mc =>
              mc.line === returnValueLine &&
              mc.column === returnValueColumn &&
              mc.file === file &&
              (returnValueCallName ? mc.method === returnValueCallName : true)
            );
            if (methodCall) {
              sourceNodeId = methodCall.id;
            }
          }
          break;
        }

        case 'EXPRESSION': {
          // REG-276: Create EXPRESSION node and DERIVES_FROM edges for return expressions
          const {
            expressionType,
            returnValueId,
            returnValueLine,
            returnValueColumn,
            operator,
            object,
            property,
            computed,
            objectSourceName,
            leftSourceName,
            rightSourceName,
            consequentSourceName,
            alternateSourceName,
            expressionSourceNames,
            unaryArgSourceName
          } = ret;

          // Skip if no expression ID was generated
          if (!returnValueId) {
            break;
          }

          // Create EXPRESSION node using NodeFactory
          const expressionNode = NodeFactory.createExpressionFromMetadata(
            expressionType || 'Unknown',
            file,
            returnValueLine || ret.line,
            returnValueColumn || ret.column,
            {
              id: returnValueId,
              object,
              property,
              computed,
              operator
            }
          );

          this.ctx.bufferNode(expressionNode);
          sourceNodeId = returnValueId;

          // Buffer DERIVES_FROM edges based on expression type
          // Helper function to find source variable or parameter
          const findSource = (name: string): string | null => {
            const variable = variableDeclarations.find(v =>
              v.name === name && v.file === file
            );
            if (variable) return variable.id;

            const param = parameters.find(p =>
              p.name === name && p.file === file
            );
            if (param) return param.id;

            return null;
          };

          // MemberExpression: derives from the object
          if (expressionType === 'MemberExpression' && objectSourceName) {
            const sourceId = findSource(objectSourceName);
            if (sourceId) {
              this.ctx.bufferEdge({
                type: 'DERIVES_FROM',
                src: returnValueId,
                dst: sourceId
              });
            }
          }

          // BinaryExpression / LogicalExpression: derives from left and right operands
          if (expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression') {
            if (leftSourceName) {
              const sourceId = findSource(leftSourceName);
              if (sourceId) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: returnValueId,
                  dst: sourceId
                });
              }
            }
            if (rightSourceName) {
              const sourceId = findSource(rightSourceName);
              if (sourceId) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: returnValueId,
                  dst: sourceId
                });
              }
            }
          }

          // ConditionalExpression: derives from consequent and alternate
          if (expressionType === 'ConditionalExpression') {
            if (consequentSourceName) {
              const sourceId = findSource(consequentSourceName);
              if (sourceId) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: returnValueId,
                  dst: sourceId
                });
              }
            }
            if (alternateSourceName) {
              const sourceId = findSource(alternateSourceName);
              if (sourceId) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: returnValueId,
                  dst: sourceId
                });
              }
            }
          }

          // UnaryExpression: derives from the argument
          if (expressionType === 'UnaryExpression' && unaryArgSourceName) {
            const sourceId = findSource(unaryArgSourceName);
            if (sourceId) {
              this.ctx.bufferEdge({
                type: 'DERIVES_FROM',
                src: returnValueId,
                dst: sourceId
              });
            }
          }

          // TemplateLiteral: derives from all embedded expressions
          if (expressionType === 'TemplateLiteral' && expressionSourceNames && expressionSourceNames.length > 0) {
            for (const sourceName of expressionSourceNames) {
              const sourceId = findSource(sourceName);
              if (sourceId) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: returnValueId,
                  dst: sourceId
                });
              }
            }
          }

          break;
        }
      }

      // Create RETURNS edge: function → return value
      if (sourceNodeId && parentFunctionId) {
        this.ctx.bufferEdge({
          type: 'RETURNS',
          src: parentFunctionId,
          dst: sourceNodeId
        });
      }
    }
  }
}

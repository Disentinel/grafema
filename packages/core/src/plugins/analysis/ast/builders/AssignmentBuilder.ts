/**
 * AssignmentBuilder - buffers ASSIGNED_FROM and DERIVES_FROM edges
 * for variable assignment data flow.
 *
 * Extracted from GraphBuilder.bufferAssignmentEdges.
 */

import { NodeFactory } from '../../../../core/NodeFactory.js';
import type {
  ModuleNode,
  VariableAssignmentInfo,
  VariableDeclarationInfo,
  CallSiteInfo,
  MethodCallInfo,
  FunctionInfo,
  ClassInstantiationInfo,
  ParameterInfo,
  ASTCollections,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

export class AssignmentBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      variableAssignments = [],
      variableDeclarations,
      callSites,
      methodCalls = [],
      functions,
      classInstantiations = [],
      parameters = [],
    } = data;

    this.bufferAssignmentEdges(
      variableAssignments,
      variableDeclarations,
      callSites,
      methodCalls,
      functions,
      classInstantiations,
      parameters
    );
  }

  private bufferAssignmentEdges(
    variableAssignments: VariableAssignmentInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    functions: FunctionInfo[],
    classInstantiations: ClassInstantiationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const assignment of variableAssignments) {
      const {
        variableId,
        sourceId,
        sourceType,
        sourceName,
        sourceLine,
        sourceColumn,
        sourceFile,
        functionName,
        line,
        column,
        className
      } = assignment;

      // Skip CLASS sourceType - handled async in createClassAssignmentEdges
      if (sourceType === 'CLASS') {
        continue;
      }

      // CONSTRUCTOR_CALL: create ASSIGNED_FROM edge to existing node
      // Note: CONSTRUCTOR_CALL nodes are already created from constructorCalls collection in step 4.5
      if (sourceType === 'CONSTRUCTOR_CALL' && className) {
        const constructorLine = line ?? 0;
        const constructorColumn = column ?? 0;
        const constructorFile = assignment.file ?? '';

        // Generate ID matching the one created in NewExpression visitor
        const constructorCallId = NodeFactory.generateConstructorCallId(
          className,
          constructorFile,
          constructorLine,
          constructorColumn
        );

        this.ctx.bufferEdge({
          type: 'ASSIGNED_FROM',
          src: variableId,
          dst: constructorCallId
        });
        continue;
      }

      // Direct LITERAL assignment
      if (sourceId && sourceType !== 'EXPRESSION') {
        this.ctx.bufferEdge({
          type: 'ASSIGNED_FROM',
          src: variableId,
          dst: sourceId
        });
      }
      // METHOD_CALL by coordinates
      else if (sourceType === 'METHOD_CALL' && sourceLine && sourceColumn) {
        const methodCall = methodCalls.find(mc =>
          mc.line === sourceLine &&
          mc.column === sourceColumn &&
          mc.file === sourceFile
        );

        if (methodCall) {
          this.ctx.bufferEdge({
            type: 'ASSIGNED_FROM',
            src: variableId,
            dst: methodCall.id
          });
        }
      }
      // CALL_SITE by coordinates
      else if (sourceType === 'CALL_SITE') {
        const searchLine = sourceLine || assignment.callLine;
        const searchColumn = sourceColumn || assignment.callColumn;
        const searchName = assignment.callName;

        if (searchLine && searchColumn) {
          const callSite = callSites.find(cs =>
            cs.line === searchLine &&
            cs.column === searchColumn &&
            (searchName ? cs.name === searchName : true)
          );

          if (callSite) {
            this.ctx.bufferEdge({
              type: 'ASSIGNED_FROM',
              src: variableId,
              dst: callSite.id
            });
          }
        }
      }
      // VARIABLE by name
      else if (sourceType === 'VARIABLE' && sourceName) {
        // Find the current variable's file by looking it up in variableDeclarations
        // (semantic IDs don't have predictable file positions like old hash-based IDs)
        const currentVar = variableDeclarations.find(v => v.id === variableId);
        const varFile = currentVar?.file ?? null;
        const sourceVariable = variableDeclarations.find(v =>
          v.name === sourceName && v.file === varFile
        );

        if (sourceVariable) {
          this.ctx.bufferEdge({
            type: 'ASSIGNED_FROM',
            src: variableId,
            dst: sourceVariable.id
          });
        } else {
          const sourceParam = parameters.find(p =>
            p.name === sourceName && p.file === varFile
          );

          if (sourceParam) {
            this.ctx.bufferEdge({
              type: 'DERIVES_FROM',
              src: variableId,
              dst: sourceParam.id
            });
          }
        }
      }
      // FUNCTION (arrow function assigned to variable)
      else if (sourceType === 'FUNCTION' && functionName && line) {
        const sourceFunction = functions.find(f =>
          f.name === functionName && f.line === line
        );

        if (sourceFunction) {
          this.ctx.bufferEdge({
            type: 'ASSIGNED_FROM',
            src: variableId,
            dst: sourceFunction.id
          });
        }
      }
      // EXPRESSION node creation using NodeFactory
      else if (sourceType === 'EXPRESSION' && sourceId) {
        const {
          expressionType,
          object,
          property,
          computed,
          computedPropertyVar,
          operator,
          objectSourceName,
          leftSourceName,
          rightSourceName,
          consequentSourceName,
          alternateSourceName,
          file: exprFile,
          line: exprLine,
          column: exprColumn,
          // Destructuring support (REG-201)
          path,
          baseName,
          propertyPath,
          arrayIndex
        } = assignment;

        // Create node from upstream metadata using factory
        const expressionNode = NodeFactory.createExpressionFromMetadata(
          expressionType || 'Unknown',
          exprFile || '',
          exprLine || 0,
          exprColumn || 0,
          {
            id: sourceId,  // ID from JSASTAnalyzer
            object,
            property,
            computed,
            computedPropertyVar: computedPropertyVar ?? undefined,
            operator,
            leftSourceName: leftSourceName ?? undefined,
            rightSourceName: rightSourceName ?? undefined,
            // Destructuring support (REG-201)
            path,
            baseName,
            propertyPath,
            arrayIndex
          }
        );

        this.ctx.bufferNode(expressionNode);

        this.ctx.bufferEdge({
          type: 'ASSIGNED_FROM',
          src: variableId,
          dst: sourceId
        });

        // Buffer DERIVES_FROM edges
        const varParts = variableId.split('#');
        const varFile = varParts.length >= 3 ? varParts[2] : null;

        if (expressionType === 'MemberExpression' && objectSourceName) {
          const objectVar = variableDeclarations.find(v =>
            v.name === objectSourceName && (!varFile || v.file === varFile)
          );
          if (objectVar) {
            this.ctx.bufferEdge({
              type: 'DERIVES_FROM',
              src: sourceId,
              dst: objectVar.id
            });
          }
        }
        // Call-based source lookup (REG-223)
        else if (expressionType === 'MemberExpression' && assignment.callSourceLine !== undefined) {
          const { callSourceLine, callSourceColumn, callSourceName, callSourceFile } = assignment;

          // Try CALL_SITE first (direct function calls)
          const callSite = callSites.find(cs =>
            cs.line === callSourceLine &&
            cs.column === callSourceColumn &&
            (callSourceName ? cs.name === callSourceName : true)
          );

          if (callSite) {
            this.ctx.bufferEdge({
              type: 'DERIVES_FROM',
              src: sourceId,
              dst: callSite.id
            });
          }
          // Fall back to methodCalls (arr.map(), obj.getConfig())
          else {
            const methodCall = methodCalls.find(mc =>
              mc.line === callSourceLine &&
              mc.column === callSourceColumn &&
              (callSourceName ? mc.name === callSourceName : true)
            );

            if (methodCall) {
              this.ctx.bufferEdge({
                type: 'DERIVES_FROM',
                src: sourceId,
                dst: methodCall.id
              });
            }
            // Log warning when lookup fails (per Linus review - no silent failures)
            else {
              console.warn(
                `[REG-223] DERIVES_FROM lookup failed for EXPRESSION(${assignment.object}.${assignment.property}) ` +
                `at ${callSourceFile}:${callSourceLine}:${callSourceColumn}. ` +
                `Expected CALL_SITE or methodCall for "${callSourceName}". ` +
                `This indicates a coordinate mismatch or missing call node.`
              );
            }
          }
        }

        if ((expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression')) {
          if (leftSourceName) {
            const leftVar = variableDeclarations.find(v =>
              v.name === leftSourceName && (!varFile || v.file === varFile)
            );
            if (leftVar) {
              this.ctx.bufferEdge({
                type: 'DERIVES_FROM',
                src: sourceId,
                dst: leftVar.id
              });
            }
          }
          if (rightSourceName) {
            const rightVar = variableDeclarations.find(v =>
              v.name === rightSourceName && (!varFile || v.file === varFile)
            );
            if (rightVar) {
              this.ctx.bufferEdge({
                type: 'DERIVES_FROM',
                src: sourceId,
                dst: rightVar.id
              });
            }
          }
        }

        if (expressionType === 'ConditionalExpression') {
          if (consequentSourceName) {
            const consequentVar = variableDeclarations.find(v =>
              v.name === consequentSourceName && (!varFile || v.file === varFile)
            );
            if (consequentVar) {
              this.ctx.bufferEdge({
                type: 'DERIVES_FROM',
                src: sourceId,
                dst: consequentVar.id
              });
            }
          }
          if (alternateSourceName) {
            const alternateVar = variableDeclarations.find(v =>
              v.name === alternateSourceName && (!varFile || v.file === varFile)
            );
            if (alternateVar) {
              this.ctx.bufferEdge({
                type: 'DERIVES_FROM',
                src: sourceId,
                dst: alternateVar.id
              });
            }
          }
        }

        if (expressionType === 'TemplateLiteral') {
          const { expressionSourceNames } = assignment;
          if (expressionSourceNames && expressionSourceNames.length > 0) {
            for (const exprSourceName of expressionSourceNames) {
              const sourceVar = variableDeclarations.find(v =>
                v.name === exprSourceName && (!varFile || v.file === varFile)
              );
              if (sourceVar) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: sourceId,
                  dst: sourceVar.id
                });
              }
            }
          }
        }

        // REG-534: UnaryExpression DERIVES_FROM — link to the argument variable
        if (expressionType === 'UnaryExpression') {
          const { unaryArgSourceName } = assignment;
          if (unaryArgSourceName) {
            const argVar = variableDeclarations.find(v =>
              v.name === unaryArgSourceName && (!varFile || v.file === varFile)
            );
            if (argVar) {
              this.ctx.bufferEdge({
                type: 'DERIVES_FROM',
                src: sourceId,
                dst: argVar.id
              });
            } else {
              // Check parameters
              const argParam = parameters.find(p =>
                p.name === unaryArgSourceName && (!varFile || p.file === varFile)
              );
              if (argParam) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: sourceId,
                  dst: argParam.id
                });
              }
            }
          }
        }
      }
      // DERIVES_FROM_VARIABLE
      else if (sourceType === 'DERIVES_FROM_VARIABLE' && sourceName) {
        const expressionId = variableId;
        const exprParts = expressionId.split('#');
        const exprFile = exprParts.length >= 3 ? exprParts[2] : assignment.file;

        const sourceVariable = variableDeclarations.find(v =>
          v.name === sourceName && v.file === exprFile
        );

        if (sourceVariable) {
          this.ctx.bufferEdge({
            type: 'DERIVES_FROM',
            src: expressionId,
            dst: sourceVariable.id
          });
        } else {
          const sourceParam = parameters.find(p =>
            p.name === sourceName && p.file === exprFile
          );

          if (sourceParam) {
            this.ctx.bufferEdge({
              type: 'DERIVES_FROM',
              src: expressionId,
              dst: sourceParam.id
            });
          }
        }
      }
    }
  }
}

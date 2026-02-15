/**
 * UpdateExpressionBuilder - buffers UPDATE_EXPRESSION nodes and edges.
 *
 * Handles: increment/decrement operations for identifiers and member expressions.
 */

import { basename } from 'path';
import type {
  ModuleNode,
  VariableDeclarationInfo,
  ParameterInfo,
  ClassDeclarationInfo,
  UpdateExpressionInfo,
  ASTCollections,
  GraphNode,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

export class UpdateExpressionBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      variableDeclarations,
      updateExpressions = [],
      parameters = [],
      classDeclarations = [],
    } = data;

    this.bufferUpdateExpressionEdges(updateExpressions, variableDeclarations, parameters, classDeclarations);
  }

  /**
   * Buffer UPDATE_EXPRESSION nodes and edges for increment/decrement operations.
   *
   * Handles two target types:
   * - IDENTIFIER: Simple variable (i++, --count)
   * - MEMBER_EXPRESSION: Object property (obj.prop++, arr[i]++, this.count++)
   *
   * Creates:
   * - UPDATE_EXPRESSION node with operator and target metadata
   * - MODIFIES edge: UPDATE_EXPRESSION -> target (VARIABLE, PARAMETER, or CLASS)
   * - READS_FROM self-loop: target -> target (reads current value before update)
   * - CONTAINS edge: SCOPE -> UPDATE_EXPRESSION
   *
   * REG-288: Initial implementation for IDENTIFIER targets
   * REG-312: Extended for MEMBER_EXPRESSION targets
   */
  private bufferUpdateExpressionEdges(
    updateExpressions: UpdateExpressionInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[],
    classDeclarations: ClassDeclarationInfo[]
  ): void {
    // Build lookup caches: O(n) instead of O(n*m)
    const varLookup = new Map<string, VariableDeclarationInfo>();
    for (const v of variableDeclarations) {
      varLookup.set(`${v.file}:${v.name}`, v);
    }

    const paramLookup = new Map<string, ParameterInfo>();
    for (const p of parameters) {
      paramLookup.set(`${p.file}:${p.name}`, p);
    }

    for (const update of updateExpressions) {
      if (update.targetType === 'IDENTIFIER') {
        // REG-288: Simple identifier (i++, --count)
        this.bufferIdentifierUpdate(update, varLookup, paramLookup);
      } else if (update.targetType === 'MEMBER_EXPRESSION') {
        // REG-312: Member expression (obj.prop++, arr[i]++)
        this.bufferMemberExpressionUpdate(update, varLookup, paramLookup, classDeclarations);
      }
    }
  }

  /**
   * Buffer UPDATE_EXPRESSION node and edges for simple identifier updates (i++, --count)
   * REG-288: Original implementation extracted for clarity
   */
  private bufferIdentifierUpdate(
    update: UpdateExpressionInfo,
    varLookup: Map<string, VariableDeclarationInfo>,
    paramLookup: Map<string, ParameterInfo>
  ): void {
    const {
      variableName,
      operator,
      prefix,
      file,
      line,
      column,
      parentScopeId
    } = update;

    if (!variableName) return;

    // Find target variable node
    const targetVar = varLookup.get(`${file}:${variableName}`);
    const targetParam = !targetVar ? paramLookup.get(`${file}:${variableName}`) : null;
    const targetNodeId = targetVar?.id ?? targetParam?.id;

    if (!targetNodeId) {
      // Variable not found - could be module-level or external reference
      return;
    }

    // Create UPDATE_EXPRESSION node
    const updateId = `${file}:UPDATE_EXPRESSION:${operator}:${line}:${column}`;

    this.ctx.bufferNode({
      type: 'UPDATE_EXPRESSION',
      id: updateId,
      name: `${prefix ? operator : ''}${variableName}${prefix ? '' : operator}`,
      targetType: 'IDENTIFIER',
      operator,
      prefix,
      variableName,
      file,
      line,
      column
    } as GraphNode);

    // Create READS_FROM self-loop
    this.ctx.bufferEdge({
      type: 'READS_FROM',
      src: targetNodeId,
      dst: targetNodeId
    });

    // Create MODIFIES edge
    this.ctx.bufferEdge({
      type: 'MODIFIES',
      src: updateId,
      dst: targetNodeId
    });

    // Create CONTAINS edge
    if (parentScopeId) {
      this.ctx.bufferEdge({
        type: 'CONTAINS',
        src: parentScopeId,
        dst: updateId
      });
    }
  }

  /**
   * Buffer UPDATE_EXPRESSION node and edges for member expression updates (obj.prop++, arr[i]++)
   * REG-312: New implementation for member expression targets
   *
   * Creates:
   * - UPDATE_EXPRESSION node with member expression metadata
   * - MODIFIES edge: UPDATE_EXPRESSION -> VARIABLE(object) or CLASS (for this.prop++)
   * - READS_FROM self-loop: VARIABLE(object) -> VARIABLE(object)
   * - CONTAINS edge: SCOPE -> UPDATE_EXPRESSION
   */
  private bufferMemberExpressionUpdate(
    update: UpdateExpressionInfo,
    varLookup: Map<string, VariableDeclarationInfo>,
    paramLookup: Map<string, ParameterInfo>,
    classDeclarations: ClassDeclarationInfo[]
  ): void {
    const {
      objectName,
      propertyName,
      mutationType,
      computedPropertyVar,
      enclosingClassName,
      operator,
      prefix,
      file,
      line,
      column,
      parentScopeId
    } = update;

    if (!objectName || !propertyName) return;

    // Find target object node
    let objectNodeId: string | null = null;

    if (objectName !== 'this') {
      // Regular object: obj.prop++, arr[i]++
      const targetVar = varLookup.get(`${file}:${objectName}`);
      const targetParam = !targetVar ? paramLookup.get(`${file}:${objectName}`) : null;
      objectNodeId = targetVar?.id ?? targetParam?.id ?? null;
    } else {
      // this.prop++ - follow REG-152 pattern from bufferObjectMutationEdges
      if (!enclosingClassName) return;

      const fileBasename = basename(file);
      const classDecl = classDeclarations.find(c =>
        c.name === enclosingClassName && c.file === fileBasename
      );
      objectNodeId = classDecl?.id ?? null;
    }

    if (!objectNodeId) {
      // Object not found - external reference or scope issue
      return;
    }

    // Create UPDATE_EXPRESSION node
    const updateId = `${file}:UPDATE_EXPRESSION:${operator}:${line}:${column}`;

    // Display name: "obj.prop++" or "this.count++" or "arr[i]++"
    const displayName = (() => {
      const opStr = prefix ? operator : '';
      const postOpStr = prefix ? '' : operator;

      if (objectName === 'this') {
        return `${opStr}this.${propertyName}${postOpStr}`;
      }
      if (mutationType === 'computed') {
        const computedPart = computedPropertyVar || '?';
        return `${opStr}${objectName}[${computedPart}]${postOpStr}`;
      }
      return `${opStr}${objectName}.${propertyName}${postOpStr}`;
    })();

    this.ctx.bufferNode({
      type: 'UPDATE_EXPRESSION',
      id: updateId,
      name: displayName,
      targetType: 'MEMBER_EXPRESSION',
      operator,
      prefix,
      objectName,
      propertyName,
      mutationType,
      computedPropertyVar,
      enclosingClassName,
      file,
      line,
      column
    } as GraphNode);

    // Create READS_FROM self-loop (object reads from itself)
    this.ctx.bufferEdge({
      type: 'READS_FROM',
      src: objectNodeId,
      dst: objectNodeId
    });

    // Create MODIFIES edge (UPDATE_EXPRESSION modifies object)
    this.ctx.bufferEdge({
      type: 'MODIFIES',
      src: updateId,
      dst: objectNodeId
    });

    // Create CONTAINS edge
    if (parentScopeId) {
      this.ctx.bufferEdge({
        type: 'CONTAINS',
        src: parentScopeId,
        dst: updateId
      });
    }
  }
}

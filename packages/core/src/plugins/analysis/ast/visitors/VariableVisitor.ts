/**
 * VariableVisitor - handles module-level variable declarations
 *
 * Handles:
 * - VariableDeclaration (const, let, var at module level)
 * - NewExpression tracking for class instantiation
 * - Destructuring patterns
 */

import type {
  VariableDeclaration,
  VariableDeclarator,
  NewExpression,
  Identifier,
  Node
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers, type CounterRef } from './ASTVisitor.js';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';

/**
 * Variable info extracted from pattern
 */
export interface VariableInfo {
  name: string;
  loc: { start: { line: number; column: number } };
  propertyPath?: string[];
  arrayIndex?: number;
}

/**
 * Callback type for extracting variable names from patterns
 */
export type ExtractVariableNamesCallback = (pattern: Node) => VariableInfo[];

/**
 * Callback type for tracking variable assignments
 */
export type TrackVariableAssignmentCallback = (
  initNode: Node,
  variableId: string,
  variableName: string,
  module: VisitorModule,
  line: number,
  literals: unknown[],
  variableAssignments: unknown[],
  literalCounterRef: CounterRef
) => void;

/**
 * Variable declaration info
 */
interface VariableDeclarationInfo {
  id: string;
  type: 'VARIABLE' | 'CONSTANT';
  name: string;
  file: string;
  line: number;
  parentScopeId: string;
  value?: unknown;
}

/**
 * Class instantiation info
 */
interface ClassInstantiationInfo {
  variableId: string;
  variableName: string;
  className: string;
  line: number;
  parentScopeId: string;
}

/**
 * Literal/expression info for data flow
 */
interface LiteralExpressionInfo {
  id: string;
  type: 'EXPRESSION';
  expressionType: string;
  path: string;
  baseName: string;
  propertyPath: string[] | null;
  arrayIndex?: number;
  file: string;
  line: number;
}

/**
 * Variable assignment info for data flow
 */
interface VariableAssignmentInfo {
  variableId: string;
  sourceId: string | null;
  sourceName?: string;
  sourceType: string;
  file?: string;
}

export class VariableVisitor extends ASTVisitor {
  private extractVariableNamesFromPattern: ExtractVariableNamesCallback;
  private trackVariableAssignment: TrackVariableAssignmentCallback;

  /**
   * @param module - Current module being analyzed
   * @param collections - Must contain arrays and counter refs
   * @param extractVariableNamesFromPattern - Helper for destructuring
   * @param trackVariableAssignment - Helper for data flow tracking
   */
  constructor(
    module: VisitorModule,
    collections: VisitorCollections,
    extractVariableNamesFromPattern: ExtractVariableNamesCallback,
    trackVariableAssignment: TrackVariableAssignmentCallback
  ) {
    super(module, collections);
    this.extractVariableNamesFromPattern = extractVariableNamesFromPattern;
    this.trackVariableAssignment = trackVariableAssignment;
  }

  getHandlers(): VisitorHandlers {
    const { module } = this;
    const variableDeclarations = this.collections.variableDeclarations ?? [];
    const classInstantiations = this.collections.classInstantiations ?? [];
    const literals = (this.collections.literals ?? []) as unknown[];
    const variableAssignments = this.collections.variableAssignments ?? [];
    const varDeclCounterRef = (this.collections.varDeclCounterRef ?? { value: 0 }) as CounterRef;
    const literalCounterRef = (this.collections.literalCounterRef ?? { value: 0 }) as CounterRef;

    const extractVariableNamesFromPattern = this.extractVariableNamesFromPattern;
    const trackVariableAssignment = this.trackVariableAssignment;

    return {
      VariableDeclaration: (path: NodePath) => {
        // Only module-level variables
        const functionParent = path.getFunctionParent();
        if (!functionParent) {
          const varNode = path.node as VariableDeclaration;
          const isConst = varNode.kind === 'const';

          varNode.declarations.forEach((declarator: VariableDeclarator) => {
            // Extract all variable names from the pattern (handles destructuring)
            const variables = extractVariableNamesFromPattern(declarator.id);

            variables.forEach((varInfo: VariableInfo) => {
              const literalValue = ExpressionEvaluator.extractLiteralValue(declarator.init);
              const isLiteral = literalValue !== null;
              const isNewExpression = declarator.init && declarator.init.type === 'NewExpression';

              // For const with literal or NewExpression create CONSTANT
              // For everything else - VARIABLE
              const shouldBeConstant = isConst && (isLiteral || isNewExpression);

              const varId = shouldBeConstant
                ? `CONSTANT#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${(varDeclCounterRef as CounterRef).value++}`
                : `VARIABLE#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${(varDeclCounterRef as CounterRef).value++}`;

              if (shouldBeConstant) {
                // CONSTANT node
                const constantData: VariableDeclarationInfo = {
                  id: varId,
                  type: 'CONSTANT',
                  name: varInfo.name,
                  file: module.file,
                  line: varInfo.loc.start.line,
                  parentScopeId: module.id
                };

                if (isLiteral) {
                  constantData.value = literalValue;
                }

                (variableDeclarations as VariableDeclarationInfo[]).push(constantData);

                // If NewExpression, track for CLASS and INSTANCE_OF
                if (isNewExpression) {
                  const newExpr = declarator.init as NewExpression;
                  if (newExpr.callee.type === 'Identifier') {
                    const className = (newExpr.callee as Identifier).name;
                    (classInstantiations as ClassInstantiationInfo[]).push({
                      variableId: varId,
                      variableName: varInfo.name,
                      className: className,
                      line: varInfo.loc.start.line,
                      parentScopeId: module.id
                    });
                  }
                }
              } else {
                (variableDeclarations as VariableDeclarationInfo[]).push({
                  id: varId,
                  type: 'VARIABLE',
                  name: varInfo.name,
                  file: module.file,
                  line: varInfo.loc.start.line,
                  parentScopeId: module.id
                });
              }

              // Track assignment for data flow analysis
              if (declarator.init) {
                // Handle destructuring - create EXPRESSION for property path
                if (varInfo.propertyPath || varInfo.arrayIndex !== undefined) {
                  // Create EXPRESSION node for the property access
                  const initName = declarator.init.type === 'Identifier'
                    ? (declarator.init as Identifier).name
                    : 'expr';
                  let expressionPath = initName;

                  if (varInfo.propertyPath) {
                    expressionPath = `${initName}.${varInfo.propertyPath.join('.')}`;
                  } else if (varInfo.arrayIndex !== undefined) {
                    expressionPath = `${initName}[${varInfo.arrayIndex}]`;
                  }

                  const expressionId = `EXPRESSION#${expressionPath}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}`;

                  // Create EXPRESSION node representing the property access
                  (literals as LiteralExpressionInfo[]).push({
                    id: expressionId,
                    type: 'EXPRESSION',
                    expressionType: varInfo.propertyPath ? 'MemberExpression' : 'ArrayAccess',
                    path: expressionPath,
                    baseName: initName,
                    propertyPath: varInfo.propertyPath || null,
                    arrayIndex: varInfo.arrayIndex,
                    file: module.file,
                    line: varInfo.loc.start.line
                  });

                  // Create ASSIGNED_FROM edge: VARIABLE -> EXPRESSION
                  (variableAssignments as VariableAssignmentInfo[]).push({
                    variableId: varId,
                    sourceId: expressionId,
                    sourceType: 'EXPRESSION'
                  });

                  // Also create DERIVES_FROM edge: EXPRESSION -> base variable (if identifier)
                  if (declarator.init.type === 'Identifier') {
                    (variableAssignments as VariableAssignmentInfo[]).push({
                      variableId: expressionId,
                      sourceId: null, // Will be resolved by name
                      sourceName: (declarator.init as Identifier).name,
                      sourceType: 'DERIVES_FROM_VARIABLE',
                      file: module.file
                    });
                  }
                } else {
                  // Normal assignment tracking
                  trackVariableAssignment(
                    declarator.init,
                    varId,
                    varInfo.name,
                    module,
                    varInfo.loc.start.line,
                    literals,
                    variableAssignments,
                    literalCounterRef as CounterRef
                  );
                }
              }
            });
          });
        }
      }
    };
  }
}

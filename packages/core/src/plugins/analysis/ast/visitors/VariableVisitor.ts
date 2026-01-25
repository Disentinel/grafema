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
import { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { IdGenerator } from '../IdGenerator.js';
import { NodeFactory } from '../../../../core/NodeFactory.js';

/**
 * Variable info extracted from pattern
 */
export interface VariableInfo {
  name: string;
  loc: { start: { line: number; column: number } };
  propertyPath?: string[];
  arrayIndex?: number;
  isRest?: boolean;
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

/**
 * Call info extracted from CallExpression (REG-223)
 */
interface CallInfo {
  line: number;
  column: number;
  name: string;
  isMethodCall: boolean;
}

export class VariableVisitor extends ASTVisitor {
  private extractVariableNamesFromPattern: ExtractVariableNamesCallback;
  private trackVariableAssignment: TrackVariableAssignmentCallback;
  private scopeTracker?: ScopeTracker;

  /**
   * Recursively unwrap AwaitExpression to get the underlying expression.
   * await await fetch() -> fetch() (REG-223)
   */
  private unwrapAwaitExpression(node: Node): Node {
    if (node.type === 'AwaitExpression' && (node as { argument?: Node }).argument) {
      return this.unwrapAwaitExpression((node as { argument: Node }).argument);
    }
    return node;
  }

  /**
   * Check if expression is CallExpression or AwaitExpression wrapping a call. (REG-223)
   */
  private isCallOrAwaitExpression(node: Node): boolean {
    const unwrapped = this.unwrapAwaitExpression(node);
    return unwrapped.type === 'CallExpression';
  }

  /**
   * Extract call site information from CallExpression. (REG-223)
   * Returns null if not a valid CallExpression.
   */
  private extractCallInfo(node: Node): CallInfo | null {
    if (node.type !== 'CallExpression') {
      return null;
    }

    const callExpr = node as { callee: Node; loc?: { start: { line: number; column: number } } };
    const callee = callExpr.callee;
    let name: string;
    let isMethodCall = false;

    // Direct call: fetchUser()
    if (callee.type === 'Identifier') {
      name = (callee as Identifier).name;
    }
    // Method call: obj.fetchUser() or arr.map()
    else if (callee.type === 'MemberExpression') {
      isMethodCall = true;
      const memberExpr = callee as { object: Node; property: Node };
      const objectName = memberExpr.object.type === 'Identifier'
        ? (memberExpr.object as Identifier).name
        : (memberExpr.object.type === 'ThisExpression' ? 'this' : 'unknown');
      const methodName = memberExpr.property.type === 'Identifier'
        ? (memberExpr.property as Identifier).name
        : 'unknown';
      name = `${objectName}.${methodName}`;
    }
    else {
      return null;
    }

    return {
      line: callExpr.loc?.start.line ?? 0,
      column: callExpr.loc?.start.column ?? 0,
      name,
      isMethodCall
    };
  }

  /**
   * @param module - Current module being analyzed
   * @param collections - Must contain arrays and counter refs
   * @param extractVariableNamesFromPattern - Helper for destructuring
   * @param trackVariableAssignment - Helper for data flow tracking
   * @param scopeTracker - Optional ScopeTracker for semantic ID generation
   */
  constructor(
    module: VisitorModule,
    collections: VisitorCollections,
    extractVariableNamesFromPattern: ExtractVariableNamesCallback,
    trackVariableAssignment: TrackVariableAssignmentCallback,
    scopeTracker?: ScopeTracker
  ) {
    super(module, collections);
    this.extractVariableNamesFromPattern = extractVariableNamesFromPattern;
    this.trackVariableAssignment = trackVariableAssignment;
    this.scopeTracker = scopeTracker;
  }

  getHandlers(): VisitorHandlers {
    const { module } = this;
    const variableDeclarations = this.collections.variableDeclarations ?? [];
    const classInstantiations = this.collections.classInstantiations ?? [];
    const literals = (this.collections.literals ?? []) as unknown[];
    const variableAssignments = this.collections.variableAssignments ?? [];
    const varDeclCounterRef = (this.collections.varDeclCounterRef ?? { value: 0 }) as CounterRef;
    const literalCounterRef = (this.collections.literalCounterRef ?? { value: 0 }) as CounterRef;
    const scopeTracker = this.scopeTracker;

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

              const nodeType = shouldBeConstant ? 'CONSTANT' : 'VARIABLE';

              // Generate ID using centralized IdGenerator
              const idGenerator = new IdGenerator(scopeTracker);
              const varId = idGenerator.generate(
                nodeType,
                varInfo.name,
                module.file,
                varInfo.loc.start.line,
                varInfo.loc.start.column,
                varDeclCounterRef as CounterRef
              );

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
                if (varInfo.propertyPath || varInfo.arrayIndex !== undefined || varInfo.isRest) {
                  // Phase 1: Simple Identifier init expressions (REG-201)
                  if (declarator.init.type === 'Identifier') {
                    const sourceBaseName = (declarator.init as Identifier).name;
                    const expressionLine = varInfo.loc.start.line;

                    // Handle rest elements specially - create edge to whole source
                    if (varInfo.isRest) {
                      (variableAssignments as unknown[]).push({
                        variableId: varId,
                        sourceType: 'VARIABLE',
                        sourceName: sourceBaseName,
                        line: expressionLine
                      });
                      return;
                    }

                    const expressionColumn = varInfo.loc.start.column;

                    // Build property path string
                    let fullPath = sourceBaseName;
                    if (varInfo.propertyPath && varInfo.propertyPath.length > 0) {
                      fullPath = `${sourceBaseName}.${varInfo.propertyPath.join('.')}`;
                    }

                    // Generate expression ID (matches GraphBuilder expectations)
                    const expressionId = `${module.file}:EXPRESSION:MemberExpression:${expressionLine}:${expressionColumn}`;

                    // Determine property for display
                    let property: string;
                    if (varInfo.propertyPath && varInfo.propertyPath.length > 0) {
                      property = varInfo.propertyPath[varInfo.propertyPath.length - 1];
                    } else if (varInfo.arrayIndex !== undefined) {
                      property = String(varInfo.arrayIndex);
                    } else {
                      property = '';
                    }

                    // Push assignment with full metadata for GraphBuilder (REG-201)
                    // GraphBuilder will create the EXPRESSION node from this metadata
                    (variableAssignments as unknown[]).push({
                      variableId: varId,
                      sourceId: expressionId,
                      sourceType: 'EXPRESSION',
                      expressionType: 'MemberExpression',
                      object: sourceBaseName,
                      property: property,
                      computed: varInfo.arrayIndex !== undefined,
                      path: fullPath,
                      objectSourceName: sourceBaseName, // Use objectSourceName for DERIVES_FROM edge creation
                      propertyPath: varInfo.propertyPath || undefined,
                      arrayIndex: varInfo.arrayIndex,
                      file: module.file,
                      line: expressionLine,
                      column: expressionColumn
                    });
                  }
                  // Phase 2: CallExpression or AwaitExpression (REG-223)
                  else if (this.isCallOrAwaitExpression(declarator.init)) {
                    const unwrapped = this.unwrapAwaitExpression(declarator.init);
                    const callInfo = this.extractCallInfo(unwrapped);

                    if (!callInfo) {
                      // Unsupported call pattern (computed callee, etc.)
                      return;
                    }

                    const callRepresentation = `${callInfo.name}()`;
                    const expressionLine = varInfo.loc.start.line;
                    const expressionColumn = varInfo.loc.start.column;

                    // Handle rest elements - create direct CALL_SITE assignment
                    if (varInfo.isRest) {
                      (variableAssignments as unknown[]).push({
                        variableId: varId,
                        sourceType: 'CALL_SITE',
                        callName: callInfo.name,
                        callLine: callInfo.line,
                        callColumn: callInfo.column,
                        callSourceLine: callInfo.line,
                        callSourceColumn: callInfo.column,
                        callSourceFile: module.file,
                        callSourceName: callInfo.name,
                        line: expressionLine
                      });
                      return;
                    }

                    // Generate expression ID (matches GraphBuilder expectations)
                    const expressionId = `${module.file}:EXPRESSION:MemberExpression:${expressionLine}:${expressionColumn}`;

                    // Determine property for display
                    let property: string;
                    if (varInfo.propertyPath && varInfo.propertyPath.length > 0) {
                      property = varInfo.propertyPath[varInfo.propertyPath.length - 1];
                    } else if (varInfo.arrayIndex !== undefined) {
                      property = String(varInfo.arrayIndex);
                    } else {
                      property = '';
                    }

                    // Build property path string: "fetchUser().data" or "fetchUser().user.name"
                    let fullPath = callRepresentation;
                    if (varInfo.propertyPath && varInfo.propertyPath.length > 0) {
                      fullPath = `${callRepresentation}.${varInfo.propertyPath.join('.')}`;
                    }

                    // Push assignment with call source metadata for GraphBuilder (REG-223)
                    (variableAssignments as unknown[]).push({
                      variableId: varId,
                      sourceId: expressionId,
                      sourceType: 'EXPRESSION',
                      expressionType: 'MemberExpression',
                      object: callRepresentation,          // "fetchUser()" - display name
                      property: property,
                      computed: varInfo.arrayIndex !== undefined,
                      path: fullPath,
                      propertyPath: varInfo.propertyPath || undefined,
                      arrayIndex: varInfo.arrayIndex,
                      // Call source for DERIVES_FROM lookup (REG-223)
                      callSourceLine: callInfo.line,
                      callSourceColumn: callInfo.column,
                      callSourceFile: module.file,
                      callSourceName: callInfo.name,
                      sourceMetadata: {
                        sourceType: callInfo.isMethodCall ? 'method-call' : 'call'
                      },
                      file: module.file,
                      line: expressionLine,
                      column: expressionColumn
                    });
                  }
                  // Unsupported init type (MemberExpression without call, etc.)
                  // Skip silently
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

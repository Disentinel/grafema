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
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { IdGenerator } from '../IdGenerator.js';

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
  literalCounterRef: CounterRef,
  objectLiterals: unknown[],
  objectProperties: unknown[],
  objectLiteralCounterRef: CounterRef,
  arrayLiterals: unknown[],
  arrayLiteralCounterRef: CounterRef
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
  scopePath?: string[];
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
    const scopes = (this.collections.scopes ?? []) as unknown[];
    const literalCounterRef = (this.collections.literalCounterRef ?? { value: 0 }) as CounterRef;
    const scopeCounterRef = (this.collections.scopeCounterRef ?? { value: 0 }) as CounterRef;
    // Object literal tracking collections (REG-328)
    const objectLiterals = (this.collections.objectLiterals ?? []) as unknown[];
    const objectProperties = (this.collections.objectProperties ?? []) as unknown[];
    const objectLiteralCounterRef = (this.collections.objectLiteralCounterRef ?? { value: 0 }) as CounterRef;
    // Array literal tracking collections (REG-534)
    const arrayLiterals = (this.collections.arrayLiterals ?? []) as unknown[];
    const arrayLiteralCounterRef = (this.collections.arrayLiteralCounterRef ?? { value: 0 }) as CounterRef;
    const scopeTracker = this.scopeTracker;

    const extractVariableNamesFromPattern = this.extractVariableNamesFromPattern;
    const trackVariableAssignment = this.trackVariableAssignment;

    // Track which loops we've already created scopes for
    const processedLoops = new Set<unknown>();

    return {
      VariableDeclaration: (path: NodePath) => {
        // Only module-level variables
        const functionParent = path.getFunctionParent();
        if (!functionParent) {
          const varNode = path.node as VariableDeclaration;
          const isConst = varNode.kind === 'const';

          // Check if this is a loop variable (for...of or for...in)
          const parent = path.parent;
          const isLoopVariable = (parent.type === 'ForOfStatement' || parent.type === 'ForInStatement')
            && (parent as {left?: unknown}).left === varNode;

          // If this is a loop variable, create the loop scope first (if not already created)
          if (isLoopVariable && !processedLoops.has(parent)) {
            processedLoops.add(parent);

            const loopNode = parent as { type: string; loc?: { start: { line: number } } };
            const line = loopNode.loc?.start.line ?? 0;
            const scopeType = loopNode.type === 'ForOfStatement' ? 'for-of-loop' : 'for-in-loop';
            const trackerType = loopNode.type === 'ForOfStatement' ? 'for-of' : 'for-in';
            const scopeId = `SCOPE#${scopeType}#${module.file}#${line}:${scopeCounterRef.value++}`;

            // Enter scope in tracker BEFORE generating semantic ID
            if (scopeTracker) {
              scopeTracker.enterCountedScope(trackerType);
            }

            const semanticId = scopeTracker
              ? scopeTracker.getContext().scopePath.join('->')
              : scopeId;

            (scopes as { id: string; type: string; scopeType: string; semanticId: string; file: string; line: number; parentScopeId: string }[]).push({
              id: scopeId,
              type: 'SCOPE',
              scopeType,
              semanticId,
              file: module.file,
              line,
              parentScopeId: module.id
            });
          }

          varNode.declarations.forEach((declarator: VariableDeclarator) => {
            // Extract all variable names from the pattern (handles destructuring)
            const variables = extractVariableNamesFromPattern(declarator.id);

            variables.forEach((varInfo: VariableInfo) => {
              const literalValue = ExpressionEvaluator.extractLiteralValue(declarator.init);
              const isLiteral = literalValue !== null;
              const isNewExpression = declarator.init && declarator.init.type === 'NewExpression';

              // Loop variables with const should be CONSTANT (they can't be reassigned in loop body)
              // Regular variables with const are CONSTANT only if initialized with literal or new expression
              const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);

              const nodeType = shouldBeConstant ? 'CONSTANT' : 'VARIABLE';

              // Generate ID using centralized IdGenerator
              const idGenerator = new IdGenerator(scopeTracker);
              const varId = idGenerator.generateV2Simple(nodeType, varInfo.name, module.file);

              const currentScopePath = scopeTracker?.getContext().scopePath ?? [];

              if (shouldBeConstant) {
                // CONSTANT node
                const constantData: VariableDeclarationInfo = {
                  id: varId,
                  type: 'CONSTANT',
                  name: varInfo.name,
                  file: module.file,
                  line: varInfo.loc.start.line,
                  parentScopeId: module.id,
                  scopePath: currentScopePath
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
                  parentScopeId: module.id,
                  scopePath: currentScopePath
                });
              }

              // Track assignment for data flow analysis
              // For loop variables, the "init" is the right side of for...of/for...in
              const initExpression = isLoopVariable
                ? (parent as {right?: Node}).right
                : declarator.init;

              if (initExpression) {
                // For loop variables, create DERIVES_FROM edges instead of ASSIGNED_FROM
                // Loop variables derive their values from the collection (semantic difference)
                if (isLoopVariable && initExpression.type === 'Identifier') {
                  const sourceName = (initExpression as Identifier).name;
                  (variableAssignments as unknown[]).push({
                    variableId: varId,
                    sourceType: 'DERIVES_FROM_VARIABLE',
                    sourceName,
                    file: module.file,
                    line: varInfo.loc.start.line
                  });
                }
                // Handle destructuring - create EXPRESSION for property path
                else if (varInfo.propertyPath || varInfo.arrayIndex !== undefined || varInfo.isRest) {
                  // Phase 1: Simple Identifier init expressions (REG-201)
                  if (initExpression.type === 'Identifier') {
                    const sourceBaseName = (initExpression as Identifier).name;
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
                  else if (this.isCallOrAwaitExpression(initExpression)) {
                    const unwrapped = this.unwrapAwaitExpression(initExpression);
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
                  // Phase 3: MemberExpression init (REG-534): const { a } = obj.nested
                  else if (initExpression.type === 'MemberExpression') {
                    const objectName = initExpression.object?.type === 'Identifier'
                      ? (initExpression.object as Identifier).name : '<complex>';
                    const propNode = (initExpression as { property: Node; computed?: boolean }).property;
                    const isComputed = (initExpression as { computed?: boolean }).computed ?? false;
                    const propertyName = !isComputed && propNode.type === 'Identifier'
                      ? (propNode as Identifier).name : '<computed>';
                    const sourceRepresentation = `${objectName}.${propertyName}`;

                    const expressionLine = varInfo.loc.start.line;
                    const expressionColumn = varInfo.loc.start.column;

                    // Determine property for display
                    let property: string;
                    if (varInfo.propertyPath && varInfo.propertyPath.length > 0) {
                      property = varInfo.propertyPath[varInfo.propertyPath.length - 1];
                    } else if (varInfo.arrayIndex !== undefined) {
                      property = String(varInfo.arrayIndex);
                    } else {
                      property = '';
                    }

                    // Build property path string
                    let fullPath = sourceRepresentation;
                    if (varInfo.propertyPath && varInfo.propertyPath.length > 0) {
                      fullPath = `${sourceRepresentation}.${varInfo.propertyPath.join('.')}`;
                    }

                    const expressionId = `${module.file}:EXPRESSION:MemberExpression:${expressionLine}:${expressionColumn}`;

                    (variableAssignments as unknown[]).push({
                      variableId: varId,
                      sourceId: expressionId,
                      sourceType: 'EXPRESSION',
                      expressionType: 'MemberExpression',
                      object: sourceRepresentation,
                      property: property,
                      computed: varInfo.arrayIndex !== undefined,
                      path: fullPath,
                      objectSourceName: initExpression.object?.type === 'Identifier'
                        ? (initExpression.object as Identifier).name : null,
                      propertyPath: varInfo.propertyPath || undefined,
                      arrayIndex: varInfo.arrayIndex,
                      file: module.file,
                      line: expressionLine,
                      column: expressionColumn
                    });
                  }
                  // Phase 4: NewExpression init (REG-534): const { data } = new Response()
                  else if (initExpression.type === 'NewExpression') {
                    const newExpr = initExpression as NewExpression;
                    const callee = newExpr.callee;
                    let constructorName: string;
                    if (callee.type === 'Identifier') {
                      constructorName = (callee as Identifier).name;
                    } else if (callee.type === 'MemberExpression' &&
                               (callee as { property: Node }).property.type === 'Identifier') {
                      constructorName = ((callee as { property: Node }).property as Identifier).name;
                    } else {
                      return; // Unknown callee
                    }

                    const callRepresentation = `new ${constructorName}()`;
                    const expressionLine = varInfo.loc.start.line;
                    const expressionColumn = varInfo.loc.start.column;

                    let property: string;
                    if (varInfo.propertyPath && varInfo.propertyPath.length > 0) {
                      property = varInfo.propertyPath[varInfo.propertyPath.length - 1];
                    } else if (varInfo.arrayIndex !== undefined) {
                      property = String(varInfo.arrayIndex);
                    } else {
                      property = '';
                    }

                    let fullPath = callRepresentation;
                    if (varInfo.propertyPath && varInfo.propertyPath.length > 0) {
                      fullPath = `${callRepresentation}.${varInfo.propertyPath.join('.')}`;
                    }

                    const expressionId = `${module.file}:EXPRESSION:MemberExpression:${expressionLine}:${expressionColumn}`;

                    (variableAssignments as unknown[]).push({
                      variableId: varId,
                      sourceId: expressionId,
                      sourceType: 'EXPRESSION',
                      expressionType: 'MemberExpression',
                      object: callRepresentation,
                      property: property,
                      computed: varInfo.arrayIndex !== undefined,
                      path: fullPath,
                      propertyPath: varInfo.propertyPath || undefined,
                      arrayIndex: varInfo.arrayIndex,
                      file: module.file,
                      line: expressionLine,
                      column: expressionColumn
                    });
                  }
                  // Phase 5: TS wrapper unwrapping for destructuring (REG-534)
                  else if (initExpression.type === 'TSAsExpression' || initExpression.type === 'TSSatisfiesExpression' ||
                           initExpression.type === 'TSNonNullExpression' || initExpression.type === 'TSTypeAssertion') {
                    // Unwrap TS assertion and re-enter with unwrapped expression.
                    // We can't easily recurse the whole destructuring loop from here,
                    // so just re-dispatch with unwrapped init — this handles the common case.
                    const unwrappedInit = (initExpression as { expression: Node }).expression;
                    // Re-run the same logic with unwrapped init for this one variable
                    if (unwrappedInit.type === 'Identifier') {
                      const sourceBaseName = (unwrappedInit as Identifier).name;
                      const expressionLine = varInfo.loc.start.line;
                      const expressionColumn = varInfo.loc.start.column;

                      if (varInfo.isRest) {
                        (variableAssignments as unknown[]).push({
                          variableId: varId,
                          sourceType: 'VARIABLE',
                          sourceName: sourceBaseName,
                          line: expressionLine
                        });
                        return;
                      }

                      let fullPath = sourceBaseName;
                      if (varInfo.propertyPath && varInfo.propertyPath.length > 0) {
                        fullPath = `${sourceBaseName}.${varInfo.propertyPath.join('.')}`;
                      }

                      const expressionId = `${module.file}:EXPRESSION:MemberExpression:${expressionLine}:${expressionColumn}`;

                      let property: string;
                      if (varInfo.propertyPath && varInfo.propertyPath.length > 0) {
                        property = varInfo.propertyPath[varInfo.propertyPath.length - 1];
                      } else if (varInfo.arrayIndex !== undefined) {
                        property = String(varInfo.arrayIndex);
                      } else {
                        property = '';
                      }

                      (variableAssignments as unknown[]).push({
                        variableId: varId,
                        sourceId: expressionId,
                        sourceType: 'EXPRESSION',
                        expressionType: 'MemberExpression',
                        object: sourceBaseName,
                        property: property,
                        computed: varInfo.arrayIndex !== undefined,
                        path: fullPath,
                        objectSourceName: sourceBaseName,
                        propertyPath: varInfo.propertyPath || undefined,
                        arrayIndex: varInfo.arrayIndex,
                        file: module.file,
                        line: expressionLine,
                        column: expressionColumn
                      });
                    }
                    // For non-Identifier unwrapped (e.g., call as Type), fallthrough to trackVariableAssignment
                  }
                  // Unsupported init type — skip silently
                } else {
                  // Normal assignment tracking
                  trackVariableAssignment(
                    initExpression,
                    varId,
                    varInfo.name,
                    module,
                    varInfo.loc.start.line,
                    literals,
                    variableAssignments,
                    literalCounterRef as CounterRef,
                    objectLiterals,
                    objectProperties,
                    objectLiteralCounterRef,
                    arrayLiterals,
                    arrayLiteralCounterRef
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

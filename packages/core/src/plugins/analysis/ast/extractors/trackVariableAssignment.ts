import * as t from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { ExpressionNode } from '../../../../core/nodes/ExpressionNode.js';
import { ObjectLiteralNode } from '../../../../core/nodes/ObjectLiteralNode.js';
import { ArrayLiteralNode } from '../../../../core/nodes/ArrayLiteralNode.js';
import { getLine, getColumn } from '../utils/location.js';
import { extractObjectProperties } from './extractObjectProperties.js';
import type { VisitorModule } from '../visitors/index.js';
import type {
  LiteralInfo,
  VariableAssignmentInfo,
  ObjectLiteralInfo,
  ObjectPropertyInfo,
  ArrayLiteralInfo,
  CounterRef,
} from '../types.js';

/**
 * Shared collection context for variable assignment tracking.
 * Groups the mutable collection arrays that are threaded through recursive calls,
 * reducing the parameter count of trackVariableAssignment from 13 to 6.
 */
export interface AssignmentTrackingContext {
  literals: LiteralInfo[];
  variableAssignments: VariableAssignmentInfo[];
  literalCounterRef: CounterRef;
  objectLiterals: ObjectLiteralInfo[];
  objectProperties: ObjectPropertyInfo[];
  objectLiteralCounterRef: CounterRef;
  arrayLiterals: ArrayLiteralInfo[];
  arrayLiteralCounterRef: CounterRef;
}

export function trackVariableAssignment(
  initNode: t.Expression | null | undefined,
  variableId: string,
  variableName: string,
  module: VisitorModule,
  line: number,
  ctx: AssignmentTrackingContext
): void {
  if (!initNode) return;
  // initNode is already typed as t.Expression
  const initExpression = initNode;

  // 0. AwaitExpression
  if (initExpression.type === 'AwaitExpression') {
    return trackVariableAssignment(initExpression.argument, variableId, variableName, module, line, ctx);
  }

  // 0.1. TS type assertion unwrapping (REG-534) — these are type-only wrappers, the value is in .expression
  if (initExpression.type === 'TSAsExpression' || initExpression.type === 'TSSatisfiesExpression' ||
      initExpression.type === 'TSNonNullExpression' || initExpression.type === 'TSTypeAssertion') {
    return trackVariableAssignment((initExpression as any).expression, variableId, variableName, module, line, ctx);
  }

  // 0.5. ObjectExpression (REG-328) - must be before literal check
  if (initExpression.type === 'ObjectExpression') {
    const column = initExpression.loc?.start.column ?? 0;
    const objectNode = ObjectLiteralNode.create(
      module.file,
      line,
      column,
      { counter: ctx.objectLiteralCounterRef.value++ }
    );

    // Add to objectLiterals collection for GraphBuilder to create the node
    ctx.objectLiterals.push(objectNode as unknown as ObjectLiteralInfo);

    // Extract properties from the object literal
    extractObjectProperties(
      initExpression,
      objectNode.id,
      module,
      ctx.objectProperties,
      ctx.objectLiterals,
      ctx.objectLiteralCounterRef,
      ctx.literals,
      ctx.literalCounterRef
    );

    // Create ASSIGNED_FROM edge: VARIABLE -> OBJECT_LITERAL
    ctx.variableAssignments.push({
      variableId,
      sourceId: objectNode.id,
      sourceType: 'OBJECT_LITERAL'
    });
    return;
  }

  // 0.6. ArrayExpression (REG-534) — must be before literal check (like ObjectExpression at 0.5)
  // Creates proper ARRAY_LITERAL node for queryability: "find all array literals"
  if (initExpression.type === 'ArrayExpression') {
    const column = initExpression.loc?.start.column ?? 0;
    const arrayNode = ArrayLiteralNode.create(
      module.file,
      line,
      column,
      { counter: ctx.arrayLiteralCounterRef.value++ }
    );

    // Add to arrayLiterals collection for CoreBuilder to create the node
    ctx.arrayLiterals.push(arrayNode as unknown as ArrayLiteralInfo);

    // Create ASSIGNED_FROM edge: VARIABLE -> ARRAY_LITERAL
    ctx.variableAssignments.push({
      variableId,
      sourceId: arrayNode.id,
      sourceType: 'ARRAY_LITERAL'
    });
    return;
  }

  // 1. Literal
  const literalValue = ExpressionEvaluator.extractLiteralValue(initExpression);
  if (literalValue !== null) {
    const literalId = `LITERAL#${line}:${initExpression.start}#${module.file}`;
    ctx.literals.push({
      id: literalId,
      type: 'LITERAL',
      value: literalValue,
      valueType: typeof literalValue,
      file: module.file,
      line: line
    });

    ctx.variableAssignments.push({
      variableId,
      sourceId: literalId,
      sourceType: 'LITERAL'
    });
    return;
  }

  // 2. CallExpression with Identifier
  if (initExpression.type === 'CallExpression' && initExpression.callee.type === 'Identifier') {
    ctx.variableAssignments.push({
      variableId,
      sourceId: null,
      sourceType: 'CALL_SITE',
      callName: initExpression.callee.name,
      callLine: getLine(initExpression),
      callColumn: getColumn(initExpression)
    });
    return;
  }

  // 3. MemberExpression call (e.g., arr.map())
  // Uses coordinate-based lookup to reference the standard CALL node created by CallExpressionVisitor
  if (initExpression.type === 'CallExpression' && initExpression.callee.type === 'MemberExpression') {
    ctx.variableAssignments.push({
      variableId,
      sourceType: 'METHOD_CALL',
      sourceLine: getLine(initExpression),
      sourceColumn: getColumn(initExpression),
      sourceFile: module.file,
      line: line
    });
    return;
  }

  // 4. Identifier
  if (initExpression.type === 'Identifier') {
    ctx.variableAssignments.push({
      variableId,
      sourceType: 'VARIABLE',
      sourceName: initExpression.name,
      line: line
    });
    return;
  }

  // 5. NewExpression -> CONSTRUCTOR_CALL
  if (initExpression.type === 'NewExpression') {
    const callee = initExpression.callee;
    let className: string;

    if (callee.type === 'Identifier') {
      className = callee.name;
    } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
      // Handle: new module.ClassName()
      className = callee.property.name;
    } else {
      // Unknown callee type, skip
      return;
    }

    const callLine = initExpression.loc?.start.line ?? line;
    const callColumn = initExpression.loc?.start.column ?? 0;

    ctx.variableAssignments.push({
      variableId,
      sourceType: 'CONSTRUCTOR_CALL',
      className,
      file: module.file,
      line: callLine,
      column: callColumn
    });
    return;
  }

  // 6. ArrowFunctionExpression or FunctionExpression
  if (initExpression.type === 'ArrowFunctionExpression' || initExpression.type === 'FunctionExpression') {
    ctx.variableAssignments.push({
      variableId,
      sourceType: 'FUNCTION',
      functionName: variableName,
      line: line
    });
    return;
  }

  // 7. MemberExpression (without call)
  if (initExpression.type === 'MemberExpression') {
    const objectName = initExpression.object.type === 'Identifier'
      ? initExpression.object.name
      : '<complex>';
    const propertyName = initExpression.computed
      ? '<computed>'
      : (initExpression.property.type === 'Identifier' ? initExpression.property.name : '<unknown>');

    const computedPropertyVar = initExpression.computed && initExpression.property.type === 'Identifier'
      ? initExpression.property.name
      : null;

    const column = getColumn(initExpression);
    const expressionId = ExpressionNode.generateId('MemberExpression', module.file, line, column);

    ctx.variableAssignments.push({
      variableId,
      sourceType: 'EXPRESSION',
      sourceId: expressionId,
      expressionType: 'MemberExpression',
      object: objectName,
      property: propertyName,
      computed: initExpression.computed,
      computedPropertyVar,
      objectSourceName: initExpression.object.type === 'Identifier' ? initExpression.object.name : null,
      file: module.file,
      line: line,
      column: column
    });
    return;
  }

  // 8. BinaryExpression
  if (initExpression.type === 'BinaryExpression') {
    const column = getColumn(initExpression);
    const expressionId = ExpressionNode.generateId('BinaryExpression', module.file, line, column);

    ctx.variableAssignments.push({
      variableId,
      sourceType: 'EXPRESSION',
      sourceId: expressionId,
      expressionType: 'BinaryExpression',
      operator: initExpression.operator,
      leftSourceName: initExpression.left.type === 'Identifier' ? initExpression.left.name : null,
      rightSourceName: initExpression.right.type === 'Identifier' ? initExpression.right.name : null,
      file: module.file,
      line: line,
      column: column
    });
    return;
  }

  // 9. ConditionalExpression
  if (initExpression.type === 'ConditionalExpression') {
    const column = getColumn(initExpression);
    const expressionId = ExpressionNode.generateId('ConditionalExpression', module.file, line, column);

    ctx.variableAssignments.push({
      variableId,
      sourceType: 'EXPRESSION',
      sourceId: expressionId,
      expressionType: 'ConditionalExpression',
      consequentSourceName: initExpression.consequent.type === 'Identifier' ? initExpression.consequent.name : null,
      alternateSourceName: initExpression.alternate.type === 'Identifier' ? initExpression.alternate.name : null,
      file: module.file,
      line: line,
      column: column
    });

    trackVariableAssignment(initExpression.consequent, variableId, variableName, module, line, ctx);
    trackVariableAssignment(initExpression.alternate, variableId, variableName, module, line, ctx);
    return;
  }

  // 10. LogicalExpression
  if (initExpression.type === 'LogicalExpression') {
    const column = getColumn(initExpression);
    const expressionId = ExpressionNode.generateId('LogicalExpression', module.file, line, column);

    ctx.variableAssignments.push({
      variableId,
      sourceType: 'EXPRESSION',
      sourceId: expressionId,
      expressionType: 'LogicalExpression',
      operator: initExpression.operator,
      leftSourceName: initExpression.left.type === 'Identifier' ? initExpression.left.name : null,
      rightSourceName: initExpression.right.type === 'Identifier' ? initExpression.right.name : null,
      file: module.file,
      line: line,
      column: column
    });

    trackVariableAssignment(initExpression.left, variableId, variableName, module, line, ctx);
    trackVariableAssignment(initExpression.right, variableId, variableName, module, line, ctx);
    return;
  }

  // 11. TemplateLiteral
  if (initExpression.type === 'TemplateLiteral' && initExpression.expressions.length > 0) {
    const column = getColumn(initExpression);
    const expressionId = ExpressionNode.generateId('TemplateLiteral', module.file, line, column);

    const expressionSourceNames = initExpression.expressions
      .filter((expr): expr is t.Identifier => expr.type === 'Identifier')
      .map(expr => expr.name);

    ctx.variableAssignments.push({
      variableId,
      sourceType: 'EXPRESSION',
      sourceId: expressionId,
      expressionType: 'TemplateLiteral',
      expressionSourceNames,
      file: module.file,
      line: line,
      column: column
    });

    for (const expr of initExpression.expressions) {
      // Filter out TSType nodes (only in TypeScript code)
      if (t.isExpression(expr)) {
        trackVariableAssignment(expr, variableId, variableName, module, line, ctx);
      }
    }
    return;
  }

  // 12. UnaryExpression (REG-534): !flag, -x, typeof x, void 0
  if (initExpression.type === 'UnaryExpression') {
    const column = getColumn(initExpression);
    const expressionId = ExpressionNode.generateId('UnaryExpression', module.file, line, column);

    ctx.variableAssignments.push({
      variableId,
      sourceType: 'EXPRESSION',
      sourceId: expressionId,
      expressionType: 'UnaryExpression',
      operator: initExpression.operator,
      unaryArgSourceName: initExpression.argument.type === 'Identifier' ? initExpression.argument.name : null,
      file: module.file,
      line: line,
      column: column
    });
    return;
  }

  // 13. TaggedTemplateExpression (REG-534): html`<div>` — effectively a function call
  // CallExpressionVisitor now handles TaggedTemplateExpression and creates CALL nodes.
  // Use CALL_SITE/METHOD_CALL sourceType so AssignmentBuilder resolves to the CALL node.
  if (initExpression.type === 'TaggedTemplateExpression') {
    if (initExpression.tag.type === 'Identifier') {
      ctx.variableAssignments.push({
        variableId,
        sourceId: null,
        sourceType: 'CALL_SITE',
        callName: initExpression.tag.name,
        callLine: getLine(initExpression),
        callColumn: getColumn(initExpression)
      });
    } else if (initExpression.tag.type === 'MemberExpression') {
      ctx.variableAssignments.push({
        variableId,
        sourceType: 'METHOD_CALL',
        sourceLine: getLine(initExpression),
        sourceColumn: getColumn(initExpression),
        sourceFile: module.file,
        line: line
      });
    } else {
      // Fallback for complex tag expressions (e.g., tagged template with call expr as tag)
      const column = getColumn(initExpression);
      const expressionId = ExpressionNode.generateId('TaggedTemplateExpression', module.file, line, column);
      ctx.variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'TaggedTemplateExpression',
        file: module.file,
        line: line,
        column: column
      });
    }
    return;
  }

  // 14. ClassExpression (REG-534): const MyClass = class { ... }
  // ClassVisitor handles ClassExpression and creates a CLASS node.
  // Use CLASS sourceType so AssignmentBuilder's createClassAssignmentEdges() resolves it.
  if (initExpression.type === 'ClassExpression') {
    ctx.variableAssignments.push({
      variableId,
      sourceType: 'CLASS',
      className: variableName,
      line: line
    });
    return;
  }

  // 15. OptionalCallExpression (REG-534): obj?.method()
  // Note: CallExpressionVisitor doesn't handle OptionalCallExpression, so there may be
  // no CALL node to match. Use EXPRESSION pattern to ensure the assignment edge is created.
  if (initExpression.type === 'OptionalCallExpression') {
    const column = getColumn(initExpression);
    const expressionId = ExpressionNode.generateId('OptionalCallExpression', module.file, line, column);

    ctx.variableAssignments.push({
      variableId,
      sourceType: 'EXPRESSION',
      sourceId: expressionId,
      expressionType: 'OptionalCallExpression',
      file: module.file,
      line: line,
      column: column
    });
    return;
  }

  // 16. OptionalMemberExpression (REG-534): obj?.prop — same logic as MemberExpression (branch 7)
  if (initExpression.type === 'OptionalMemberExpression') {
    const objectName = initExpression.object.type === 'Identifier'
      ? initExpression.object.name
      : '<complex>';
    const propertyName = initExpression.computed
      ? '<computed>'
      : (initExpression.property.type === 'Identifier' ? initExpression.property.name : '<unknown>');

    const computedPropertyVar = initExpression.computed && initExpression.property.type === 'Identifier'
      ? initExpression.property.name
      : null;

    const column = getColumn(initExpression);
    const expressionId = ExpressionNode.generateId('MemberExpression', module.file, line, column);

    ctx.variableAssignments.push({
      variableId,
      sourceType: 'EXPRESSION',
      sourceId: expressionId,
      expressionType: 'MemberExpression',
      object: objectName,
      property: propertyName,
      computed: initExpression.computed,
      computedPropertyVar,
      objectSourceName: initExpression.object.type === 'Identifier' ? initExpression.object.name : null,
      file: module.file,
      line: line,
      column: column
    });
    return;
  }

  // 17. SequenceExpression (REG-534): (a, b, c) — last expression is the value
  if (initExpression.type === 'SequenceExpression' && initExpression.expressions.length > 0) {
    const lastExpr = initExpression.expressions[initExpression.expressions.length - 1];
    if (t.isExpression(lastExpr)) {
      return trackVariableAssignment(lastExpr, variableId, variableName, module, line, ctx);
    }
    return;
  }

  // 18. YieldExpression (REG-534): yield value — recurse into argument if present
  if (initExpression.type === 'YieldExpression') {
    if (initExpression.argument) {
      return trackVariableAssignment(initExpression.argument, variableId, variableName, module, line, ctx);
    }
    return;
  }

  // 19. AssignmentExpression (REG-534): (a = b) — right side is the effective value
  if (initExpression.type === 'AssignmentExpression') {
    return trackVariableAssignment(initExpression.right, variableId, variableName, module, line, ctx);
  }

  // Fallback: unknown expression type — no edge created (REG-534)
  // Silent fallback: unhandled types are expected for exotic AST patterns
}

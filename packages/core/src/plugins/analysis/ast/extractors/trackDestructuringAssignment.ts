import * as t from '@babel/types';
import { ExpressionNode } from '../../../../core/nodes/ExpressionNode.js';
import { getColumn } from '../utils/location.js';
import {
  unwrapAwaitExpression as unwrapAwaitExpressionFn,
  extractCallInfo as extractCallInfoFn,
  isCallOrAwaitExpression as isCallOrAwaitExpressionFn,
} from '../utils/expression-helpers.js';
import type { VisitorModule } from '../visitors/index.js';
import type {
  VariableAssignmentInfo,
  ExtractedVariable,
} from '../types.js';

export function trackDestructuringAssignment(
  pattern: t.ObjectPattern | t.ArrayPattern,
  initNode: t.Expression | null | undefined,
  variables: Array<ExtractedVariable & { id: string }>,
  module: VisitorModule,
  variableAssignments: VariableAssignmentInfo[]
): void {
  if (!initNode) return;

  // Phase 1: Simple Identifier init expressions (REG-201)
  // Examples: const { x } = obj, const [a] = arr
  if (t.isIdentifier(initNode)) {
    const sourceBaseName = initNode.name;

    // Process each extracted variable
    for (const varInfo of variables) {
      const variableId = varInfo.id;

      // Handle rest elements specially - create edge to whole source
      if (varInfo.isRest) {
        variableAssignments.push({
          variableId,
          sourceType: 'VARIABLE',
          sourceName: sourceBaseName,
          line: varInfo.loc.start.line
        });
        continue;
      }

      // ObjectPattern: const { headers } = req → headers ASSIGNED_FROM req.headers
      if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
        const propertyPath = varInfo.propertyPath;
        const expressionLine = varInfo.loc.start.line;
        const expressionColumn = varInfo.loc.start.column;

        // Build property path string (e.g., "req.headers.contentType" for nested)
        const fullPath = [sourceBaseName, ...propertyPath].join('.');

        const expressionId = ExpressionNode.generateId(
          'MemberExpression',
          module.file,
          expressionLine,
          expressionColumn
        );

        variableAssignments.push({
          variableId,
          sourceType: 'EXPRESSION',
          sourceId: expressionId,
          expressionType: 'MemberExpression',
          object: sourceBaseName,
          property: propertyPath[propertyPath.length - 1], // Last property for simple display
          computed: false,
          path: fullPath,
          objectSourceName: sourceBaseName, // Use objectSourceName for DERIVES_FROM edge creation
          propertyPath: propertyPath,
          file: module.file,
          line: expressionLine,
          column: expressionColumn
        });
      }
      // ArrayPattern: const [first, second] = arr → first ASSIGNED_FROM arr[0]
      else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
        const arrayIndex = varInfo.arrayIndex;
        const expressionLine = varInfo.loc.start.line;
        const expressionColumn = varInfo.loc.start.column;

        // Check if we also have propertyPath (mixed destructuring: { items: [first] } = data)
        const hasPropertyPath = varInfo.propertyPath && varInfo.propertyPath.length > 0;

        const expressionId = ExpressionNode.generateId(
          'MemberExpression',
          module.file,
          expressionLine,
          expressionColumn
        );

        variableAssignments.push({
          variableId,
          sourceType: 'EXPRESSION',
          sourceId: expressionId,
          expressionType: 'MemberExpression',
          object: sourceBaseName,
          property: String(arrayIndex),
          computed: true,
          objectSourceName: sourceBaseName, // Use objectSourceName for DERIVES_FROM edge creation
          arrayIndex: arrayIndex,
          propertyPath: hasPropertyPath ? varInfo.propertyPath : undefined,
          file: module.file,
          line: expressionLine,
          column: expressionColumn
        });
      }
    }
  }
  // Phase 2: CallExpression or AwaitExpression (REG-223)
  else if (isCallOrAwaitExpressionFn(initNode)) {
    const unwrapped = unwrapAwaitExpressionFn(initNode);
    const callInfo = extractCallInfoFn(unwrapped);

    if (!callInfo) {
      // Unsupported call pattern (computed callee, etc.)
      return;
    }

    const callRepresentation = `${callInfo.name}()`;

    // Process each extracted variable
    for (const varInfo of variables) {
      const variableId = varInfo.id;

      // Handle rest elements - create direct CALL_SITE assignment
      if (varInfo.isRest) {
        variableAssignments.push({
          variableId,
          sourceType: 'CALL_SITE',
          callName: callInfo.name,
          callLine: callInfo.line,
          callColumn: callInfo.column,
          callSourceLine: callInfo.line,
          callSourceColumn: callInfo.column,
          callSourceFile: module.file,
          callSourceName: callInfo.name,
          line: varInfo.loc.start.line
        });
        continue;
      }

      // ObjectPattern: const { data } = fetchUser() → data ASSIGNED_FROM fetchUser().data
      if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
        const propertyPath = varInfo.propertyPath;
        const expressionLine = varInfo.loc.start.line;
        const expressionColumn = varInfo.loc.start.column;

        // Build property path string: "fetchUser().data" or "fetchUser().user.name"
        const fullPath = [callRepresentation, ...propertyPath].join('.');

        const expressionId = ExpressionNode.generateId(
          'MemberExpression',
          module.file,
          expressionLine,
          expressionColumn
        );

        variableAssignments.push({
          variableId,
          sourceType: 'EXPRESSION',
          sourceId: expressionId,
          expressionType: 'MemberExpression',
          object: callRepresentation,          // "fetchUser()" - display name
          property: propertyPath[propertyPath.length - 1],
          computed: false,
          path: fullPath,                       // "fetchUser().data"
          propertyPath: propertyPath,           // ["data"]
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
      // ArrayPattern: const [first] = arr.map(fn) → first ASSIGNED_FROM arr.map(fn)[0]
      else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
        const arrayIndex = varInfo.arrayIndex;
        const expressionLine = varInfo.loc.start.line;
        const expressionColumn = varInfo.loc.start.column;

        const hasPropertyPath = varInfo.propertyPath && varInfo.propertyPath.length > 0;

        const expressionId = ExpressionNode.generateId(
          'MemberExpression',
          module.file,
          expressionLine,
          expressionColumn
        );

        variableAssignments.push({
          variableId,
          sourceType: 'EXPRESSION',
          sourceId: expressionId,
          expressionType: 'MemberExpression',
          object: callRepresentation,
          property: String(arrayIndex),
          computed: true,
          arrayIndex: arrayIndex,
          propertyPath: hasPropertyPath ? varInfo.propertyPath : undefined,
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
    }
  }
  // Phase 3: MemberExpression init (REG-534): const { a } = obj.nested
  else if (t.isMemberExpression(initNode)) {
    const objectName = initNode.object.type === 'Identifier' ? initNode.object.name : '<complex>';
    const propertyName = !initNode.computed && initNode.property.type === 'Identifier'
      ? initNode.property.name : '<computed>';
    const sourceRepresentation = `${objectName}.${propertyName}`;

    for (const varInfo of variables) {
      const variableId = varInfo.id;
      if (varInfo.isRest) {
        const column = getColumn(initNode);
        const expressionId = ExpressionNode.generateId('MemberExpression', module.file, varInfo.loc.start.line, column);
        variableAssignments.push({
          variableId,
          sourceType: 'EXPRESSION', sourceId: expressionId,
          expressionType: 'MemberExpression',
          object: objectName, property: propertyName,
          computed: initNode.computed,
          objectSourceName: initNode.object.type === 'Identifier' ? initNode.object.name : null,
          file: module.file,
          line: varInfo.loc.start.line,
          column: column
        });
        continue;
      }

      if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
        const expressionLine = varInfo.loc.start.line;
        const expressionColumn = varInfo.loc.start.column;
        const fullPath = [sourceRepresentation, ...varInfo.propertyPath].join('.');
        const expressionId = ExpressionNode.generateId('MemberExpression', module.file, expressionLine, expressionColumn);

        variableAssignments.push({
          variableId,
          sourceType: 'EXPRESSION', sourceId: expressionId,
          expressionType: 'MemberExpression',
          object: sourceRepresentation,
          property: varInfo.propertyPath[varInfo.propertyPath.length - 1],
          computed: false, path: fullPath,
          objectSourceName: initNode.object.type === 'Identifier' ? initNode.object.name : null,
          propertyPath: varInfo.propertyPath,
          file: module.file,
          line: expressionLine, column: expressionColumn
        });
      } else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
        const expressionLine = varInfo.loc.start.line;
        const expressionColumn = varInfo.loc.start.column;
        const expressionId = ExpressionNode.generateId('MemberExpression', module.file, expressionLine, expressionColumn);

        variableAssignments.push({
          variableId,
          sourceType: 'EXPRESSION', sourceId: expressionId,
          expressionType: 'MemberExpression',
          object: sourceRepresentation,
          property: String(varInfo.arrayIndex),
          computed: true,
          objectSourceName: initNode.object.type === 'Identifier' ? initNode.object.name : null,
          arrayIndex: varInfo.arrayIndex,
          file: module.file,
          line: expressionLine, column: expressionColumn
        });
      }
    }
  }
  // Phase 4: NewExpression init (REG-534): const { data } = new Response()
  else if (t.isNewExpression(initNode)) {
    const callee = initNode.callee;
    let constructorName: string;
    if (callee.type === 'Identifier') {
      constructorName = callee.name;
    } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
      constructorName = callee.property.name;
    } else {
      return; // Unknown callee
    }

    const callRepresentation = `new ${constructorName}()`;
    const callLine = initNode.loc?.start.line ?? 0;
    const callColumn = initNode.loc?.start.column ?? 0;

    for (const varInfo of variables) {
      const variableId = varInfo.id;
      if (varInfo.isRest) {
        variableAssignments.push({
          variableId,
          sourceType: 'CONSTRUCTOR_CALL',
          className: constructorName,
          file: module.file,
          line: callLine, column: callColumn
        });
        continue;
      }

      if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
        const expressionLine = varInfo.loc.start.line;
        const expressionColumn = varInfo.loc.start.column;
        const fullPath = [callRepresentation, ...varInfo.propertyPath].join('.');
        const expressionId = ExpressionNode.generateId('MemberExpression', module.file, expressionLine, expressionColumn);

        variableAssignments.push({
          variableId,
          sourceType: 'EXPRESSION', sourceId: expressionId,
          expressionType: 'MemberExpression',
          object: callRepresentation,
          property: varInfo.propertyPath[varInfo.propertyPath.length - 1],
          computed: false, path: fullPath,
          propertyPath: varInfo.propertyPath,
          file: module.file,
          line: expressionLine, column: expressionColumn
        });
      } else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
        const expressionLine = varInfo.loc.start.line;
        const expressionColumn = varInfo.loc.start.column;
        const expressionId = ExpressionNode.generateId('MemberExpression', module.file, expressionLine, expressionColumn);

        variableAssignments.push({
          variableId,
          sourceType: 'EXPRESSION', sourceId: expressionId,
          expressionType: 'MemberExpression',
          object: callRepresentation,
          property: String(varInfo.arrayIndex),
          computed: true,
          arrayIndex: varInfo.arrayIndex,
          file: module.file,
          line: expressionLine, column: expressionColumn
        });
      }
    }
  }
  // Phase 5: TS wrapper unwrapping for destructuring (REG-534)
  else if (initNode.type === 'TSAsExpression' || initNode.type === 'TSSatisfiesExpression' ||
           initNode.type === 'TSNonNullExpression' || initNode.type === 'TSTypeAssertion') {
    return trackDestructuringAssignment(pattern, (initNode as any).expression, variables, module, variableAssignments);
  }
  // Phase 6: ConditionalExpression init (REG-534): const { a } = cond ? x : y
  // Unlike non-destructuring ConditionalExpression (which creates an intermediate EXPRESSION node
  // AND recurses), destructuring only recurses into branches. This is intentional because
  // destructured variables need per-property tracking from each branch individually — an
  // intermediate EXPRESSION node would not provide useful queryability here.
  else if (t.isConditionalExpression(initNode)) {
    trackDestructuringAssignment(pattern, initNode.consequent, variables, module, variableAssignments);
    trackDestructuringAssignment(pattern, initNode.alternate, variables, module, variableAssignments);
  }
  // Phase 7: LogicalExpression init (REG-534): const { a } = x || defaults
  // Same rationale as ConditionalExpression above — destructured variables get per-property
  // EXPRESSION nodes from recursing into the right branch. No intermediate node needed.
  else if (t.isLogicalExpression(initNode)) {
    trackDestructuringAssignment(pattern, initNode.right, variables, module, variableAssignments);
  }
}

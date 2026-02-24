import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import {
  extractOperandName,
  memberExpressionToString,
  caseTerminates,
  extractCaseValue,
} from '../utils/expression-helpers.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { ExpressionNode } from '../../../../core/nodes/ExpressionNode.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { VisitorModule, VisitorCollections } from '../visitors/index.js';
import type {
  BranchInfo,
  CaseInfo,
  CounterRef,
} from '../types.js';

export function handleSwitchStatement(
  switchPath: NodePath<t.SwitchStatement>,
  parentScopeId: string,
  module: VisitorModule,
  collections: VisitorCollections,
  scopeTracker: ScopeTracker | undefined,
  controlFlowState?: { branchCount: number; caseCount: number },
  switchCaseScopeMap?: Map<t.SwitchCase, string>,
): void {
  const switchNode = switchPath.node;

  // Phase 6 (REG-267): Count branch and non-default cases for cyclomatic complexity
  if (controlFlowState) {
    controlFlowState.branchCount++;  // switch itself is a branch
    // Count non-default cases
    for (const caseNode of switchNode.cases) {
      if (caseNode.test !== null) {  // Not default case
        controlFlowState.caseCount++;
      }
    }
  }

  // Initialize collections if not exist
  if (!collections.branches) {
    collections.branches = [];
  }
  if (!collections.cases) {
    collections.cases = [];
  }
  if (!collections.branchCounterRef) {
    collections.branchCounterRef = { value: 0 };
  }
  if (!collections.caseCounterRef) {
    collections.caseCounterRef = { value: 0 };
  }

  const branches = collections.branches as BranchInfo[];
  const cases = collections.cases as CaseInfo[];
  const branchCounterRef = collections.branchCounterRef as CounterRef;
  const caseCounterRef = collections.caseCounterRef as CounterRef;

  // Create BRANCH node
  const branchCounter = branchCounterRef.value++;
  const legacyBranchId = `${module.file}:BRANCH:switch:${getLine(switchNode)}:${branchCounter}`;
  const branchId = scopeTracker
    ? computeSemanticId('BRANCH', 'switch', scopeTracker.getContext(), { discriminator: branchCounter })
    : legacyBranchId;

  // Handle discriminant expression - store metadata directly (Linus improvement)
  let discriminantExpressionId: string | undefined;
  let discriminantExpressionType: string | undefined;
  let discriminantLine: number | undefined;
  let discriminantColumn: number | undefined;

  // REG-533: Operand metadata variables for DERIVES_FROM edges
  let discriminantLeftSourceName: string | undefined;
  let discriminantRightSourceName: string | undefined;
  let discriminantObjectSourceName: string | undefined;
  let discriminantConsequentSourceName: string | undefined;
  let discriminantAlternateSourceName: string | undefined;
  let discriminantUnaryArgSourceName: string | undefined;
  let discriminantOperator: string | undefined;
  let discriminantObject: string | undefined;
  let discriminantProperty: string | undefined;
  let discriminantComputed: boolean | undefined;
  let discriminantExpressionSourceNames: string[] | undefined;

  if (switchNode.discriminant) {
    const discResult = extractDiscriminantExpression(
      switchNode.discriminant,
      module
    );
    discriminantExpressionId = discResult.id;
    discriminantExpressionType = discResult.expressionType;
    discriminantLine = discResult.line;
    discriminantColumn = discResult.column;
    // REG-533: Extract operand metadata
    discriminantLeftSourceName = discResult.leftSourceName;
    discriminantRightSourceName = discResult.rightSourceName;
    discriminantObjectSourceName = discResult.objectSourceName;
    discriminantConsequentSourceName = discResult.consequentSourceName;
    discriminantAlternateSourceName = discResult.alternateSourceName;
    discriminantUnaryArgSourceName = discResult.unaryArgSourceName;
    discriminantOperator = discResult.operator;
    discriminantObject = discResult.object;
    discriminantProperty = discResult.property;
    discriminantComputed = discResult.computed;
    discriminantExpressionSourceNames = discResult.expressionSourceNames;
  }

  branches.push({
    id: branchId,
    semanticId: branchId,
    type: 'BRANCH',
    branchType: 'switch',
    file: module.file,
    line: getLine(switchNode),
    parentScopeId,
    discriminantExpressionId,
    discriminantExpressionType,
    discriminantLine,
    discriminantColumn,
    // REG-533: Operand metadata for DERIVES_FROM edges
    discriminantLeftSourceName,
    discriminantRightSourceName,
    discriminantObjectSourceName,
    discriminantConsequentSourceName,
    discriminantAlternateSourceName,
    discriminantUnaryArgSourceName,
    discriminantOperator,
    discriminantObject,
    discriminantProperty,
    discriminantComputed,
    discriminantExpressionSourceNames
  });

  // Process each case clause
  for (let i = 0; i < switchNode.cases.length; i++) {
    const caseNode = switchNode.cases[i];
    const isDefault = caseNode.test === null;
    const isEmpty = caseNode.consequent.length === 0;

    // Detect fall-through: no break/return/throw at end of consequent
    const fallsThrough = isEmpty || !caseTerminates(caseNode);

    // Extract case value
    const value = isDefault ? null : extractCaseValue(caseNode.test ?? null);

    const caseCounter = caseCounterRef.value++;
    const valueName = isDefault ? 'default' : String(value);
    const legacyCaseId = `${module.file}:CASE:${valueName}:${getLine(caseNode)}:${caseCounter}`;
    const caseId = scopeTracker
      ? computeSemanticId('CASE', valueName, scopeTracker.getContext(), { discriminator: caseCounter })
      : legacyCaseId;

    cases.push({
      id: caseId,
      semanticId: caseId,
      type: 'CASE',
      value,
      isDefault,
      fallsThrough,
      isEmpty,
      file: module.file,
      line: getLine(caseNode),
      parentBranchId: branchId
    });

    // REG-536: Populate switchCaseScopeMap for SwitchCase body SCOPE creation
    if (switchCaseScopeMap && !isEmpty) {
      switchCaseScopeMap.set(caseNode, caseId);
    }
  }
}

export function extractDiscriminantExpression(
  discriminant: t.Expression,
  module: VisitorModule
): {
  id: string;
  expressionType: string;
  line: number;
  column: number;
  objectSourceName?: string;
  object?: string;
  property?: string;
  computed?: boolean;
  leftSourceName?: string;
  rightSourceName?: string;
  operator?: string;
  consequentSourceName?: string;
  alternateSourceName?: string;
  unaryArgSourceName?: string;
  updateArgSourceName?: string;
  expressionSourceNames?: string[];
} {
  const line = getLine(discriminant);
  const column = getColumn(discriminant);

  if (t.isIdentifier(discriminant)) {
    // Simple identifier: switch(x), while(running) - create EXPRESSION node
    return {
      id: ExpressionNode.generateId('Identifier', module.file, line, column),
      expressionType: 'Identifier',
      line,
      column,
      objectSourceName: discriminant.name
    };
  } else if (t.isMemberExpression(discriminant)) {
    // Member expression: switch(action.type), while(obj.active)
    const objectSourceName = extractOperandName(discriminant.object);
    const object = t.isIdentifier(discriminant.object) ? discriminant.object.name
      : t.isMemberExpression(discriminant.object) ? memberExpressionToString(discriminant.object)
      : undefined;
    const property = t.isIdentifier(discriminant.property) ? discriminant.property.name
      : t.isStringLiteral(discriminant.property) ? discriminant.property.value
      : '<computed>';
    const computed = discriminant.computed;
    return {
      id: ExpressionNode.generateId('MemberExpression', module.file, line, column),
      expressionType: 'MemberExpression',
      line,
      column,
      objectSourceName,
      object,
      property,
      computed
    };
  } else if (t.isBinaryExpression(discriminant)) {
    // Binary expression: while(i < 10), for(; i < n;)
    return {
      id: ExpressionNode.generateId('BinaryExpression', module.file, line, column),
      expressionType: 'BinaryExpression',
      line,
      column,
      leftSourceName: extractOperandName(discriminant.left as t.Expression),
      rightSourceName: extractOperandName(discriminant.right),
      operator: discriminant.operator
    };
  } else if (t.isLogicalExpression(discriminant)) {
    // Logical expression: while(a && b)
    return {
      id: ExpressionNode.generateId('LogicalExpression', module.file, line, column),
      expressionType: 'LogicalExpression',
      line,
      column,
      leftSourceName: extractOperandName(discriminant.left),
      rightSourceName: extractOperandName(discriminant.right),
      operator: discriminant.operator
    };
  } else if (t.isConditionalExpression(discriminant)) {
    // Conditional expression: unlikely as discriminant but handle it
    return {
      id: ExpressionNode.generateId('ConditionalExpression', module.file, line, column),
      expressionType: 'ConditionalExpression',
      line,
      column,
      consequentSourceName: extractOperandName(discriminant.consequent),
      alternateSourceName: extractOperandName(discriminant.alternate)
    };
  } else if (t.isUnaryExpression(discriminant)) {
    // Unary expression: while(!done), if(!valid)
    return {
      id: ExpressionNode.generateId('UnaryExpression', module.file, line, column),
      expressionType: 'UnaryExpression',
      line,
      column,
      unaryArgSourceName: extractOperandName(discriminant.argument),
      operator: discriminant.operator
    };
  } else if (t.isUpdateExpression(discriminant)) {
    // Update expression: for(; ; i++)
    return {
      id: ExpressionNode.generateId('UpdateExpression', module.file, line, column),
      expressionType: 'UpdateExpression',
      line,
      column,
      updateArgSourceName: extractOperandName(discriminant.argument),
      operator: discriminant.operator
    };
  } else if (t.isTemplateLiteral(discriminant)) {
    // Template literal: switch(`${prefix}_${suffix}`)
    const expressionSourceNames: string[] = [];
    for (const expr of discriminant.expressions) {
      const name = extractOperandName(expr as t.Expression);
      if (name) {
        expressionSourceNames.push(name);
      }
    }
    return {
      id: ExpressionNode.generateId('TemplateLiteral', module.file, line, column),
      expressionType: 'TemplateLiteral',
      line,
      column,
      expressionSourceNames: expressionSourceNames.length > 0 ? expressionSourceNames : undefined
    };
  } else if (t.isCallExpression(discriminant)) {
    // Call expression: switch(getType()) - reuse existing CALL_SITE tracking
    const callee = t.isIdentifier(discriminant.callee) ? discriminant.callee.name : '<complex>';
    return {
      id: `${module.file}:CALL:${callee}:${line}:${column}`,
      expressionType: 'CallExpression',
      line,
      column
    };
  }

  // Default: create generic EXPRESSION (ThisExpression, SequenceExpression, etc.)
  return {
    id: ExpressionNode.generateId(discriminant.type, module.file, line, column),
    expressionType: discriminant.type,
    line,
    column
  };
}

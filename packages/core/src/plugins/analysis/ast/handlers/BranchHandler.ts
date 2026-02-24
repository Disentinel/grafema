/**
 * BranchHandler -- handles branching control flow nodes: if/else,
 * ternary expressions, block statements (for scope transitions),
 * and switch statements.
 *
 * Inlines the createIfStatementHandler, createConditionalExpressionHandler,
 * createBlockStatementHandler logic and SwitchStatement delegation
 * from JSASTAnalyzer (REG-422).
 */
import type { Visitor, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { countLogicalOperators } from '../utils/expression-helpers.js';
import { generateSemanticId } from '../utils/semanticIdHelpers.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { ExpressionNode } from '../../../../core/nodes/ExpressionNode.js';
import { ConditionParser } from '../ConditionParser.js';
import { handleSwitchStatement, extractDiscriminantExpression } from '../extractors/index.js';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';

export class BranchHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    const ctx = this.ctx;

    return {
      IfStatement: this.createIfStatementVisitor(),

      ConditionalExpression: this.createConditionalExpressionVisitor(),

      // Track when we enter the alternate (else) block of an IfStatement
      BlockStatement: this.createBlockStatementVisitor(),

      SwitchStatement: (switchPath: NodePath<t.SwitchStatement>) => {
        handleSwitchStatement(
          switchPath,
          ctx.getCurrentScopeId(),
          ctx.module,
          ctx.collections,
          ctx.scopeTracker,
          ctx.controlFlowState,
          ctx.switchCaseScopeMap
        );
      },

      SwitchCase: this.createSwitchCaseVisitor(),
    };
  }

  private createIfStatementVisitor(): {
    enter: (ifPath: NodePath<t.IfStatement>) => void;
    exit: (ifPath: NodePath<t.IfStatement>) => void;
  } {
    const ctx = this.ctx;
    const sourceCode = ctx.collections.code ?? '';

    return {
      enter: (ifPath: NodePath<t.IfStatement>) => {
        const ifNode = ifPath.node;
        const condition = sourceCode.substring(ifNode.test.start!, ifNode.test.end!) || 'condition';

        // Phase 6 (REG-267): Increment branch count and count logical operators
        if (ctx.controlFlowState) {
          ctx.controlFlowState.branchCount++;
          ctx.controlFlowState.logicalOpCount += countLogicalOperators(ifNode.test);
        }

        // Check if this if-statement is an else-if (alternate of parent IfStatement)
        const isElseIf = t.isIfStatement(ifPath.parent) && ifPath.parentKey === 'alternate';

        // Determine actual parent scope
        let actualParentScopeId: string;
        if (isElseIf) {
          // For else-if, parent should be the outer BRANCH (stored in ifElseScopeMap)
          const parentIfInfo = ctx.ifElseScopeMap.get(ifPath.parent as t.IfStatement);
          if (parentIfInfo) {
            actualParentScopeId = parentIfInfo.branchId;
          } else {
            // Fallback to stack
            actualParentScopeId = (ctx.scopeIdStack && ctx.scopeIdStack.length > 0)
              ? ctx.scopeIdStack[ctx.scopeIdStack.length - 1]
              : ctx.parentScopeId;
          }
        } else {
          // For regular if statements, use stack or original parentScopeId
          actualParentScopeId = (ctx.scopeIdStack && ctx.scopeIdStack.length > 0)
            ? ctx.scopeIdStack[ctx.scopeIdStack.length - 1]
            : ctx.parentScopeId;
        }

        // 1. Create BRANCH node for if statement
        const branchCounter = ctx.branchCounterRef.value++;
        const legacyBranchId = `${ctx.module.file}:BRANCH:if:${getLine(ifNode)}:${branchCounter}`;
        const branchId = ctx.scopeTracker
          ? computeSemanticId('BRANCH', 'if', ctx.scopeTracker.getContext(), { discriminator: branchCounter })
          : legacyBranchId;

        // 2. Extract condition expression info for HAS_CONDITION edge
        const conditionResult = extractDiscriminantExpression(ifNode.test, ctx.module);

        // For else-if, get the parent branch ID
        const isAlternateOfBranchId = isElseIf
          ? ctx.ifElseScopeMap.get(ifPath.parent as t.IfStatement)?.branchId
          : undefined;

        ctx.branches.push({
          id: branchId,
          semanticId: branchId,
          type: 'BRANCH',
          branchType: 'if',
          file: ctx.module.file,
          line: getLine(ifNode),
          parentScopeId: actualParentScopeId,
          discriminantExpressionId: conditionResult.id,
          discriminantExpressionType: conditionResult.expressionType,
          discriminantLine: conditionResult.line,
          discriminantColumn: conditionResult.column,
          isAlternateOfBranchId,
          // REG-533: Operand metadata for DERIVES_FROM edges
          discriminantLeftSourceName: conditionResult.leftSourceName,
          discriminantRightSourceName: conditionResult.rightSourceName,
          discriminantObjectSourceName: conditionResult.objectSourceName,
          discriminantConsequentSourceName: conditionResult.consequentSourceName,
          discriminantAlternateSourceName: conditionResult.alternateSourceName,
          discriminantUnaryArgSourceName: conditionResult.unaryArgSourceName,
          discriminantOperator: conditionResult.operator,
          discriminantObject: conditionResult.object,
          discriminantProperty: conditionResult.property,
          discriminantComputed: conditionResult.computed,
          discriminantExpressionSourceNames: conditionResult.expressionSourceNames
        });

        // 3. Create if-body SCOPE (backward compatibility)
        // Parent is now BRANCH, not original parentScopeId
        const counterId = ctx.ifScopeCounterRef.value++;
        const ifScopeId = `SCOPE#if#${ctx.module.file}#${getLine(ifNode)}:${getColumn(ifNode)}:${counterId}`;

        // Parse condition to extract constraints
        const constraints = ConditionParser.parse(ifNode.test);
        const ifSemanticId = generateSemanticId('if_statement', ctx.scopeTracker);

        ctx.scopes.push({
          id: ifScopeId,
          type: 'SCOPE',
          scopeType: 'if_statement',
          name: `if:${getLine(ifNode)}:${getColumn(ifNode)}:${counterId}`,
          semanticId: ifSemanticId,
          conditional: true,
          condition,
          constraints: constraints.length > 0 ? constraints : undefined,
          file: ctx.module.file,
          line: getLine(ifNode),
          parentScopeId: branchId  // Parent is BRANCH, not original parentScopeId
        });

        // 4. Push if scope onto stack for CONTAINS edges
        if (ctx.scopeIdStack) {
          ctx.scopeIdStack.push(ifScopeId);
        }

        // Enter scope for semantic ID generation
        if (ctx.scopeTracker) {
          ctx.scopeTracker.enterCountedScope('if');
        }

        // 5. Handle else branch if present
        let elseScopeId: string | null = null;
        if (ifNode.alternate && !t.isIfStatement(ifNode.alternate)) {
          // Only create else scope for actual else block, not else-if
          const elseCounterId = ctx.ifScopeCounterRef.value++;
          elseScopeId = `SCOPE#else#${ctx.module.file}#${getLine(ifNode.alternate)}:${getColumn(ifNode.alternate)}:${elseCounterId}`;

          const negatedConstraints = constraints.length > 0 ? ConditionParser.negate(constraints) : undefined;
          const elseSemanticId = generateSemanticId('else_statement', ctx.scopeTracker);

          ctx.scopes.push({
            id: elseScopeId,
            type: 'SCOPE',
            scopeType: 'else_statement',
            name: `else:${getLine(ifNode.alternate)}:${getColumn(ifNode.alternate)}:${elseCounterId}`,
            semanticId: elseSemanticId,
            conditional: true,
            constraints: negatedConstraints,
            file: ctx.module.file,
            line: getLine(ifNode.alternate),
            parentScopeId: branchId  // Parent is BRANCH, not original parentScopeId
          });

          // Store info to switch to else scope when we enter alternate
          ctx.ifElseScopeMap.set(ifNode, { inElse: false, hasElse: true, ifScopeId, elseScopeId, branchId });
        } else {
          ctx.ifElseScopeMap.set(ifNode, { inElse: false, hasElse: false, ifScopeId, elseScopeId: null, branchId });
        }
      },
      exit: (ifPath: NodePath<t.IfStatement>) => {
        const ifNode = ifPath.node;

        // Pop scope from stack (either if or else, depending on what we're exiting)
        if (ctx.scopeIdStack) {
          ctx.scopeIdStack.pop();
        }

        // Exit the current scope (either if or else)
        if (ctx.scopeTracker) {
          ctx.scopeTracker.exitScope();
        }

        // If we were in else, we already exited else scope
        // If we only had if, we exit if scope (done above)
        ctx.ifElseScopeMap.delete(ifNode);
      }
    };
  }

  private createConditionalExpressionVisitor(): (condPath: NodePath<t.ConditionalExpression>) => void {
    const ctx = this.ctx;

    return (condPath: NodePath<t.ConditionalExpression>) => {
      const condNode = condPath.node;

      // Increment branch count for cyclomatic complexity
      if (ctx.controlFlowState) {
        ctx.controlFlowState.branchCount++;
        // Count logical operators in the test condition (e.g., a && b ? x : y)
        ctx.controlFlowState.logicalOpCount += countLogicalOperators(condNode.test);
      }

      // Determine parent scope from stack or fallback
      const actualParentScopeId = (ctx.scopeIdStack && ctx.scopeIdStack.length > 0)
        ? ctx.scopeIdStack[ctx.scopeIdStack.length - 1]
        : ctx.parentScopeId;

      // Create BRANCH node with branchType='ternary'
      const branchCounter = ctx.branchCounterRef.value++;
      const legacyBranchId = `${ctx.module.file}:BRANCH:ternary:${getLine(condNode)}:${branchCounter}`;
      const branchId = ctx.scopeTracker
        ? computeSemanticId('BRANCH', 'ternary', ctx.scopeTracker.getContext(), { discriminator: branchCounter })
        : legacyBranchId;

      // Extract condition expression info for HAS_CONDITION edge
      const conditionResult = extractDiscriminantExpression(condNode.test, ctx.module);

      // Generate expression IDs for consequent and alternate
      const consequentLine = getLine(condNode.consequent);
      const consequentColumn = getColumn(condNode.consequent);
      const consequentExpressionId = ExpressionNode.generateId(
        condNode.consequent.type,
        ctx.module.file,
        consequentLine,
        consequentColumn
      );

      const alternateLine = getLine(condNode.alternate);
      const alternateColumn = getColumn(condNode.alternate);
      const alternateExpressionId = ExpressionNode.generateId(
        condNode.alternate.type,
        ctx.module.file,
        alternateLine,
        alternateColumn
      );

      ctx.branches.push({
        id: branchId,
        semanticId: branchId,
        type: 'BRANCH',
        branchType: 'ternary',
        file: ctx.module.file,
        line: getLine(condNode),
        parentScopeId: actualParentScopeId,
        discriminantExpressionId: conditionResult.id,
        discriminantExpressionType: conditionResult.expressionType,
        discriminantLine: conditionResult.line,
        discriminantColumn: conditionResult.column,
        consequentExpressionId,
        alternateExpressionId,
        // REG-533: Operand metadata for DERIVES_FROM edges
        discriminantLeftSourceName: conditionResult.leftSourceName,
        discriminantRightSourceName: conditionResult.rightSourceName,
        discriminantObjectSourceName: conditionResult.objectSourceName,
        discriminantConsequentSourceName: conditionResult.consequentSourceName,
        discriminantAlternateSourceName: conditionResult.alternateSourceName,
        discriminantUnaryArgSourceName: conditionResult.unaryArgSourceName,
        discriminantOperator: conditionResult.operator,
        discriminantObject: conditionResult.object,
        discriminantProperty: conditionResult.property,
        discriminantComputed: conditionResult.computed,
        discriminantExpressionSourceNames: conditionResult.expressionSourceNames
      });
    };
  }

  private createBlockStatementVisitor(): {
    enter: (blockPath: NodePath<t.BlockStatement>) => void;
  } {
    const ctx = this.ctx;

    return {
      enter: (blockPath: NodePath<t.BlockStatement>) => {
        const parent = blockPath.parent;

        // Check if this block is the alternate of an IfStatement
        if (t.isIfStatement(parent) && parent.alternate === blockPath.node) {
          const scopeInfo = ctx.ifElseScopeMap.get(parent);
          if (scopeInfo && scopeInfo.hasElse && !scopeInfo.inElse) {
            // Swap if-scope for else-scope on the stack
            if (ctx.scopeIdStack && scopeInfo.elseScopeId) {
              ctx.scopeIdStack.pop(); // Remove if-scope
              ctx.scopeIdStack.push(scopeInfo.elseScopeId); // Push else-scope
            }

            // Exit if scope, enter else scope for semantic ID tracking
            if (ctx.scopeTracker) {
              ctx.scopeTracker.exitScope();
              ctx.scopeTracker.enterCountedScope('else');
            }
            scopeInfo.inElse = true;
          }
        }

        // Check if this block is the finalizer of a TryStatement
        if (t.isTryStatement(parent) && parent.finalizer === blockPath.node) {
          const scopeInfo = ctx.tryScopeMap.get(parent);
          if (scopeInfo && scopeInfo.finallyScopeId && scopeInfo.currentBlock !== 'finally') {
            // Pop current scope (try or catch), push finally scope
            if (ctx.scopeIdStack) {
              ctx.scopeIdStack.pop();
              ctx.scopeIdStack.push(scopeInfo.finallyScopeId);
            }

            // Exit current scope, enter finally scope for semantic ID tracking
            if (ctx.scopeTracker) {
              ctx.scopeTracker.exitScope();
              ctx.scopeTracker.enterCountedScope('finally');
            }
            scopeInfo.currentBlock = 'finally';
          }
        }
      }
    };
  }

  /**
   * REG-536: Create SCOPE nodes for switch/case bodies so that
   * nodes inside case clauses are connected to the main graph.
   *
   * Follows the same enter/exit pattern as LoopHandler:
   * - enter: create SCOPE, push onto scopeIdStack, enter scopeTracker
   * - exit: pop scopeIdStack, exit scopeTracker
   */
  private createSwitchCaseVisitor(): {
    enter: (casePath: NodePath<t.SwitchCase>) => void;
    exit: (casePath: NodePath<t.SwitchCase>) => void;
  } {
    const ctx = this.ctx;

    return {
      enter: (casePath: NodePath<t.SwitchCase>) => {
        const caseNode = casePath.node;

        // Skip empty cases (fall-through with no body)
        if (caseNode.consequent.length === 0) return;

        const caseId = ctx.switchCaseScopeMap.get(caseNode);
        if (!caseId) return;

        // Generate SCOPE id in parent context BEFORE entering child scope — matches LoopHandler pattern
        const scopeType = caseNode.test === null ? 'default-case' : 'switch-case';
        const scopeId = `SCOPE#${scopeType}#${ctx.module.file}#${getLine(caseNode)}:${ctx.scopeCounterRef.value++}`;
        const semanticId = generateSemanticId(scopeType, ctx.scopeTracker);

        // Buffer the SCOPE node with parentScopeId = caseId (CASE -> CONTAINS -> SCOPE)
        ctx.scopes.push({
          id: scopeId,
          type: 'SCOPE',
          scopeType,
          semanticId,
          file: ctx.module.file,
          line: getLine(caseNode),
          parentScopeId: caseId,
        });

        // Push onto stack so nested nodes get CONTAINS edges to this scope
        ctx.scopeIdStack.push(scopeId);

        // Enter child scope for nested nodes' semantic ID generation AFTER push — matches LoopHandler pattern
        const scopeLabel = caseNode.test === null ? 'default' : 'case';
        if (ctx.scopeTracker) {
          ctx.scopeTracker.enterCountedScope(scopeLabel);
        }
      },
      exit: (casePath: NodePath<t.SwitchCase>) => {
        const caseNode = casePath.node;

        // Only pop if we pushed (non-empty case with a mapping)
        if (caseNode.consequent.length === 0) return;
        if (!ctx.switchCaseScopeMap.has(caseNode)) return;

        // Pop scope from stack
        ctx.scopeIdStack.pop();

        // Exit scope for semantic ID tracking
        if (ctx.scopeTracker) {
          ctx.scopeTracker.exitScope();
        }

        // Clean up the mapping
        ctx.switchCaseScopeMap.delete(caseNode);
      }
    };
  }
}

/**
 * ControlFlowBuilder - buffers control flow graph nodes and edges.
 *
 * Handles: loops, branches, cases, try/catch/finally, discriminant expressions.
 */

import type {
  ModuleNode,
  LoopInfo,
  ScopeInfo,
  VariableDeclarationInfo,
  ParameterInfo,
  CallSiteInfo,
  BranchInfo,
  CaseInfo,
  TryBlockInfo,
  CatchBlockInfo,
  FinallyBlockInfo,
  ASTCollections,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

export class ControlFlowBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      scopes,
      variableDeclarations,
      callSites,
      loops = [],
      branches = [],
      cases = [],
      tryBlocks = [],
      catchBlocks = [],
      finallyBlocks = [],
      parameters = [],
    } = data;

    this.bufferLoopEdges(loops, scopes, variableDeclarations, parameters);
    this.bufferLoopConditionEdges(loops, callSites);
    this.bufferLoopConditionExpressions(loops);
    this.bufferBranchEdges(branches, callSites, scopes);
    this.bufferCaseEdges(cases);
    this.bufferTryCatchFinallyEdges(tryBlocks, catchBlocks, finallyBlocks);
    this.bufferDiscriminantExpressions(branches, callSites);
    // REG-533: DERIVES_FROM edges for EXPRESSION nodes in control flow
    this.bufferLoopTestDerivesFromEdges(loops, variableDeclarations, parameters);
    this.bufferLoopUpdateDerivesFromEdges(loops, variableDeclarations, parameters);
    this.bufferBranchDiscriminantDerivesFromEdges(branches, variableDeclarations, parameters);
  }

  /**
   * Buffer LOOP edges (CONTAINS, HAS_BODY, ITERATES_OVER)
   *
   * Creates edges for:
   * - Parent -> CONTAINS -> LOOP
   * - LOOP -> HAS_BODY -> body SCOPE
   * - LOOP -> ITERATES_OVER -> collection VARIABLE/PARAMETER (for for-in/for-of)
   *
   * Scope-aware variable lookup for ITERATES_OVER:
   * For for-of/for-in, finds the iterated variable preferring:
   * 1. Variables declared before the loop on same or earlier line (closest first)
   * 2. Parameters (function arguments)
   */
  private bufferLoopEdges(
    loops: LoopInfo[],
    scopes: ScopeInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const loop of loops) {
      // Parent -> CONTAINS -> LOOP
      if (loop.parentScopeId) {
        this.ctx.bufferEdge({
          type: 'CONTAINS',
          src: loop.parentScopeId,
          dst: loop.id
        });
      }

      // LOOP -> HAS_BODY -> body SCOPE
      // Find the body scope by matching parentScopeId to loop.id
      const bodyScope = scopes.find(s => s.parentScopeId === loop.id);
      if (bodyScope) {
        this.ctx.bufferEdge({
          type: 'HAS_BODY',
          src: loop.id,
          dst: bodyScope.id
        });
      }

      // LOOP -> ITERATES_OVER -> collection VARIABLE/PARAMETER (for for-in/for-of)
      if (loop.iteratesOverName && (loop.loopType === 'for-in' || loop.loopType === 'for-of')) {
        // For MemberExpression iterables (obj.items), extract base object
        const iterableName = loop.iteratesOverName.includes('.')
          ? loop.iteratesOverName.split('.')[0]
          : loop.iteratesOverName;

        // Scope-aware lookup: prefer parameters over variables
        // Parameters are function-local and shadow outer variables
        const param = parameters.find(p =>
          p.name === iterableName && p.file === loop.file
        );

        // Determine iteration type: for-in iterates keys, for-of iterates values
        const iterates = loop.loopType === 'for-in' ? 'keys' : 'values';

        if (param) {
          // Parameter found - most local binding
          this.ctx.bufferEdge({
            type: 'ITERATES_OVER',
            src: loop.id,
            dst: param.id,
            metadata: { iterates }
          });
        } else {
          // Find variable by name and line proximity (scope-aware heuristic)
          // Prefer variables declared before the loop in the same file
          const candidateVars = variableDeclarations.filter(v =>
            v.name === iterableName &&
            v.file === loop.file &&
            (v.line ?? 0) <= loop.line  // Declared before or on loop line
          );

          // Sort by line descending to find closest declaration
          candidateVars.sort((a, b) => (b.line ?? 0) - (a.line ?? 0));

          if (candidateVars.length > 0) {
            this.ctx.bufferEdge({
              type: 'ITERATES_OVER',
              src: loop.id,
              dst: candidateVars[0].id,
              metadata: { iterates }
            });
          }
        }
      }

      // REG-282: LOOP (for) -> HAS_INIT -> VARIABLE (let i = 0)
      if (loop.loopType === 'for' && loop.initVariableName && loop.initLine) {
        // Find the variable declared in the init on this line
        const initVar = variableDeclarations.find(v =>
          v.name === loop.initVariableName &&
          v.file === loop.file &&
          v.line === loop.initLine
        );
        if (initVar) {
          this.ctx.bufferEdge({
            type: 'HAS_INIT',
            src: loop.id,
            dst: initVar.id
          });
        }
      }

      // REG-282: LOOP -> HAS_CONDITION -> EXPRESSION (i < 10 or condition for while/do-while)
      if (loop.testExpressionId && loop.testExpressionType) {
        // Create EXPRESSION node for the test
        this.ctx.bufferNode({
          id: loop.testExpressionId,
          type: 'EXPRESSION',
          name: loop.testExpressionType,
          file: loop.file,
          line: loop.testLine,
          column: loop.testColumn,
          expressionType: loop.testExpressionType
        });

        this.ctx.bufferEdge({
          type: 'HAS_CONDITION',
          src: loop.id,
          dst: loop.testExpressionId
        });
      }

      // REG-282: LOOP (for) -> HAS_UPDATE -> EXPRESSION (i++)
      if (loop.loopType === 'for' && loop.updateExpressionId && loop.updateExpressionType) {
        // Create EXPRESSION node for the update
        this.ctx.bufferNode({
          id: loop.updateExpressionId,
          type: 'EXPRESSION',
          name: loop.updateExpressionType,
          file: loop.file,
          line: loop.updateLine,
          column: loop.updateColumn,
          expressionType: loop.updateExpressionType
        });

        this.ctx.bufferEdge({
          type: 'HAS_UPDATE',
          src: loop.id,
          dst: loop.updateExpressionId
        });
      }
    }
  }

  /**
   * Buffer HAS_CONDITION edges from LOOP to condition EXPRESSION/CALL nodes.
   * Also creates EXPRESSION nodes for non-CallExpression conditions.
   *
   * REG-280: For while/do-while/for loops, creates HAS_CONDITION edge to the
   * condition expression. For-in/for-of loops don't have conditions (use ITERATES_OVER).
   *
   * For CallExpression conditions, links to existing CALL_SITE node by coordinates.
   */
  private bufferLoopConditionEdges(loops: LoopInfo[], callSites: CallSiteInfo[]): void {
    for (const loop of loops) {
      // Skip for-in/for-of loops - they don't have test expressions
      if (loop.loopType === 'for-in' || loop.loopType === 'for-of') {
        continue;
      }

      // Skip if no condition (e.g., infinite for loop: for(;;))
      if (!loop.conditionExpressionId) {
        continue;
      }

      // LOOP -> HAS_CONDITION -> EXPRESSION/CALL
      let targetId = loop.conditionExpressionId;

      // For CallExpression conditions, look up the actual CALL_SITE by coordinates
      // because CALL_SITE uses semantic IDs that don't match the generated ID
      if (loop.conditionExpressionType === 'CallExpression' && loop.conditionLine && loop.conditionColumn !== undefined) {
        const callSite = callSites.find(cs =>
          cs.file === loop.file &&
          cs.line === loop.conditionLine &&
          cs.column === loop.conditionColumn
        );
        if (callSite) {
          targetId = callSite.id;
        }
      }

      this.ctx.bufferEdge({
        type: 'HAS_CONDITION',
        src: loop.id,
        dst: targetId
      });
    }
  }

  /**
   * Buffer EXPRESSION nodes for loop condition expressions (non-CallExpression).
   * Similar to bufferDiscriminantExpressions but for loops.
   *
   * REG-280: Creates EXPRESSION nodes for while/do-while/for loop conditions.
   * CallExpression conditions use existing CALL_SITE nodes (no EXPRESSION created).
   */
  private bufferLoopConditionExpressions(loops: LoopInfo[]): void {
    for (const loop of loops) {
      // Skip for-in/for-of loops - they don't have test expressions
      if (loop.loopType === 'for-in' || loop.loopType === 'for-of') {
        continue;
      }

      if (loop.conditionExpressionId && loop.conditionExpressionType) {
        // Skip CallExpression - we link to existing CALL_SITE in bufferLoopConditionEdges
        if (loop.conditionExpressionType === 'CallExpression') {
          continue;
        }

        // Only create if it looks like an EXPRESSION ID
        if (loop.conditionExpressionId.includes(':EXPRESSION:')) {
          this.ctx.bufferNode({
            id: loop.conditionExpressionId,
            type: 'EXPRESSION',
            name: loop.conditionExpressionType,
            file: loop.file,
            line: loop.conditionLine,
            column: loop.conditionColumn,
            expressionType: loop.conditionExpressionType
          });
        }
      }
    }
  }

  /**
   * Buffer BRANCH edges (CONTAINS, HAS_CONDITION, HAS_CONSEQUENT, HAS_ALTERNATE)
   *
   * REG-275: For CallExpression discriminants (switch(getType())), looks up the
   * actual CALL_SITE node by coordinates since the CALL_SITE uses semantic IDs.
   *
   * Phase 3 (REG-267): For if-branches, creates HAS_CONSEQUENT and HAS_ALTERNATE edges
   * pointing to the if-body and else-body SCOPEs.
   */
  private bufferBranchEdges(branches: BranchInfo[], callSites: CallSiteInfo[], scopes: ScopeInfo[]): void {
    for (const branch of branches) {
      // Parent SCOPE -> CONTAINS -> BRANCH
      if (branch.parentScopeId) {
        this.ctx.bufferEdge({
          type: 'CONTAINS',
          src: branch.parentScopeId,
          dst: branch.id
        });
      }

      // BRANCH -> HAS_CONDITION -> EXPRESSION/CALL (discriminant)
      if (branch.discriminantExpressionId) {
        let targetId = branch.discriminantExpressionId;

        // For CallExpression discriminants, look up the actual CALL_SITE by coordinates
        // because CALL_SITE uses semantic IDs that don't match the generated ID
        if (branch.discriminantExpressionType === 'CallExpression' && branch.discriminantLine && branch.discriminantColumn !== undefined) {
          const callSite = callSites.find(cs =>
            cs.file === branch.file &&
            cs.line === branch.discriminantLine &&
            cs.column === branch.discriminantColumn
          );
          if (callSite) {
            targetId = callSite.id;
          }
        }

        this.ctx.bufferEdge({
          type: 'HAS_CONDITION',
          src: branch.id,
          dst: targetId
        });
      }

      // Phase 3: For if-branches, create HAS_CONSEQUENT and HAS_ALTERNATE edges
      if (branch.branchType === 'if') {
        // Find consequent (if-body) scope - parentScopeId matches branch.id, scopeType is 'if_statement'
        const consequentScope = scopes.find(s =>
          s.parentScopeId === branch.id && s.scopeType === 'if_statement'
        );
        if (consequentScope) {
          this.ctx.bufferEdge({
            type: 'HAS_CONSEQUENT',
            src: branch.id,
            dst: consequentScope.id
          });
        }

        // Find alternate (else-body) scope - parentScopeId matches branch.id, scopeType is 'else_statement'
        const alternateScope = scopes.find(s =>
          s.parentScopeId === branch.id && s.scopeType === 'else_statement'
        );
        if (alternateScope) {
          this.ctx.bufferEdge({
            type: 'HAS_ALTERNATE',
            src: branch.id,
            dst: alternateScope.id
          });
        }

        // For else-if chains: if this branch is the alternate of another branch
        // This is handled differently - see below
      }

      // REG-287: For ternary branches, create HAS_CONSEQUENT and HAS_ALTERNATE edges to expressions
      if (branch.branchType === 'ternary') {
        if (branch.consequentExpressionId) {
          this.ctx.bufferEdge({
            type: 'HAS_CONSEQUENT',
            src: branch.id,
            dst: branch.consequentExpressionId
          });
        }
        if (branch.alternateExpressionId) {
          this.ctx.bufferEdge({
            type: 'HAS_ALTERNATE',
            src: branch.id,
            dst: branch.alternateExpressionId
          });
        }
      }

      // Phase 3: For else-if chains, create HAS_ALTERNATE from parent branch to this branch
      if (branch.isAlternateOfBranchId) {
        this.ctx.bufferEdge({
          type: 'HAS_ALTERNATE',
          src: branch.isAlternateOfBranchId,
          dst: branch.id
        });
      }
    }
  }

  /**
   * Buffer CASE edges (HAS_CASE, HAS_DEFAULT)
   */
  private bufferCaseEdges(cases: CaseInfo[]): void {
    for (const caseInfo of cases) {
      // BRANCH -> HAS_CASE or HAS_DEFAULT -> CASE
      const edgeType = caseInfo.isDefault ? 'HAS_DEFAULT' : 'HAS_CASE';
      this.ctx.bufferEdge({
        type: edgeType,
        src: caseInfo.parentBranchId,
        dst: caseInfo.id
      });
    }
  }

  /**
   * Buffer edges for TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK nodes (Phase 4)
   *
   * Creates edges for:
   * - Parent -> CONTAINS -> TRY_BLOCK
   * - TRY_BLOCK -> HAS_CATCH -> CATCH_BLOCK
   * - TRY_BLOCK -> HAS_FINALLY -> FINALLY_BLOCK
   */
  private bufferTryCatchFinallyEdges(
    tryBlocks: TryBlockInfo[],
    catchBlocks: CatchBlockInfo[],
    finallyBlocks: FinallyBlockInfo[]
  ): void {
    // Buffer TRY_BLOCK edges
    for (const tryBlock of tryBlocks) {
      // Parent -> CONTAINS -> TRY_BLOCK
      if (tryBlock.parentScopeId) {
        this.ctx.bufferEdge({
          type: 'CONTAINS',
          src: tryBlock.parentScopeId,
          dst: tryBlock.id
        });
      }
    }

    // Buffer CATCH_BLOCK edges (HAS_CATCH from TRY_BLOCK)
    for (const catchBlock of catchBlocks) {
      // TRY_BLOCK -> HAS_CATCH -> CATCH_BLOCK
      this.ctx.bufferEdge({
        type: 'HAS_CATCH',
        src: catchBlock.parentTryBlockId,
        dst: catchBlock.id
      });
    }

    // Buffer FINALLY_BLOCK edges (HAS_FINALLY from TRY_BLOCK)
    for (const finallyBlock of finallyBlocks) {
      // TRY_BLOCK -> HAS_FINALLY -> FINALLY_BLOCK
      this.ctx.bufferEdge({
        type: 'HAS_FINALLY',
        src: finallyBlock.parentTryBlockId,
        dst: finallyBlock.id
      });
    }
  }

  /**
   * Buffer EXPRESSION nodes for switch discriminants
   * Uses stored metadata directly instead of parsing from ID (Linus improvement)
   *
   * REG-275: For CallExpression discriminants, we don't create nodes here since
   * bufferBranchEdges links to the existing CALL_SITE node by coordinates.
   */
  private bufferDiscriminantExpressions(branches: BranchInfo[], _callSites: CallSiteInfo[]): void {
    for (const branch of branches) {
      if (branch.discriminantExpressionId && branch.discriminantExpressionType) {
        // Skip CallExpression - we link to existing CALL_SITE in bufferBranchEdges
        if (branch.discriminantExpressionType === 'CallExpression') {
          continue;
        }

        // Only create if it looks like an EXPRESSION ID
        if (branch.discriminantExpressionId.includes(':EXPRESSION:')) {
          this.ctx.bufferNode({
            id: branch.discriminantExpressionId,
            type: 'EXPRESSION',
            name: branch.discriminantExpressionType,
            file: branch.file,
            line: branch.discriminantLine,
            column: branch.discriminantColumn,
            expressionType: branch.discriminantExpressionType
          });
        }
      }
    }
  }

  /**
   * REG-533: Buffer DERIVES_FROM edges for loop test (condition) EXPRESSION nodes.
   *
   * Links EXPRESSION nodes for loop conditions (i < 10, !done, obj.active) to
   * the VARIABLE/PARAMETER nodes they derive from.
   * Follows the same pattern as ReturnBuilder.findSource.
   */
  private bufferLoopTestDerivesFromEdges(
    loops: LoopInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const loop of loops) {
      // Use conditionExpressionId (while/do-while) or testExpressionId (for)
      const expressionId = loop.conditionExpressionId || loop.testExpressionId;
      const expressionType = loop.conditionExpressionType || loop.testExpressionType;
      if (!expressionId || !expressionType) continue;
      // Skip CallExpression - linked to CALL_SITE, not EXPRESSION
      if (expressionType === 'CallExpression') continue;

      const file = loop.file;
      const findSource = (name: string): string | null => {
        const variable = variableDeclarations.find(v => v.name === name && v.file === file);
        if (variable) return variable.id;
        const param = parameters.find(p => p.name === name && p.file === file);
        if (param) return param.id;
        return null;
      };

      if (expressionType === 'Identifier' && loop.testObjectSourceName) {
        const sourceId = findSource(loop.testObjectSourceName);
        if (sourceId) {
          this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
        }
      }

      if (expressionType === 'MemberExpression' && loop.testObjectSourceName) {
        const sourceId = findSource(loop.testObjectSourceName);
        if (sourceId) {
          this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
        }
      }

      if (expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression') {
        if (loop.testLeftSourceName) {
          const sourceId = findSource(loop.testLeftSourceName);
          if (sourceId) {
            this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
          }
        }
        if (loop.testRightSourceName) {
          const sourceId = findSource(loop.testRightSourceName);
          if (sourceId) {
            this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
          }
        }
      }

      if (expressionType === 'ConditionalExpression') {
        if (loop.testConsequentSourceName) {
          const sourceId = findSource(loop.testConsequentSourceName);
          if (sourceId) {
            this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
          }
        }
        if (loop.testAlternateSourceName) {
          const sourceId = findSource(loop.testAlternateSourceName);
          if (sourceId) {
            this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
          }
        }
      }

      if (expressionType === 'UnaryExpression' && loop.testUnaryArgSourceName) {
        const sourceId = findSource(loop.testUnaryArgSourceName);
        if (sourceId) {
          this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
        }
      }

      if (expressionType === 'UpdateExpression' && loop.testUpdateArgSourceName) {
        const sourceId = findSource(loop.testUpdateArgSourceName);
        if (sourceId) {
          this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
        }
      }

      if (expressionType === 'TemplateLiteral' && loop.testExpressionSourceNames) {
        for (const sourceName of loop.testExpressionSourceNames) {
          const sourceId = findSource(sourceName);
          if (sourceId) {
            this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
          }
        }
      }
    }
  }

  /**
   * REG-533: Buffer DERIVES_FROM edges for loop update EXPRESSION nodes.
   *
   * Links EXPRESSION nodes for for-loop updates (i++) to the VARIABLE/PARAMETER
   * nodes they derive from.
   */
  private bufferLoopUpdateDerivesFromEdges(
    loops: LoopInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const loop of loops) {
      if (loop.loopType !== 'for') continue;
      if (!loop.updateExpressionId || !loop.updateExpressionType) continue;
      // Skip CallExpression - linked to CALL_SITE, not EXPRESSION
      if (loop.updateExpressionType === 'CallExpression') continue;

      const file = loop.file;
      const findSource = (name: string): string | null => {
        const variable = variableDeclarations.find(v => v.name === name && v.file === file);
        if (variable) return variable.id;
        const param = parameters.find(p => p.name === name && p.file === file);
        if (param) return param.id;
        return null;
      };

      if (loop.updateArgSourceName) {
        const sourceId = findSource(loop.updateArgSourceName);
        if (sourceId) {
          this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: loop.updateExpressionId, dst: sourceId });
        }
      }
    }
  }

  /**
   * REG-533: Buffer DERIVES_FROM edges for branch discriminant EXPRESSION nodes.
   *
   * Links EXPRESSION nodes for branch conditions (if(x), switch(action.type))
   * to the VARIABLE/PARAMETER nodes they derive from.
   */
  private bufferBranchDiscriminantDerivesFromEdges(
    branches: BranchInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const branch of branches) {
      if (!branch.discriminantExpressionId || !branch.discriminantExpressionType) continue;
      // Skip CallExpression - linked to CALL_SITE, not EXPRESSION
      if (branch.discriminantExpressionType === 'CallExpression') continue;

      const file = branch.file;
      const expressionId = branch.discriminantExpressionId;
      const expressionType = branch.discriminantExpressionType;

      const findSource = (name: string): string | null => {
        const variable = variableDeclarations.find(v => v.name === name && v.file === file);
        if (variable) return variable.id;
        const param = parameters.find(p => p.name === name && p.file === file);
        if (param) return param.id;
        return null;
      };

      if (expressionType === 'Identifier' && branch.discriminantObjectSourceName) {
        const sourceId = findSource(branch.discriminantObjectSourceName);
        if (sourceId) {
          this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
        }
      }

      if (expressionType === 'MemberExpression' && branch.discriminantObjectSourceName) {
        const sourceId = findSource(branch.discriminantObjectSourceName);
        if (sourceId) {
          this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
        }
      }

      if (expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression') {
        if (branch.discriminantLeftSourceName) {
          const sourceId = findSource(branch.discriminantLeftSourceName);
          if (sourceId) {
            this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
          }
        }
        if (branch.discriminantRightSourceName) {
          const sourceId = findSource(branch.discriminantRightSourceName);
          if (sourceId) {
            this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
          }
        }
      }

      if (expressionType === 'ConditionalExpression') {
        if (branch.discriminantConsequentSourceName) {
          const sourceId = findSource(branch.discriminantConsequentSourceName);
          if (sourceId) {
            this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
          }
        }
        if (branch.discriminantAlternateSourceName) {
          const sourceId = findSource(branch.discriminantAlternateSourceName);
          if (sourceId) {
            this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
          }
        }
      }

      if (expressionType === 'UnaryExpression' && branch.discriminantUnaryArgSourceName) {
        const sourceId = findSource(branch.discriminantUnaryArgSourceName);
        if (sourceId) {
          this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
        }
      }

      if (expressionType === 'TemplateLiteral' && branch.discriminantExpressionSourceNames) {
        for (const sourceName of branch.discriminantExpressionSourceNames) {
          const sourceId = findSource(sourceName);
          if (sourceId) {
            this.ctx.bufferEdge({ type: 'DERIVES_FROM', src: expressionId, dst: sourceId });
          }
        }
      }
    }
  }
}

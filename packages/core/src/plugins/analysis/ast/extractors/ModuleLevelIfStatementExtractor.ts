/**
 * ModuleLevelIfStatementExtractor — visitor for module-level IfStatement nodes.
 *
 * Extracted from JSASTAnalyzer.analyzeModule() (REG-460 step 10).
 */

import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { ConditionParser } from '../ConditionParser.js';
import { generateSemanticId as generateSemanticIdFn } from '../utils/semanticIdHelpers.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { VisitorModule } from '../visitors/index.js';
import type { ScopeInfo, CounterRef } from '../types.js';

interface ModuleLevelIfStatementContext {
  module: VisitorModule;
  scopeTracker: ScopeTracker;
  scopes: ScopeInfo[];
  ifScopeCounterRef: CounterRef;
  code: string;
}

export function createModuleLevelIfStatementVisitor(
  ctx: ModuleLevelIfStatementContext
): { IfStatement: (ifPath: NodePath<t.IfStatement>) => void } {
  return {
    IfStatement: (ifPath: NodePath<t.IfStatement>) => {
      const functionParent = ifPath.getFunctionParent();
      if (functionParent) return;

      const ifNode = ifPath.node;
      const condition = ctx.code.substring(ifNode.test.start!, ifNode.test.end!) || 'condition';
      const counterId = ctx.ifScopeCounterRef.value++;
      const ifScopeId = `SCOPE#if#${ctx.module.file}#${getLine(ifNode)}:${getColumn(ifNode)}:${counterId}`;

      const constraints = ConditionParser.parse(ifNode.test);
      const ifSemanticId = generateSemanticIdFn('if_statement', ctx.scopeTracker);

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
        parentScopeId: ctx.module.id
      });

      if (ifNode.alternate && ifNode.alternate.type !== 'IfStatement') {
        const elseCounterId = ctx.ifScopeCounterRef.value++;
        const elseScopeId = `SCOPE#else#${ctx.module.file}#${getLine(ifNode.alternate)}:${getColumn(ifNode.alternate)}:${elseCounterId}`;

        const negatedConstraints = constraints.length > 0 ? ConditionParser.negate(constraints) : undefined;
        const elseSemanticId = generateSemanticIdFn('else_statement', ctx.scopeTracker);

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
          parentScopeId: ctx.module.id
        });
      }
    }
  };
}

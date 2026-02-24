/**
 * ModuleLevelCallbackExtractor — visitor for module-level FunctionExpression
 * nodes that appear as arguments to CallExpressions (callbacks).
 *
 * Extracted from JSASTAnalyzer.analyzeModule() (REG-460 step 10).
 */

import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { generateAnonymousName as generateAnonymousNameFn } from '../utils/semanticIdHelpers.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { VisitorModule, VisitorCollections } from '../visitors/index.js';
import type { FunctionInfo, ScopeInfo } from '../types.js';

interface ModuleLevelCallbackContext {
  module: VisitorModule;
  scopeTracker: ScopeTracker;
  functions: FunctionInfo[];
  scopes: ScopeInfo[];
  allCollections: VisitorCollections;
  analyzeFunctionBody: (
    funcPath: NodePath<t.Function | t.StaticBlock>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections,
  ) => void;
}

export function createModuleLevelCallbackVisitor(
  ctx: ModuleLevelCallbackContext
): { FunctionExpression: (funcPath: NodePath<t.FunctionExpression>) => void } {
  return {
    FunctionExpression: (funcPath: NodePath<t.FunctionExpression>) => {
      const funcNode = funcPath.node;
      const functionParent = funcPath.getFunctionParent();
      if (functionParent) return;

      if (funcPath.parent && funcPath.parent.type === 'CallExpression') {
        const funcName = funcNode.id ? funcNode.id.name : generateAnonymousNameFn(ctx.scopeTracker);
        // Use semantic ID as primary ID (matching FunctionVisitor pattern)
        const functionId = computeSemanticId('FUNCTION', funcName, ctx.scopeTracker.getContext());

        ctx.functions.push({
          id: functionId,
          type: 'FUNCTION',
          name: funcName,
          file: ctx.module.file,
          line: getLine(funcNode),
          column: getColumn(funcNode),
          async: funcNode.async || false,
          generator: funcNode.generator || false,
          isCallback: true,
          parentScopeId: ctx.module.id
        });

        const callbackScopeId = `SCOPE#${funcName}:body#${ctx.module.file}#${getLine(funcNode)}`;
        ctx.scopes.push({
          id: callbackScopeId,
          type: 'SCOPE',
          scopeType: 'callback_body',
          name: `${funcName}:body`,
          semanticId: `${funcName}:callback_body[0]`,
          conditional: false,
          file: ctx.module.file,
          line: getLine(funcNode),
          parentFunctionId: functionId
        });

        // Enter callback scope for semantic ID generation and analyze
        ctx.scopeTracker.enterScope(funcName, 'callback');
        ctx.analyzeFunctionBody(funcPath, callbackScopeId, ctx.module, ctx.allCollections);
        ctx.scopeTracker.exitScope();
        funcPath.skip();
      }
    }
  };
}

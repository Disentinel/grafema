/**
 * AnalyzerDelegate — interface capturing JSASTAnalyzer methods
 * called from within the analyzeFunctionBody() traverse block.
 *
 * During the handler extraction refactoring (REG-422), extracted handler
 * classes call these methods on the delegate instead of `this`. The delegate
 * is the JSASTAnalyzer instance itself (it implements this interface).
 *
 * REG-460: generateSemanticId and generateAnonymousName extracted to
 * ast/utils/semanticIdHelpers.ts as free functions.
 * REG-460 step 10: extractVariableNamesFromPattern removed — callers use
 * extractNamesFromPattern free function directly.
 */
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import type { VisitorModule, VisitorCollections } from '../visitors/index.js';

export interface AnalyzerDelegate {
  // --- Recursive analysis ---

  analyzeFunctionBody(
    funcPath: NodePath<t.Function | t.StaticBlock>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections,
  ): void;
}

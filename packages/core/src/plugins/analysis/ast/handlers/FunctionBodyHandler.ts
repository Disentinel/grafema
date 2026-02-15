/**
 * FunctionBodyHandler — abstract base class for all extracted
 * analyzeFunctionBody() visitor handlers.
 *
 * Each subclass implements getHandlers() returning a Babel Visitor
 * fragment that covers a specific AST node type (e.g., VariableDeclaration,
 * ReturnStatement, CallExpression).
 *
 * Handlers receive:
 * - ctx: FunctionBodyContext with all local state for the traversal
 * - analyzer: AnalyzerDelegate to call methods still on JSASTAnalyzer
 */
import type { Visitor } from '@babel/traverse';
import type { FunctionBodyContext } from '../FunctionBodyContext.js';
import type { AnalyzerDelegate } from './AnalyzerDelegate.js';

export abstract class FunctionBodyHandler {
  constructor(
    protected readonly ctx: FunctionBodyContext,
    protected readonly analyzer: AnalyzerDelegate,
  ) {}

  abstract getHandlers(): Visitor;
}

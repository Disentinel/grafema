/**
 * NestedFunctionHandler — handles FunctionDeclaration, FunctionExpression,
 * and ArrowFunctionExpression nodes found inside a function body.
 *
 * Mechanical extraction from analyzeFunctionBody() (REG-422).
 * Original source: JSASTAnalyzer.ts lines ~4108-4285.
 */
import type { Visitor, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { generateSemanticId, generateAnonymousName } from '../utils/semanticIdHelpers.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';

export class NestedFunctionHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    const ctx = this.ctx;
    const analyzer = this.analyzer;

    return {
      FunctionDeclaration: (funcDeclPath: NodePath<t.FunctionDeclaration>) => {
        const node = funcDeclPath.node;
        const funcName = node.id ? node.id.name : generateAnonymousName(ctx.scopeTracker);
        // Use semantic ID as primary ID when scopeTracker available
        const legacyId = `FUNCTION#${funcName}#${ctx.module.file}#${getLine(node)}:${getColumn(node)}:${ctx.functionCounterRef.value++}`;
        const functionId = ctx.scopeTracker
          ? computeSemanticId('FUNCTION', funcName, ctx.scopeTracker.getContext())
          : legacyId;

        ctx.functions.push({
          id: functionId,
          type: 'FUNCTION',
          name: funcName,
          file: ctx.module.file,
          line: getLine(node),
          column: getColumn(node),
          async: node.async || false,
          generator: node.generator || false,
          parentScopeId: ctx.parentScopeId
        });

        const nestedScopeId = `SCOPE#${funcName}:body#${ctx.module.file}#${getLine(node)}`;
        const closureSemanticId = generateSemanticId('closure', ctx.scopeTracker);
        ctx.scopes.push({
          id: nestedScopeId,
          type: 'SCOPE',
          scopeType: 'closure',
          name: `${funcName}:body`,
          semanticId: closureSemanticId,
          conditional: false,
          file: ctx.module.file,
          line: getLine(node),
          parentFunctionId: functionId,
          capturesFrom: ctx.parentScopeId
        });

        // Enter nested function scope for semantic ID generation
        if (ctx.scopeTracker) {
          ctx.scopeTracker.enterScope(funcName, 'function');
        }
        analyzer.analyzeFunctionBody(funcDeclPath, nestedScopeId, ctx.module, ctx.collections);
        if (ctx.scopeTracker) {
          ctx.scopeTracker.exitScope();
        }
        funcDeclPath.skip();
      },

      FunctionExpression: (funcPath: NodePath<t.FunctionExpression>) => {
        const node = funcPath.node;
        const funcName = node.id ? node.id.name : generateAnonymousName(ctx.scopeTracker);
        // Use semantic ID as primary ID when scopeTracker available
        const legacyId = `FUNCTION#${funcName}#${ctx.module.file}#${getLine(node)}:${getColumn(node)}:${ctx.functionCounterRef.value++}`;
        const functionId = ctx.scopeTracker
          ? computeSemanticId('FUNCTION', funcName, ctx.scopeTracker.getContext())
          : legacyId;

        ctx.functions.push({
          id: functionId,
          type: 'FUNCTION',
          name: funcName,
          file: ctx.module.file,
          line: getLine(node),
          column: getColumn(node),
          async: node.async || false,
          generator: node.generator || false,
          parentScopeId: ctx.parentScopeId
        });

        const nestedScopeId = `SCOPE#${funcName}:body#${ctx.module.file}#${getLine(node)}`;
        const closureSemanticId = generateSemanticId('closure', ctx.scopeTracker);
        ctx.scopes.push({
          id: nestedScopeId,
          type: 'SCOPE',
          scopeType: 'closure',
          name: `${funcName}:body`,
          semanticId: closureSemanticId,
          conditional: false,
          file: ctx.module.file,
          line: getLine(node),
          parentFunctionId: functionId,
          capturesFrom: ctx.parentScopeId
        });

        // Enter nested function scope for semantic ID generation
        if (ctx.scopeTracker) {
          ctx.scopeTracker.enterScope(funcName, 'function');
        }
        analyzer.analyzeFunctionBody(funcPath, nestedScopeId, ctx.module, ctx.collections);
        if (ctx.scopeTracker) {
          ctx.scopeTracker.exitScope();
        }
        funcPath.skip();
      },

      ArrowFunctionExpression: (arrowPath: NodePath<t.ArrowFunctionExpression>) => {
        const node = arrowPath.node;
        const line = getLine(node);
        const column = getColumn(node);

        // Determine name (anonymous if not assigned to variable)
        const parent = arrowPath.parent;
        let funcName: string;
        if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
          funcName = parent.id.name;
        } else {
          // Use scope-level counter for stable semanticId
          funcName = generateAnonymousName(ctx.scopeTracker);
        }

        // Use semantic ID as primary ID when scopeTracker available
        const legacyId = `FUNCTION#${funcName}:${line}:${column}:${ctx.functionCounterRef.value++}`;
        const functionId = ctx.scopeTracker
          ? computeSemanticId('FUNCTION', funcName, ctx.scopeTracker.getContext())
          : legacyId;

        ctx.functions.push({
          id: functionId,
          type: 'FUNCTION',
          name: funcName,
          file: ctx.module.file,
          line,
          column,
          async: node.async || false,
          arrowFunction: true,
          parentScopeId: ctx.parentScopeId
        });

        const nestedScopeId = `SCOPE#${funcName}:body#${ctx.module.file}#${line}`;
        const arrowSemanticId = generateSemanticId('arrow_body', ctx.scopeTracker);
        ctx.scopes.push({
          id: nestedScopeId,
          type: 'SCOPE',
          scopeType: 'arrow_body',
          name: `${funcName}:body`,
          semanticId: arrowSemanticId,
          conditional: false,
          file: ctx.module.file,
          line,
          parentFunctionId: functionId,
          capturesFrom: ctx.parentScopeId
        });

        // Enter arrow function scope for semantic ID generation
        if (ctx.scopeTracker) {
          ctx.scopeTracker.enterScope(funcName, 'arrow');
        }
        // analyzeFunctionBody handles both block and expression bodies:
        // - Block body: traverses all statements, extracts calls/vars/returns
        // - Expression body: extracts implicit return AND traverses inner expressions
        //   (e.g., `x => setTimeout(x, 100)` — extracts the setTimeout CALL + LITERAL 100)
        analyzer.analyzeFunctionBody(arrowPath, nestedScopeId, ctx.module, ctx.collections);
        if (ctx.scopeTracker) {
          ctx.scopeTracker.exitScope();
        }

        arrowPath.skip();
      },
    };
  }
}

/**
 * LiteralHandler — creates LITERAL nodes for every literal in the AST.
 *
 * Every literal in the source must become a LITERAL node: conditions,
 * comparisons, default params, destructuring, loop bounds, etc.
 *
 * Existing extractors (trackVariableAssignment, ArgumentExtractor,
 * ReturnExpressionExtractor) already create LITERAL nodes in specific
 * contexts. This handler covers ALL remaining contexts universally.
 *
 * Position-based dedup prevents double-counting: if a literal at a given
 * line:column already has a LITERAL node, this handler skips it.
 */
import type { Visitor, NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';
import type { LiteralInfo, CounterRef } from '../types.js';

export class LiteralHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    const ctx = this.ctx;

    return {
      // Visit all literal types. Babel uses enter() by default.
      'StringLiteral|NumericLiteral|BooleanLiteral|NullLiteral|RegExpLiteral|BigIntLiteral': (
        path: NodePath
      ) => {
        createLiteralIfNew(path.node, ctx.module, ctx.literals, ctx.literalCounterRef);
      },

      // TemplateLiteral without expressions is a simple string literal
      TemplateLiteral: (path: NodePath) => {
        const node = path.node as t.TemplateLiteral;
        if (node.expressions.length === 0) {
          createLiteralIfNew(node, ctx.module, ctx.literals, ctx.literalCounterRef);
        }
      },
    };
  }
}

/**
 * Create a LITERAL node if one doesn't already exist at this position.
 * Uses the literals array to check for existing entries by line:column.
 */
function createLiteralIfNew(
  node: t.Node,
  module: { file: string },
  literals: LiteralInfo[],
  literalCounterRef: CounterRef
): void {
  const line = getLine(node);
  const column = getColumn(node);
  if (!line) return;

  // Check if a LITERAL already exists at this position (scan recent entries)
  for (let i = literals.length - 1; i >= 0 && i >= literals.length - 50; i--) {
    const existing = literals[i];
    if (existing.line === line && existing.column === column && existing.file === module.file) {
      return; // Already created by a specific extractor
    }
  }

  const literalValue = ExpressionEvaluator.extractLiteralValue(node);
  // For NullLiteral, extractLiteralValue returns null (same as "not a literal")
  if (literalValue === null && node.type !== 'NullLiteral') return;

  const literalId = `LITERAL#${line}:${column}:${literalCounterRef.value++}#${module.file}`;
  literals.push({
    id: literalId,
    type: 'LITERAL',
    value: literalValue,
    valueType: typeof literalValue,
    file: module.file,
    line,
    column,
  });
}

/**
 * Create a module-level literal visitor for use in extractModuleCollections.
 * Same logic as LiteralHandler but as a standalone visitor factory.
 */
export function createModuleLevelLiteralVisitor(
  module: { file: string },
  literals: LiteralInfo[],
  literalCounterRef: CounterRef
): Record<string, (path: NodePath) => void> {
  return {
    'StringLiteral|NumericLiteral|BooleanLiteral|NullLiteral|RegExpLiteral|BigIntLiteral': (
      path: NodePath
    ) => {
      // Skip if inside a function — analyzeFunctionBody's LiteralHandler handles those
      if (path.getFunctionParent()) return;
      createLiteralIfNew(path.node, module, literals, literalCounterRef);
    },

    TemplateLiteral: (path: NodePath) => {
      if (path.getFunctionParent()) return;
      const node = path.node as t.TemplateLiteral;
      if (node.expressions.length === 0) {
        createLiteralIfNew(node, module, literals, literalCounterRef);
      }
    },
  };
}

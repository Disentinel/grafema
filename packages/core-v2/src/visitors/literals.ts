/**
 * Visitors for literal AST nodes.
 *
 * StringLiteral, NumericLiteral, BooleanLiteral, NullLiteral,
 * BigIntLiteral, RegExpLiteral, TemplateLiteral
 */
import type {
  BigIntLiteral,
  BooleanLiteral,
  Node,
  NumericLiteral,
  RegExpLiteral,
  StringLiteral,
  TemplateLiteral,
} from '@babel/types';
import type { VisitResult, WalkContext } from '../types.js';

// ─── Utility: extract value from literal node ────────────────────────

export function isLiteralNode(node: Node): boolean {
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'RegExpLiteral':
      return true;
    case 'TemplateLiteral':
      return (node as TemplateLiteral).expressions.length === 0;
    default:
      return false;
  }
}

export function extractLiteralValue(node: Node): unknown {
  switch (node.type) {
    case 'StringLiteral': return (node as StringLiteral).value;
    case 'NumericLiteral': return (node as NumericLiteral).value;
    case 'BooleanLiteral': return (node as BooleanLiteral).value;
    case 'NullLiteral': return null;
    case 'BigIntLiteral': return (node as BigIntLiteral).value;
    case 'RegExpLiteral': {
      const re = node as RegExpLiteral;
      return `/${re.pattern}/${re.flags}`;
    }
    case 'TemplateLiteral': {
      const tl = node as TemplateLiteral;
      if (tl.expressions.length === 0 && tl.quasis.length === 1) {
        return tl.quasis[0].value.cooked ?? tl.quasis[0].value.raw;
      }
      return undefined;
    }
    default: return undefined;
  }
}

// ─── Visitor factory for all literal types ───────────────────────────

function makeLiteralVisitor(extractValue: (n: Node) => unknown) {
  return function visitLiteral(node: Node, _parent: Node | null, ctx: WalkContext): VisitResult {
    const value = extractValue(node);
    const line = node.loc?.start.line ?? 0;
    const column = node.loc?.start.column ?? 0;
    const name = value === null ? 'null' : String(value);

    const nodeId = ctx.nodeId('LITERAL', name, line);

    return {
      nodes: [{
        id: nodeId,
        type: 'LITERAL',
        name,
        file: ctx.file,
        line,
        column,
        metadata: { value, valueType: value === null ? 'null' : typeof value },
      }],
      edges: [],
      deferred: [],
    };
  };
}

// ─── Exported visitors ───────────────────────────────────────────────

export const visitStringLiteral = makeLiteralVisitor(
  n => (n as StringLiteral).value,
);

export const visitNumericLiteral = makeLiteralVisitor(
  n => (n as NumericLiteral).value,
);

export const visitBooleanLiteral = makeLiteralVisitor(
  n => (n as BooleanLiteral).value,
);

export const visitNullLiteral = makeLiteralVisitor(() => null);

export const visitBigIntLiteral = makeLiteralVisitor(
  n => (n as BigIntLiteral).value,
);

export const visitRegExpLiteral = makeLiteralVisitor(n => {
  const re = n as RegExpLiteral;
  return `/${re.pattern}/${re.flags}`;
});

export function visitTemplateLiteral(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const tl = node as TemplateLiteral;
  // Only create LITERAL for simple template strings (no expressions)
  if (tl.expressions.length === 0 && tl.quasis.length === 1) {
    const value = tl.quasis[0].value.cooked ?? tl.quasis[0].value.raw;
    const line = node.loc?.start.line ?? 0;
    const column = node.loc?.start.column ?? 0;
    const nodeId = ctx.nodeId('LITERAL', String(value), line);
    return {
      nodes: [{
        id: nodeId,
        type: 'LITERAL',
        name: String(value),
        file: ctx.file,
        line,
        column,
        metadata: { value, valueType: 'string' },
      }],
      edges: [],
      deferred: [],
    };
  }
  // Template with expressions — EXPRESSION node, children visited separately
  return {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', 'template', node.loc?.start.line ?? 0),
      type: 'EXPRESSION',
      name: 'template',
      file: ctx.file,
      line: node.loc?.start.line ?? 0,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

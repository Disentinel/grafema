/**
 * Visitors for statement AST nodes.
 *
 * IfStatement, ForStatement, WhileStatement, TryStatement,
 * ReturnStatement, ThrowStatement, SwitchStatement, etc.
 */
import type {
  CatchClause,
  ForInStatement,
  ForOfStatement,
  IfStatement,
  LabeledStatement,
  Node,
  ReturnStatement,
  SwitchCase,
  ThrowStatement,
  TryStatement,
  WithStatement,
} from '@babel/types';
import type { DeferredRef, VisitResult, WalkContext } from '../types.js';
import { EMPTY_RESULT } from '../types.js';

// ─── IfStatement ─────────────────────────────────────────────────────

export function visitIfStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('BRANCH', 'if', line),
      type: 'BRANCH',
      name: 'if',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

// ─── ForStatement ────────────────────────────────────────────────────

export function visitForStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('LOOP', 'for', line);
  ctx.pushScope('block', `${nodeId}$scope`);
  return {
    nodes: [{
      id: nodeId,
      type: 'LOOP',
      name: 'for',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { loopType: 'for' },
    }],
    edges: [],
    deferred: [],
  };
}

// ─── ForInStatement ──────────────────────────────────────────────────

export function visitForInStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const fi = node as ForInStatement;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('LOOP', 'for-in', line);
  ctx.pushScope('block', `${nodeId}$scope`);
  const deferred: DeferredRef[] = [];
  // Pre-declared loop variable: `for (key in obj)` — MODIFIES the variable
  if (fi.left.type === 'Identifier') {
    deferred.push({
      kind: 'scope_lookup',
      name: fi.left.name,
      fromNodeId: nodeId,
      edgeType: 'MODIFIES',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    });
  }
  return {
    nodes: [{
      id: nodeId,
      type: 'LOOP',
      name: 'for-in',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { loopType: 'for-in' },
    }],
    edges: [],
    deferred,
  };
}

// ─── ForOfStatement ──────────────────────────────────────────────────

export function visitForOfStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const fo = node as ForOfStatement;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('LOOP', 'for-of', line);
  ctx.pushScope('block', `${nodeId}$scope`);
  const deferred: DeferredRef[] = [];
  // Pre-declared loop variable: `for (item of items)` — MODIFIES the variable
  if (fo.left.type === 'Identifier') {
    deferred.push({
      kind: 'scope_lookup',
      name: fo.left.name,
      fromNodeId: nodeId,
      edgeType: 'MODIFIES',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    });
  }
  return {
    nodes: [{
      id: nodeId,
      type: 'LOOP',
      name: 'for-of',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { loopType: 'for-of', await: fo.await },
    }],
    edges: [],
    deferred,
  };
}

// ─── WhileStatement ──────────────────────────────────────────────────

export function visitWhileStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('LOOP', 'while', line),
      type: 'LOOP',
      name: 'while',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { loopType: 'while' },
    }],
    edges: [],
    deferred: [],
  };
}

// ─── DoWhileStatement ────────────────────────────────────────────────

export function visitDoWhileStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('LOOP', 'do-while', line),
      type: 'LOOP',
      name: 'do-while',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { loopType: 'do-while' },
    }],
    edges: [],
    deferred: [],
  };
}

// ─── SwitchStatement / SwitchCase ────────────────────────────────────

export function visitSwitchStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('BRANCH', 'switch', line),
      type: 'BRANCH',
      name: 'switch',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitSwitchCase(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const sc = node as SwitchCase;
  const line = node.loc?.start.line ?? 0;
  const name = sc.test ? 'case' : 'default';
  return {
    nodes: [{
      id: ctx.nodeId('CASE', name, line),
      type: 'CASE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

// ─── TryStatement / CatchClause ──────────────────────────────────────

export function visitTryStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TRY_BLOCK', 'try', line),
      type: 'TRY_BLOCK',
      name: 'try',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitCatchClause(
  node: Node, parent: Node | null, ctx: WalkContext,
): VisitResult {
  const cc = node as CatchClause;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('CATCH_BLOCK', 'catch', line);

  ctx.pushScope('catch', `${nodeId}$scope`);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'CATCH_BLOCK',
      name: 'catch',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };

  // CATCHES_FROM: catch block → try block (reverse of HAS_CATCH)
  if (parent?.type === 'TryStatement') {
    const tryLine = parent.loc?.start.line ?? 0;
    const tryNodeId = ctx.nodeId('TRY_BLOCK', 'try', tryLine);
    result.edges.push({ src: nodeId, dst: tryNodeId, type: 'CATCHES_FROM' });
  }

  // Catch parameter → PARAMETER node
  if (cc.param?.type === 'Identifier') {
    const paramName = cc.param.name;
    const paramLine = cc.param.loc?.start.line ?? line;
    const paramId = ctx.nodeId('PARAMETER', paramName, paramLine);
    result.nodes.push({
      id: paramId,
      type: 'PARAMETER',
      name: paramName,
      file: ctx.file,
      line: paramLine,
      column: cc.param.loc?.start.column ?? 0,
    });
    result.edges.push({ src: nodeId, dst: paramId, type: 'CONTAINS' });
    ctx.declare(paramName, 'catch', paramId);
  }

  return result;
}

// ─── ReturnStatement ─────────────────────────────────────────────────
// Passthrough for the node itself. EDGE_MAP routes ReturnStatement.argument → RETURNS
// from enclosingFunction. For Identifier arguments (which produce no node), we create
// an explicit deferred so the RETURNS edge still gets created.

export function visitReturnStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const ret = node as ReturnStatement;
  if (ret.argument?.type === 'Identifier') {
    const fnStack = (ctx as unknown as { _functionStack?: string[] })._functionStack;
    const enclosingFn = fnStack?.length ? fnStack[fnStack.length - 1] : '';
    return {
      nodes: [],
      edges: [],
      deferred: [{
        kind: 'scope_lookup',
        name: ret.argument.name,
        fromNodeId: enclosingFn,
        edgeType: 'RETURNS',
        scopeId: ctx.currentScope.id,
        file: ctx.file,
        line: node.loc?.start.line ?? 0,
        column: node.loc?.start.column ?? 0,
      }],
    };
  }
  return EMPTY_RESULT;
}

// ─── ThrowStatement ──────────────────────────────────────────────────
// Passthrough for the node itself. EDGE_MAP routes ThrowStatement.argument → THROWS.
// For Identifier arguments, create explicit deferred.

export function visitThrowStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const thr = node as ThrowStatement;
  if (thr.argument.type === 'Identifier') {
    return {
      nodes: [],
      edges: [],
      deferred: [{
        kind: 'scope_lookup',
        name: thr.argument.name,
        fromNodeId: '', // walk engine fills with parentNodeId
        edgeType: 'THROWS',
        scopeId: ctx.currentScope.id,
        file: ctx.file,
        line: node.loc?.start.line ?? 0,
        column: node.loc?.start.column ?? 0,
      }],
    };
  }
  return EMPTY_RESULT;
}

// ─── Passthrough statements (no graph nodes) ─────────────────────────

export function visitBlockStatement(
  node: Node, parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;

  // TryStatement.finalizer → produce FINALLY_BLOCK node
  if (parent?.type === 'TryStatement'
      && (parent as TryStatement).finalizer === node) {
    const nodeId = ctx.nodeId('FINALLY_BLOCK', 'finally', line);
    ctx.pushScope('block', `${nodeId}$scope`);
    return {
      nodes: [{
        id: nodeId,
        type: 'FINALLY_BLOCK',
        name: 'finally',
        file: ctx.file,
        line,
        column: node.loc?.start.column ?? 0,
      }],
      edges: [],
      deferred: [],
    };
  }

  // IfStatement.alternate (else block, not else-if) → produce BRANCH node
  if (parent?.type === 'IfStatement'
      && (parent as IfStatement).alternate === node) {
    const nodeId = ctx.nodeId('BRANCH', 'else', line);
    ctx.pushScope('block', `${nodeId}$scope`);
    return {
      nodes: [{
        id: nodeId,
        type: 'BRANCH',
        name: 'else',
        file: ctx.file,
        line,
        column: node.loc?.start.column ?? 0,
      }],
      edges: [],
      deferred: [],
    };
  }

  // Standalone block { ... } → produce SCOPE node
  // (Skip for blocks owned by control structures — they're already represented)
  const CONTROL_PARENTS = new Set([
    'IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
    'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'WithStatement',
    'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
    'ClassMethod', 'ClassPrivateMethod', 'ObjectMethod',
    'TryStatement', 'CatchClause', 'StaticBlock', 'LabeledStatement',
  ]);
  const isStandalone = !parent || !CONTROL_PARENTS.has(parent.type);

  if (isStandalone) {
    const nodeId = ctx.nodeId('SCOPE', 'block', line);
    ctx.pushScope('block', nodeId);
    return {
      nodes: [{
        id: nodeId,
        type: 'SCOPE',
        name: 'block',
        file: ctx.file,
        line,
        column: node.loc?.start.column ?? 0,
      }],
      edges: [],
      deferred: [],
    };
  }

  // Block owned by control structure — just scope, no node
  ctx.pushScope('block', ctx.nodeId('SCOPE', 'block', line));
  return EMPTY_RESULT;
}

export function visitExpressionStatement(
  _node: Node, _parent: Node | null, _ctx: WalkContext,
): VisitResult {
  return EMPTY_RESULT;
}

export function visitEmptyStatement(
  _node: Node, _parent: Node | null, _ctx: WalkContext,
): VisitResult {
  return EMPTY_RESULT;
}

export function visitDebuggerStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('SIDE_EFFECT', 'debugger', line),
      type: 'SIDE_EFFECT',
      name: 'debugger',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitBreakStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', 'break', line),
      type: 'EXPRESSION',
      name: 'break',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitContinueStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', 'continue', line),
      type: 'EXPRESSION',
      name: 'continue',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitLabeledStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const labeled = node as LabeledStatement;
  const name = labeled.label.name;
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('LABEL', name, line),
      type: 'LABEL',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitWithStatement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const ws = node as WithStatement;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('EXPRESSION', 'with', line);

  // Capture parent scope BEFORE pushing with-scope (with-scope returns 'ambiguous')
  const parentScopeId = ctx.currentScope.id;

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'EXPRESSION',
      name: 'with',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };

  // Capture parent scope BEFORE pushing with-scope (with-scope returns 'ambiguous')
  // EXTENDS_SCOPE_WITH: with(obj) → scope extends with obj
  if (ws.object.type === 'Identifier') {
    result.deferred.push({
      kind: 'scope_lookup',
      name: ws.object.name,
      fromNodeId: nodeId,
      edgeType: 'EXTENDS_SCOPE_WITH',
      scopeId: parentScopeId,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    });
  }

  const scope = ctx.pushScope('with', `${nodeId}$scope`);
  scope.withObjectId = nodeId;

  return result;
}

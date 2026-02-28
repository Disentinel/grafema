/**
 * Visitors for declaration AST nodes.
 *
 * VariableDeclaration, VariableDeclarator,
 * FunctionDeclaration, ClassDeclaration
 */
import type {
  ClassDeclaration,
  FunctionDeclaration,
  Node,
  VariableDeclaration,
  VariableDeclarator,
} from '@babel/types';
import type { VisitResult, WalkContext } from '../types.js';
import { EMPTY_RESULT, paramTypeRefInfo } from '../types.js';
import { isLiteralNode } from './literals.js';

// ─── VariableDeclaration ─────────────────────────────────────────────

/**
 * `const x = 1, y = 2` — container node, no graph node.
 * Children (VariableDeclarators) produce the actual nodes.
 */
export function visitVariableDeclaration(
  _node: Node, _parent: Node | null, _ctx: WalkContext,
): VisitResult {
  // No graph node for the declaration itself.
  // VariableDeclarators are children and will be visited.
  return EMPTY_RESULT;
}

// ─── VariableDeclarator ──────────────────────────────────────────────

/**
 * `x = 1` (inside const/let/var)
 *
 * Creates: VARIABLE or CONSTANT node
 * Edges: ASSIGNED_FROM (deferred scope_lookup if rhs is identifier)
 * Scope: declares name in current scope
 */
export function visitVariableDeclarator(
  node: Node, parent: Node | null, ctx: WalkContext,
): VisitResult {
  const decl = node as VariableDeclarator;
  const varDecl = parent as VariableDeclaration | null;
  const kind = varDecl?.kind ?? 'let';

  // Only handle simple identifiers for now (destructuring = separate visitor)
  if (decl.id.type !== 'Identifier') return EMPTY_RESULT;

  const name = decl.id.name;
  const line = decl.loc?.start.line ?? 0;
  const column = decl.loc?.start.column ?? 0;

  // Determine node type: CONSTANT for const + literal, VARIABLE otherwise
  const isConst = kind === 'const';
  const initIsLiteral = decl.init ? isLiteralNode(decl.init) : false;
  const nodeType = isConst && initIsLiteral ? 'CONSTANT' : 'VARIABLE';

  const nodeId = ctx.nodeId(nodeType, name, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: nodeType,
      name,
      file: ctx.file,
      line,
      column,
      metadata: { kind },
    }],
    edges: [],
    deferred: [],
  };

  // Register in scope — returns shadowed nodeId if any
  const shadowedId = ctx.declare(name, kind as 'var' | 'let' | 'const', nodeId);
  if (shadowedId) {
    result.edges.push({ src: nodeId, dst: shadowedId, type: 'SHADOWS' });
  }

  // ASSIGNED_FROM for literal inits: walk engine creates edge via EDGE_MAP
  // (VariableDeclarator.init → ASSIGNED_FROM). Literal visitor creates the LITERAL node.
  // For identifier inits: deferred scope_lookup creates the edge.
  if (decl.init?.type === 'Identifier') {
    // Deferred: `const x = y` — need scope lookup for y
    result.deferred.push({
      kind: 'scope_lookup',
      name: decl.init.name,
      fromNodeId: nodeId,
      edgeType: 'ASSIGNED_FROM',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column,
    });
    // ALIASES: `const y = x` means y is an alias for x
    result.deferred.push({
      kind: 'scope_lookup',
      name: decl.init.name,
      fromNodeId: nodeId,
      edgeType: 'ALIASES',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column,
    });
  }

  return result;
}

// ─── FunctionDeclaration ─────────────────────────────────────────────

/**
 * `function foo(a, b) { ... }`
 *
 * Creates: FUNCTION node + PARAMETER nodes
 * Edges: CONTAINS (func → params), HAS_BODY (func → body scope)
 * Scope: declares function name + pushes function scope
 */
export function visitFunctionDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const fn = node as FunctionDeclaration;
  const name = fn.id?.name ?? '<anonymous>';
  const line = fn.loc?.start.line ?? 0;
  const column = fn.loc?.start.column ?? 0;

  const nodeId = ctx.nodeId('FUNCTION', name, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'FUNCTION',
      name,
      file: ctx.file,
      line,
      column,
      exported: false,
      metadata: {
        async: fn.async,
        generator: fn.generator,
        params: fn.params.map(p => p.type === 'Identifier' ? p.name : '...'),
      },
    }],
    edges: [],
    deferred: [],
  };

  // Declare function in enclosing scope (hoisted like var)
  if (fn.id) {
    const shadowedId = ctx.declare(fn.id.name, 'function', nodeId);
    if (shadowedId) {
      result.edges.push({ src: nodeId, dst: shadowedId, type: 'SHADOWS' });
    }
  }

  // Push function scope — children will be visited inside it
  const scopeId = `${nodeId}$scope`;
  ctx.pushScope('function', scopeId);

  // Parameters
  for (const param of fn.params) {
    if (param.type === 'Identifier') {
      const paramId = ctx.nodeId('PARAMETER', param.name, param.loc?.start.line ?? line);
      result.nodes.push({
        id: paramId,
        type: 'PARAMETER',
        name: param.name,
        file: ctx.file,
        line: param.loc?.start.line ?? line,
        column: param.loc?.start.column ?? 0,
      });
      result.edges.push({ src: nodeId, dst: paramId, type: 'HAS_BODY' });
      result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT' });
      ctx.declare(param.name, 'param', paramId);
      const typeRef = paramTypeRefInfo(param);
      if (typeRef) {
        result.edges.push({ src: paramId, dst: ctx.nodeId('TYPE_REFERENCE', typeRef.name, typeRef.line), type: 'HAS_TYPE' });
      }
    }
  }

  return result;
}

// ─── ClassDeclaration ────────────────────────────────────────────────

/**
 * `class Foo extends Bar { ... }`
 *
 * Creates: CLASS node
 * Edges: EXTENDS (deferred if superclass is identifier)
 * Scope: declares class name + pushes class scope
 */
export function visitClassDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const cls = node as ClassDeclaration;
  const name = cls.id?.name ?? '<anonymous>';
  const line = cls.loc?.start.line ?? 0;
  const column = cls.loc?.start.column ?? 0;

  const nodeId = ctx.nodeId('CLASS', name, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'CLASS',
      name,
      file: ctx.file,
      line,
      column,
      exported: false,
      metadata: cls.superClass?.type === 'Identifier'
        ? { superClass: cls.superClass.name }
        : undefined,
    }],
    edges: [],
    deferred: [],
  };

  // Declare in enclosing scope
  if (cls.id) {
    const shadowedId = ctx.declare(cls.id.name, 'class', nodeId);
    if (shadowedId) {
      result.edges.push({ src: nodeId, dst: shadowedId, type: 'SHADOWS' });
    }
  }

  // EXTENDS — deferred if superclass is identifier
  if (cls.superClass?.type === 'Identifier') {
    result.deferred.push({
      kind: 'type_resolve',
      name: cls.superClass.name,
      fromNodeId: nodeId,
      edgeType: 'EXTENDS',
      file: ctx.file,
      line,
      column,
    });
  }

  // IMPLEMENTS — class Foo implements Bar, Baz
  if (cls.implements) {
    for (const impl of cls.implements) {
      if (impl.type === 'TSExpressionWithTypeArguments' && impl.expression.type === 'Identifier') {
        const implName = impl.expression.name;
        const implLine = impl.loc?.start.line ?? line;
        const implId = ctx.nodeId('INTERFACE', implName, implLine);
        result.nodes.push({
          id: implId,
          type: 'INTERFACE',
          name: implName,
          file: ctx.file,
          line: implLine,
          column: impl.loc?.start.column ?? 0,
          metadata: { stub: true },
        });
        result.edges.push({
          src: nodeId,
          dst: implId,
          type: 'IMPLEMENTS',
        });
        result.deferred.push({
          kind: 'type_resolve',
          name: implName,
          fromNodeId: nodeId,
          edgeType: 'IMPLEMENTS',
          file: ctx.file,
          line,
          column,
        });
      }
    }
  }

  // Push class scope
  ctx.pushScope('class', `${nodeId}$scope`);

  return result;
}

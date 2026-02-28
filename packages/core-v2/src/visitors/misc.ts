/**
 * Misc visitors: patterns, rest elements, JSX, directives, etc.
 */
import type {
  ArrayPattern,
  AssignmentPattern,
  Decorator,
  MetaProperty,
  Node,
  ObjectPattern,
  RestElement,
  TemplateElement,
  VariableDeclarator,
} from '@babel/types';
import type { DeferredRef, VisitResult, WalkContext } from '../types.js';
import { EMPTY_RESULT } from '../types.js';

const passthrough = (_node: Node, _parent: Node | null, _ctx: WalkContext): VisitResult =>
  EMPTY_RESULT;

// ─── Patterns (destructuring) ────────────────────────────────────────

function isParameterContext(node: Node, parent: Node | null): boolean {
  if (!parent) return false;
  const pt = parent.type;
  // Direct function param
  if (pt === 'FunctionDeclaration' || pt === 'FunctionExpression'
      || pt === 'ArrowFunctionExpression' || pt === 'ClassMethod'
      || pt === 'ClassPrivateMethod' || pt === 'ObjectMethod') {
    const fn = parent as { params?: Node[] };
    return fn.params?.includes(node) ?? false;
  }
  // Nested inside another pattern that is a param — handled by parent pattern creating PARAMETER
  // AssignmentPattern wrapping a param identifier
  if (pt === 'AssignmentPattern') return true;
  if (pt === 'RestElement') return true;
  // Inside ObjectPattern/ArrayPattern property value — check if ancestor is param context
  if (pt === 'ObjectPattern' || pt === 'ArrayPattern') return true;
  return false;
}

function _getVarKind(parent: Node | null): string {
  if (!parent) return 'let';
  if (parent.type === 'VariableDeclarator') {
    // Need grandparent for kind, but we only have parent.
    // Return 'let' as default — VARIABLE is correct for destructured vars
    return 'let';
  }
  return 'let';
}

/**
 * ObjectPattern: `const { a, b } = obj` → VARIABLE nodes for each property binding.
 * In function param context → PARAMETER nodes instead.
 * Children (ObjectProperty.value, RestElement) handle nested patterns.
 */
export function visitObjectPattern(
  node: Node, parent: Node | null, ctx: WalkContext,
): VisitResult {
  const pattern = node as ObjectPattern;
  const isParam = isParameterContext(node, parent);
  const nodeType = isParam ? 'PARAMETER' : 'VARIABLE';

  const result: VisitResult = { nodes: [], edges: [], deferred: [] };

  for (const prop of pattern.properties) {
    if (prop.type === 'ObjectProperty') {
      // { a } or { a: b } — the binding name is in the value
      const value = prop.value;
      if (value.type === 'Identifier') {
        const name = value.name;
        const line = value.loc?.start.line ?? node.loc?.start.line ?? 0;
        const nodeId = ctx.nodeId(nodeType, name, line);
        result.nodes.push({
          id: nodeId,
          type: nodeType,
          name,
          file: ctx.file,
          line,
          column: value.loc?.start.column ?? 0,
        });
        ctx.declare(name, isParam ? 'param' : 'let', nodeId);
      }
      // Nested patterns (value is ObjectPattern/ArrayPattern) → walk engine visits as children
    }
    // RestElement in ObjectPattern → handled by visitRestElement
  }

  return result;
}

/**
 * ArrayPattern: `const [a, b] = arr` → VARIABLE nodes for each element binding.
 * In function param context → PARAMETER nodes instead.
 */
export function visitArrayPattern(
  node: Node, parent: Node | null, ctx: WalkContext,
): VisitResult {
  const pattern = node as ArrayPattern;
  const isParam = isParameterContext(node, parent);
  const nodeType = isParam ? 'PARAMETER' : 'VARIABLE';

  const result: VisitResult = { nodes: [], edges: [], deferred: [] };

  // Collect element node IDs for ELEMENT_OF derivation
  const elemNodeIds: string[] = [];

  for (const elem of pattern.elements) {
    if (!elem) continue; // holes: [, , x]
    if (elem.type === 'Identifier') {
      const name = elem.name;
      const line = elem.loc?.start.line ?? node.loc?.start.line ?? 0;
      const nodeId = ctx.nodeId(nodeType, name, line);
      result.nodes.push({
        id: nodeId,
        type: nodeType,
        name,
        file: ctx.file,
        line,
        column: elem.loc?.start.column ?? 0,
      });
      ctx.declare(name, isParam ? 'param' : 'let', nodeId);
      elemNodeIds.push(nodeId);
    }
    // Nested patterns, RestElement, AssignmentPattern → walk engine visits as children
  }

  // ELEMENT_OF: `const [a, b] = arr` → a,b → ELEMENT_OF → arr
  if (parent?.type === 'VariableDeclarator') {
    const decl = parent as VariableDeclarator;
    if (decl.init?.type === 'Identifier') {
      const line = node.loc?.start.line ?? 0;
      for (const elemId of elemNodeIds) {
        result.deferred.push({
          kind: 'scope_lookup',
          name: decl.init.name,
          fromNodeId: elemId,
          edgeType: 'ELEMENT_OF',
          scopeId: ctx.currentScope.id,
          file: ctx.file,
          line,
          column: node.loc?.start.column ?? 0,
        });
      }
    }
  }

  return result;
}

/**
 * RestElement: `function f(...rest)` → PARAMETER node.
 * `const [...rest] = arr` → VARIABLE node.
 */
export function visitRestElement(
  node: Node, parent: Node | null, ctx: WalkContext,
): VisitResult {
  const rest = node as RestElement;
  if (rest.argument.type !== 'Identifier') return EMPTY_RESULT;

  const isParam = isParameterContext(node, parent);
  const nodeType = isParam ? 'PARAMETER' : 'VARIABLE';
  const name = rest.argument.name;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId(nodeType, name, line);

  ctx.declare(name, isParam ? 'param' : 'let', nodeId);

  return {
    nodes: [{
      id: nodeId,
      type: nodeType,
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { rest: true },
    }],
    edges: [],
    deferred: [],
  };
}

/**
 * AssignmentPattern: `function f(x = 5)` → PARAMETER node for x.
 * `const [a = 1] = arr` → VARIABLE node for a.
 * The default value (right side) is visited as child via EDGE_MAP (HAS_DEFAULT).
 */
export function visitAssignmentPattern(
  node: Node, parent: Node | null, ctx: WalkContext,
): VisitResult {
  const ap = node as AssignmentPattern;
  if (ap.left.type !== 'Identifier') return EMPTY_RESULT;

  const isParam = isParameterContext(node, parent);
  const nodeType = isParam ? 'PARAMETER' : 'VARIABLE';
  const name = ap.left.name;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId(nodeType, name, line);

  ctx.declare(name, isParam ? 'param' : 'let', nodeId);

  return {
    nodes: [{
      id: nodeId,
      type: nodeType,
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { hasDefault: true },
    }],
    edges: [],
    deferred: [],
  };
}

// ─── Template elements ──────────────────────────────────────────────

export function visitTemplateElement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const te = node as TemplateElement;
  const value = te.value.cooked ?? te.value.raw;
  // Skip null/undefined quasis (broken escapes), but keep empty strings
  if (value == null) return EMPTY_RESULT;
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('LITERAL', value, line),
      type: 'LITERAL',
      name: value,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { value, valueType: 'string' },
    }],
    edges: [],
    deferred: [],
  };
}

// ─── JSX ─────────────────────────────────────────────────────────────

export const visitJSXElement = passthrough;
export const visitJSXFragment = passthrough;
export const visitJSXOpeningElement = passthrough;
export const visitJSXClosingElement = passthrough;
export const visitJSXOpeningFragment = passthrough;
export const visitJSXClosingFragment = passthrough;
export const visitJSXAttribute = passthrough;
export const visitJSXSpreadAttribute = passthrough;
export const visitJSXText = passthrough;
export const visitJSXExpressionContainer = passthrough;
export const visitJSXSpreadChild = passthrough;
export const visitJSXEmptyExpression = passthrough;
export const visitJSXIdentifier = passthrough;
export const visitJSXMemberExpression = passthrough;
export const visitJSXNamespacedName = passthrough;

// ─── Directives ──────────────────────────────────────────────────────

export const visitDirective = passthrough;
export const visitDirectiveLiteral = passthrough;

// ─── Misc ────────────────────────────────────────────────────────────

export const visitFile = passthrough;
export const visitProgram = passthrough;
export const visitInterpreterDirective = passthrough;
export function visitMetaProperty(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const meta = node as MetaProperty;
  const name = `${meta.meta.name}.${meta.property.name}`;
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('META_PROPERTY', name, line),
      type: 'META_PROPERTY',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}
export const visitSuper = passthrough;
export const visitPrivateName = passthrough;
export const visitV8IntrinsicIdentifier = passthrough;
export const visitArgumentPlaceholder = passthrough;
export function visitDecorator(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const dec = node as Decorator;
  const name = dec.expression.type === 'Identifier'
    ? dec.expression.name
    : dec.expression.type === 'CallExpression' && dec.expression.callee.type === 'Identifier'
      ? dec.expression.callee.name
      : '<decorator>';
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('DECORATOR', name, line);
  const deferred: DeferredRef[] = [];

  // Decorator references a function — create CALLS deferred
  if (dec.expression.type === 'Identifier') {
    deferred.push({
      kind: 'scope_lookup',
      name: dec.expression.name,
      fromNodeId: nodeId,
      edgeType: 'CALLS',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    });
  } else if (dec.expression.type === 'CallExpression' && dec.expression.callee.type === 'Identifier') {
    deferred.push({
      kind: 'scope_lookup',
      name: dec.expression.callee.name,
      fromNodeId: nodeId,
      edgeType: 'CALLS',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    });
  }

  return {
    nodes: [{
      id: nodeId,
      type: 'DECORATOR',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred,
  };
}

// ─── Patterns ────────────────────────────────────────────────────────
export const visitBindExpression = passthrough;
export const visitPipelineTopicExpression = passthrough;
export const visitPipelineBareFunction = passthrough;
export const visitPipelinePrimaryTopicReference = passthrough;

// ─── Import expression (dynamic) ─────────────────────────────────────
export function visitImport(
  _node: Node, _parent: Node | null, _ctx: WalkContext,
): VisitResult {
  return EMPTY_RESULT;
}

// ─── Placeholder for export default from ─────────────────────────────
export const visitExportNamespaceSpecifier = passthrough;
export const visitExportDefaultSpecifier = passthrough;

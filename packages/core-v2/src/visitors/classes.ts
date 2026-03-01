/**
 * Visitors for class member AST nodes.
 *
 * ClassMethod, ClassProperty, ClassPrivateMethod, ClassPrivateProperty,
 * ClassBody, StaticBlock
 */
import type {
  ClassMethod,
  ClassPrivateMethod,
  ClassPrivateProperty,
  ClassProperty,
  Node,
} from '@babel/types';
import type { VisitResult, WalkContext } from '../types.js';
import { EMPTY_RESULT } from '../types.js';

export function visitClassBody(
  _node: Node, _parent: Node | null, _ctx: WalkContext,
): VisitResult {
  return EMPTY_RESULT;
}

function computedKeyName(key: Node): string {
  // [varName] — computed with identifier
  if (key.type === 'Identifier') return `[${key.name}]`;
  // Symbol.iterator, Symbol.toPrimitive, etc.
  if (key.type === 'MemberExpression'
      && key.object.type === 'Identifier'
      && key.property.type === 'Identifier') {
    return `[${key.object.name}.${key.property.name}]`;
  }
  return '<computed>';
}

export function visitClassMethod(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const method = node as ClassMethod;
  const name = method.computed ? computedKeyName(method.key as Node) : (method.key.type === 'Identifier' ? method.key.name : '<computed>');
  const line = node.loc?.start.line ?? 0;

  // Differentiate getter/setter/constructor from regular methods
  const nodeType = method.kind === 'get' ? 'GETTER'
    : method.kind === 'set' ? 'SETTER'
    : 'METHOD';
  const nodeId = ctx.nodeId(nodeType, name, line);

  ctx.pushScope('function', `${nodeId}$scope`);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: nodeType,
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: {
        kind: method.kind,
        static: method.static,
        async: method.async,
        generator: method.generator,
      },
    }],
    edges: [],
    deferred: [],
  };

  for (let i = 0; i < method.params.length; i++) {
    const param = method.params[i];
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
      result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT', metadata: { paramIndex: i } });
      ctx.declare(param.name, 'param', paramId);
    }
  }

  return result;
}

export function visitClassProperty(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const prop = node as ClassProperty;
  const name = prop.computed ? computedKeyName(prop.key as Node) : (prop.key.type === 'Identifier' ? prop.key.name : '<computed>');
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('PROPERTY', name, line),
      type: 'PROPERTY',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { static: prop.static },
    }],
    edges: [],
    deferred: [],
  };
}

export function visitClassPrivateMethod(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const method = node as ClassPrivateMethod;
  const name = `#${method.key.id.name}`;
  const line = node.loc?.start.line ?? 0;

  const nodeType = method.kind === 'get' ? 'GETTER'
    : method.kind === 'set' ? 'SETTER'
    : 'METHOD';
  const nodeId = ctx.nodeId(nodeType, name, line);

  // Declare private method in class scope so ACCESSES_PRIVATE can resolve
  ctx.declare(name, 'function', nodeId);

  ctx.pushScope('function', `${nodeId}$scope`);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: nodeType,
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { kind: method.kind, private: true, static: method.static },
    }],
    edges: [],
    deferred: [],
  };

  for (let i = 0; i < method.params.length; i++) {
    const param = method.params[i];
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
      result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT', metadata: { paramIndex: i } });
      ctx.declare(param.name, 'param', paramId);
    }
  }

  return result;
}

export function visitClassPrivateProperty(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const prop = node as ClassPrivateProperty;
  const name = `#${prop.key.id.name}`;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('PROPERTY', name, line);

  // Declare private field in class scope so ACCESSES_PRIVATE can resolve
  ctx.declare(name, 'const', nodeId);

  return {
    nodes: [{
      id: nodeId,
      type: 'PROPERTY',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { private: true, static: prop.static },
    }],
    edges: [],
    deferred: [],
  };
}

export function visitStaticBlock(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('STATIC_BLOCK', 'static', line);
  ctx.pushScope('block', `${nodeId}$scope`);
  return {
    nodes: [{
      id: nodeId,
      type: 'STATIC_BLOCK',
      name: 'static',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitClassAccessorProperty(
  node: Node, parent: Node | null, ctx: WalkContext,
): VisitResult {
  return visitClassProperty(node, parent, ctx);
}

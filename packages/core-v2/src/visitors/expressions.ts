/**
 * Visitors for expression AST nodes.
 *
 * CallExpression, MemberExpression, AssignmentExpression,
 * BinaryExpression, NewExpression, ArrowFunctionExpression,
 * FunctionExpression, etc.
 */
import type {
  ArrayExpression,
  ArrowFunctionExpression,
  AssignmentExpression,
  AwaitExpression,
  BinaryExpression,
  CallExpression,
  CatchClause,
  ClassDeclaration,
  ClassExpression,
  ClassMethod,
  ClassProperty,
  ForInStatement,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  MemberExpression,
  NewExpression,
  Node,
  NumericLiteral,
  ObjectExpression,
  ObjectMethod,
  ObjectProperty,
  PrivateName,
  StringLiteral,
  TaggedTemplateExpression,
  UnaryExpression,
  UpdateExpression,
  VariableDeclarator,
  YieldExpression,
} from '@babel/types';
import type { VisitResult, WalkContext } from '../types.js';
import { EMPTY_RESULT, paramTypeRefInfo } from '../types.js';

// ─── CallExpression ──────────────────────────────────────────────────

export function visitCallExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const call = node as CallExpression;
  const line = node.loc?.start.line ?? 0;
  const column = node.loc?.start.column ?? 0;

  let calleeName: string;
  let isChained = false;
  if (call.callee.type === 'Identifier') {
    calleeName = call.callee.name;
  } else if ((call.callee.type === 'MemberExpression' || call.callee.type === 'OptionalMemberExpression')
    && call.callee.property.type === 'Identifier') {
    const member = call.callee as MemberExpression;
    const isOptional = (member as unknown as { optional?: boolean }).optional;
    const obj = member.object.type === 'Identifier'
      ? member.object.name
      : member.object.type === 'ThisExpression'
        ? 'this'
        : member.object.type === 'Super'
          ? 'super'
          : '?';
    const dot = isOptional ? '?.' : '.';
    calleeName = `${obj}${dot}${(member.property as Identifier).name}`;
    // a.b().c() — object is a call expression → method chaining
    isChained = member.object.type === 'CallExpression'
      || member.object.type === 'OptionalCallExpression';
  } else if ((call.callee.type === 'MemberExpression' || call.callee.type === 'OptionalMemberExpression')
    && call.callee.computed) {
    // Computed: obj[key](), this[method](), super[m]()
    const obj = call.callee.object.type === 'Identifier'
      ? call.callee.object.name
      : call.callee.object.type === 'ThisExpression' ? 'this'
      : call.callee.object.type === 'Super' ? 'super'
      : '?';
    const rawProp = call.callee.property;
    const prop = rawProp.type === 'Identifier'
      ? rawProp.name
      : rawProp.type === 'MemberExpression'
          && rawProp.object.type === 'Identifier'
          && rawProp.property.type === 'Identifier'
        ? `${rawProp.object.name}.${rawProp.property.name}`
      : rawProp.type === 'StringLiteral'
        ? `'${(rawProp as StringLiteral).value}'`
      : rawProp.type === 'NumericLiteral'
        ? String((rawProp as NumericLiteral).value)
      : '<computed>';
    calleeName = `${obj}[${prop}]`;
  } else if (call.callee.type === 'Super') {
    calleeName = 'super';
  } else if (call.callee.type === 'Import') {
    calleeName = 'import';
  } else if (call.callee.type === 'FunctionExpression') {
    calleeName = (call.callee as FunctionExpression).id?.name ?? '<iife>';
  } else if (call.callee.type === 'ArrowFunctionExpression') {
    calleeName = '<iife>';
  } else {
    calleeName = '<computed>';
  }

  const nodeId = ctx.nodeId('CALL', calleeName, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'CALL',
      name: calleeName,
      file: ctx.file,
      line,
      column,
      metadata: {
        arguments: call.arguments.length,
        chained: isChained,
        ...((call.callee.type === 'MemberExpression' || call.callee.type === 'OptionalMemberExpression') && call.callee.property.type === 'Identifier'
          ? { method: call.callee.property.name, object: call.callee.object.type === 'Identifier' ? call.callee.object.name : call.callee.object.type === 'ThisExpression' ? 'this' : call.callee.object.type === 'Super' ? 'super' : undefined }
          : {}),
      },
    }],
    edges: [],
    deferred: [],
  };

  // CHAINS_FROM: a.b().c() → c chains from b
  if (isChained && (call.callee.type === 'MemberExpression' || call.callee.type === 'OptionalMemberExpression')) {
    const prevCall = call.callee.object;
    const prevLine = prevCall.loc?.start.line ?? line;
    // Get the name of the previous call for the ID
    let prevName: string;
    if (prevCall.type === 'CallExpression' || prevCall.type === 'OptionalCallExpression') {
      const pc = prevCall as CallExpression;
      if (pc.callee.type === 'Identifier') {
        prevName = pc.callee.name;
      } else if ((pc.callee.type === 'MemberExpression' || pc.callee.type === 'OptionalMemberExpression') && pc.callee.property.type === 'Identifier') {
        const calleeMember = pc.callee as MemberExpression;
        const po = calleeMember.object.type === 'Identifier'
          ? calleeMember.object.name
          : calleeMember.object.type === 'ThisExpression'
            ? 'this'
            : calleeMember.object.type === 'Super'
              ? 'super'
              : (calleeMember.object.type === 'MemberExpression' || calleeMember.object.type === 'OptionalMemberExpression')
                ? ((calleeMember.object as MemberExpression).property.type === 'Identifier'
                    ? ((calleeMember.object as MemberExpression).property as Identifier).name
                    : '?')
                : '?';
        const optDot = (calleeMember as unknown as { optional?: boolean }).optional ? '?.' : '.';
        prevName = `${po}${optDot}${(calleeMember.property as Identifier).name}`;
      } else {
        prevName = '<computed>';
      }
    } else {
      prevName = '<computed>';
    }
    result.edges.push({
      src: nodeId,
      dst: ctx.nodeId('CALL', prevName, prevLine),
      type: 'CHAINS_FROM',
    });
  }

  // PASSES_ARGUMENT for Identifier arguments: scope_lookup resolves to the actual
  // VARIABLE/PARAMETER/FUNCTION node. For non-Identifier args (literals, calls, etc.),
  // EDGE_MAP (CallExpression.arguments → PASSES_ARGUMENT) creates structural edges.
  for (const arg of call.arguments) {
    if (arg.type === 'Identifier') {
      result.deferred.push({
        kind: 'scope_lookup',
        name: arg.name,
        fromNodeId: nodeId,
        edgeType: 'PASSES_ARGUMENT',
        scopeId: ctx.currentScope.id,
        file: ctx.file,
        line: arg.loc?.start.line ?? line,
        column: arg.loc?.start.column ?? 0,
      });
    }
  }

  // Deferred: resolve callee to actual function
  if (call.callee.type === 'Identifier') {
    // scope_lookup for same-file resolution (Stage 2), falls back to unresolved for Stage 3
    result.deferred.push({
      kind: 'scope_lookup',
      name: call.callee.name,
      fromNodeId: nodeId,
      edgeType: 'CALLS',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column,
    });
  } else if (call.callee.type === 'MemberExpression' && call.callee.property.type === 'Identifier') {
    const methodName = call.callee.property.name;

    // obj.method() → CALLS_ON
    // Use scope_lookup for same-file resolution of the object
    if (call.callee.object.type === 'Identifier') {
      result.deferred.push({
        kind: 'scope_lookup',
        name: call.callee.object.name,
        fromNodeId: nodeId,
        edgeType: 'CALLS_ON',
        scopeId: ctx.currentScope.id,
        file: ctx.file,
        line,
        column,
      });
    } else {
      result.deferred.push({
        kind: 'call_resolve',
        name: methodName,
        fromNodeId: nodeId,
        edgeType: 'CALLS_ON',
        file: ctx.file,
        line,
        column,
      });
    }

    // fn.bind(ctx) → BINDS_THIS_TO
    if (methodName === 'bind' && call.arguments.length >= 1) {
      const arg = call.arguments[0];
      if (arg.type === 'Identifier') {
        result.deferred.push({
          kind: 'scope_lookup',
          name: arg.name,
          fromNodeId: nodeId,
          edgeType: 'BINDS_THIS_TO',
          scopeId: ctx.currentScope.id,
          file: ctx.file,
          line,
          column,
        });
      } else if (arg.type === 'ThisExpression') {
        const classStack = (ctx as unknown as { _classStack?: string[] })._classStack;
        if (classStack?.length) {
          result.edges.push({
            src: nodeId,
            dst: classStack[classStack.length - 1],
            type: 'BINDS_THIS_TO',
          });
        }
      }
    }

    // arr.filter(cb, ctx), arr.map(cb, ctx), etc. → BINDS_THIS_TO ctx
    const THISARG_METHODS = new Set(['filter', 'map', 'forEach', 'find', 'findIndex', 'every', 'some', 'flatMap']);
    if (THISARG_METHODS.has(methodName) && call.arguments.length >= 2) {
      const thisArg = call.arguments[1];
      if (thisArg.type === 'Identifier') {
        result.deferred.push({
          kind: 'scope_lookup',
          name: thisArg.name,
          fromNodeId: nodeId,
          edgeType: 'BINDS_THIS_TO',
          scopeId: ctx.currentScope.id,
          file: ctx.file,
          line,
          column,
        });
      } else if (thisArg.type === 'ThisExpression') {
        // this → enclosing class
        const classStack = (ctx as unknown as { _classStack?: string[] })._classStack;
        if (classStack?.length) {
          result.edges.push({
            src: nodeId,
            dst: classStack[classStack.length - 1],
            type: 'BINDS_THIS_TO',
          });
        }
      }
    }

    // arr.push(x), arr.unshift(x), etc. → FLOWS_INTO from call to arr
    const MUTATION_METHODS = new Set(['push', 'unshift', 'splice', 'fill', 'copyWithin', 'set', 'add']);
    if (MUTATION_METHODS.has(methodName) && call.callee.type === 'MemberExpression'
        && call.callee.object.type === 'Identifier') {
      result.deferred.push({
        kind: 'scope_lookup',
        name: call.callee.object.name,
        fromNodeId: nodeId,
        edgeType: 'FLOWS_INTO',
        scopeId: ctx.currentScope.id,
        file: ctx.file,
        line,
        column,
      });
    }

    // fn.call(ctx, ...) / fn.apply(ctx, ...) → INVOKES
    if ((methodName === 'call' || methodName === 'apply')
        && call.callee.type === 'MemberExpression'
        && call.callee.object.type === 'Identifier') {
      result.deferred.push({
        kind: 'scope_lookup',
        name: call.callee.object.name,
        fromNodeId: nodeId,
        edgeType: 'INVOKES',
        scopeId: ctx.currentScope.id,
        file: ctx.file,
        line,
        column,
      });
    }

    // .addEventListener('event', handler) / .on('event', handler) → LISTENS_TO
    const LISTENER_METHODS = new Set(['addEventListener', 'on', 'once', 'addListener']);
    if (LISTENER_METHODS.has(methodName) && call.arguments.length >= 2) {
      const handler = call.arguments[1];
      if (handler.type === 'Identifier') {
        result.deferred.push({
          kind: 'scope_lookup',
          name: handler.name,
          fromNodeId: nodeId,
          edgeType: 'LISTENS_TO',
          scopeId: ctx.currentScope.id,
          file: ctx.file,
          line,
          column,
        });
      }
    }
  }

  // require('module') / import('module') → EXTERNAL_MODULE node + IMPORTS/IMPORTS_FROM edge
  if ((calleeName === 'require' || calleeName === 'import') && call.arguments.length >= 1 && call.arguments[0].type === 'StringLiteral') {
    const moduleName = (call.arguments[0] as StringLiteral).value;
    const extId = ctx.nodeId('EXTERNAL_MODULE', moduleName, line);
    result.nodes.push({
      id: extId,
      type: 'EXTERNAL_MODULE',
      name: moduleName,
      file: ctx.file,
      line,
      column,
    });
    result.edges.push({ src: nodeId, dst: extId, type: calleeName === 'require' ? 'IMPORTS' : 'IMPORTS_FROM' });
  }

  // Object.assign(target, ...sources) → MERGES_WITH
  if (calleeName === 'Object.assign' && call.arguments.length >= 2) {
    for (let i = 1; i < call.arguments.length; i++) {
      const src = call.arguments[i];
      if (src.type === 'Identifier') {
        result.deferred.push({
          kind: 'scope_lookup',
          name: (src as Identifier).name,
          fromNodeId: nodeId,
          edgeType: 'MERGES_WITH',
          scopeId: ctx.currentScope.id,
          file: ctx.file,
          line,
          column,
        });
      }
    }
  }

  return result;
}

// ─── MemberExpression ────────────────────────────────────────────────

export function visitMemberExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const member = node as MemberExpression;
  const line = node.loc?.start.line ?? 0;
  const column = node.loc?.start.column ?? 0;

  const isPrivate = member.property.type === 'PrivateName';
  const propName = member.property.type === 'Identifier'
    ? member.property.name
    : isPrivate
      ? `#${(member.property as PrivateName).id.name}`
      : computedPropertyName(member.property as Node);
  const objName = member.object.type === 'Identifier'
    ? member.object.name
    : member.object.type === 'ThisExpression'
      ? 'this'
      : member.object.type === 'Super'
        ? 'super'
        : (member.object.type === 'MemberExpression' || member.object.type === 'OptionalMemberExpression')
          ? ((member.object as MemberExpression).property.type === 'Identifier'
              ? ((member.object as MemberExpression).property as Identifier).name
              : (member.object as MemberExpression).property.type === 'PrivateName'
                ? `#${((member.object as MemberExpression).property as PrivateName).id.name}`
                : computedPropertyName((member.object as MemberExpression).property as Node))
          : '?';
  const isOptional = (member as unknown as { optional?: boolean }).optional;
  const isBracket = propName.startsWith('[');
  const dot = isBracket ? (isOptional ? '?.' : '') : (isOptional ? '?.' : '.');
  const name = `${objName}${dot}${propName}`;

  const nodeId = ctx.nodeId('PROPERTY_ACCESS', name, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'PROPERTY_ACCESS',
      name,
      file: ctx.file,
      line,
      column,
      metadata: {
        object: objName,
        property: propName,
        computed: member.computed,
        optional: (member as unknown as { optional?: boolean }).optional,
        private: isPrivate,
      },
    }],
    edges: [],
    deferred: [],
  };

  // Private field access: this.#field → ACCESSES_PRIVATE
  if (isPrivate) {
    result.deferred.push({
      kind: 'scope_lookup',
      name: propName,  // e.g. '#field'
      fromNodeId: nodeId,
      edgeType: 'ACCESSES_PRIVATE',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column,
    });
  }

  // CHAINS_FROM: a.b.c → PROPERTY_ACCESS('a.b.c') chains from PROPERTY_ACCESS('a.b')
  if (member.object.type === 'MemberExpression' || member.object.type === 'OptionalMemberExpression') {
    const inner = member.object as MemberExpression;
    const innerProp = inner.property.type === 'Identifier'
      ? inner.property.name
      : inner.property.type === 'PrivateName'
        ? `#${(inner.property as PrivateName).id.name}`
        : computedPropertyName(inner.property as Node);
    const innerObj = inner.object.type === 'Identifier'
      ? inner.object.name
      : inner.object.type === 'ThisExpression' ? 'this'
      : inner.object.type === 'Super' ? 'super'
      : (inner.object.type === 'MemberExpression' || inner.object.type === 'OptionalMemberExpression')
        ? ((inner.object as MemberExpression).property.type === 'Identifier'
            ? ((inner.object as MemberExpression).property as Identifier).name
            : (inner.object as MemberExpression).property.type === 'PrivateName'
              ? `#${((inner.object as MemberExpression).property as PrivateName).id.name}`
              : computedPropertyName((inner.object as MemberExpression).property as Node))
        : '?';
    const innerOptional = (inner as unknown as { optional?: boolean }).optional;
    const innerBracket = innerProp.startsWith('[');
    const innerDot = innerBracket ? (innerOptional ? '?.' : '') : (innerOptional ? '?.' : '.');
    const innerName = `${innerObj}${innerDot}${innerProp}`;
    const innerLine = inner.loc?.start.line ?? line;
    result.edges.push({
      src: nodeId,
      dst: ctx.nodeId('PROPERTY_ACCESS', innerName, innerLine),
      type: 'CHAINS_FROM',
    });
  }

  return result;
}

// ─── OptionalMemberExpression ────────────────────────────────────────

export const visitOptionalMemberExpression = visitMemberExpression;

// ─── OptionalCallExpression ──────────────────────────────────────────

export const visitOptionalCallExpression = visitCallExpression;

// ─── AssignmentExpression ────────────────────────────────────────────

export function visitAssignmentExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const assign = node as AssignmentExpression;
  const line = node.loc?.start.line ?? 0;
  const column = node.loc?.start.column ?? 0;

  const nodeId = ctx.nodeId('EXPRESSION', `assign`, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'EXPRESSION',
      name: assign.operator,
      file: ctx.file,
      line,
      column,
      metadata: { operator: assign.operator },
    }],
    edges: [],
    deferred: [],
  };

  // Deferred: lhs writes to a variable
  if (assign.left.type === 'Identifier') {
    result.deferred.push({
      kind: 'scope_lookup',
      name: assign.left.name,
      fromNodeId: nodeId,
      edgeType: 'WRITES_TO',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column,
    });
  }

  return result;
}

// ─── BinaryExpression / LogicalExpression ────────────────────────────

export function visitBinaryExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const bin = node as BinaryExpression;
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', bin.operator, line),
      type: 'EXPRESSION',
      name: bin.operator,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { operator: bin.operator },
    }],
    edges: [],
    deferred: [],
  };
}

export const visitLogicalExpression = visitBinaryExpression;

// ─── UnaryExpression / UpdateExpression ──────────────────────────────

export function visitUnaryExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const unary = node as UnaryExpression;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('EXPRESSION', unary.operator, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'EXPRESSION',
      name: unary.operator,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { operator: unary.operator, prefix: unary.prefix },
    }],
    edges: [],
    deferred: [],
  };

  // delete obj.prop → DELETES edge
  if (unary.operator === 'delete' && unary.argument.type === 'MemberExpression') {
    const prop = unary.argument.property;
    if (prop.type === 'Identifier') {
      result.deferred.push({
        kind: 'scope_lookup',
        name: prop.name,
        fromNodeId: nodeId,
        edgeType: 'DELETES',
        scopeId: ctx.currentScope.id,
        file: ctx.file,
        line,
        column: node.loc?.start.column ?? 0,
      });
    }
  }

  return result;
}

export function visitUpdateExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const update = node as UpdateExpression;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('EXPRESSION', update.operator, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'EXPRESSION',
      name: update.operator,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { operator: update.operator, prefix: update.prefix },
    }],
    edges: [],
    deferred: [],
  };

  if (update.argument.type === 'Identifier') {
    result.deferred.push({
      kind: 'scope_lookup',
      name: update.argument.name,
      fromNodeId: nodeId,
      edgeType: 'MODIFIES',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    });
  }

  return result;
}

// ─── NewExpression ───────────────────────────────────────────────────

export function visitNewExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const ne = node as NewExpression;
  const line = node.loc?.start.line ?? 0;
  const column = node.loc?.start.column ?? 0;
  let calleeName: string;
  if (ne.callee.type === 'Identifier') {
    calleeName = ne.callee.name;
  } else if (ne.callee.type === 'MemberExpression' && ne.callee.property.type === 'Identifier') {
    const obj = ne.callee.object.type === 'Identifier' ? ne.callee.object.name : '?';
    calleeName = `${obj}.${ne.callee.property.name}`;
  } else {
    calleeName = '<computed>';
  }
  const nodeId = ctx.nodeId('CALL', `new ${calleeName}`, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'CALL',
      name: `new ${calleeName}`,
      file: ctx.file,
      line,
      column,
      metadata: { isNew: true, arguments: ne.arguments.length },
    }],
    edges: [],
    deferred: [],
  };

  if (ne.callee.type === 'Identifier') {
    result.deferred.push({
      kind: 'scope_lookup',
      name: ne.callee.name,
      fromNodeId: nodeId,
      edgeType: 'CALLS',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column,
    });
  }

  return result;
}

// ─── ArrowFunctionExpression ─────────────────────────────────────────

export function visitArrowFunctionExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const arrow = node as ArrowFunctionExpression;
  const line = node.loc?.start.line ?? 0;
  const column = node.loc?.start.column ?? 0;
  const nodeId = ctx.nodeId('FUNCTION', '<arrow>', line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'FUNCTION',
      name: '<arrow>',
      file: ctx.file,
      line,
      column,
      metadata: {
        async: arrow.async,
        generator: false,
        arrowFunction: true,
        params: arrow.params.map(p => p.type === 'Identifier' ? p.name : '...'),
      },
    }],
    edges: [],
    deferred: [],
  };

  // Push function scope
  ctx.pushScope('function', `${nodeId}$scope`);

  // Parameters
  for (const param of arrow.params) {
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

// ─── FunctionExpression ──────────────────────────────────────────────

export function visitFunctionExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const fn = node as FunctionExpression;
  const name = fn.id?.name ?? '<anonymous>';
  const line = node.loc?.start.line ?? 0;
  const column = node.loc?.start.column ?? 0;
  const nodeId = ctx.nodeId('FUNCTION', name, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'FUNCTION',
      name,
      file: ctx.file,
      line,
      column,
      metadata: {
        async: fn.async,
        generator: fn.generator,
        params: fn.params.map(p => p.type === 'Identifier' ? p.name : '...'),
      },
    }],
    edges: [],
    deferred: [],
  };

  ctx.pushScope('function', `${nodeId}$scope`);

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

// ─── ConditionalExpression ───────────────────────────────────────────

export function visitConditionalExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', 'ternary', line),
      type: 'EXPRESSION',
      name: 'ternary',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

// ─── AwaitExpression ─────────────────────────────────────────────────

export function visitAwaitExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const aw = node as AwaitExpression;
  const line = node.loc?.start.line ?? 0;
  const result: VisitResult = {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', 'await', line),
      type: 'EXPRESSION',
      name: 'await',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };

  // AWAITS for Identifier arguments: scope_lookup resolves to the actual variable.
  // Non-Identifier args are handled by EDGE_MAP (AwaitExpression.argument → AWAITS).
  if (aw.argument.type === 'Identifier') {
    const fnStack = (ctx as unknown as { _functionStack?: string[] })._functionStack;
    const enclosingFn = fnStack?.length ? fnStack[fnStack.length - 1] : '';
    result.deferred.push({
      kind: 'scope_lookup',
      name: aw.argument.name,
      fromNodeId: enclosingFn,
      edgeType: 'AWAITS',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line: aw.argument.loc?.start.line ?? line,
      column: aw.argument.loc?.start.column ?? 0,
    });
  }

  return result;
}

// ─── YieldExpression ─────────────────────────────────────────────────

export function visitYieldExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const y = node as YieldExpression;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('EXPRESSION', y.delegate ? 'yield*' : 'yield', line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'EXPRESSION',
      name: y.delegate ? 'yield*' : 'yield',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };

  // DELEGATES_TO: yield* delegates iteration to another iterable
  if (y.delegate) {
    const fnStack = (ctx as unknown as { _functionStack?: string[] })._functionStack;
    if (fnStack?.length) {
      result.edges.push({
        src: fnStack[fnStack.length - 1],
        dst: nodeId,
        type: 'DELEGATES_TO',
      });
    }
  }

  // YIELDS for Identifier arguments: scope_lookup resolves to the actual variable/param.
  // Non-Identifier args are handled by EDGE_MAP (YieldExpression.argument → YIELDS).
  if (y.argument?.type === 'Identifier') {
    result.deferred.push({
      kind: 'scope_lookup',
      name: y.argument.name,
      fromNodeId: nodeId,
      edgeType: 'YIELDS',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line: y.argument.loc?.start.line ?? line,
      column: y.argument.loc?.start.column ?? 0,
    });
  }

  return result;
}

// ─── SpreadElement ───────────────────────────────────────────────────

export function visitSpreadElement(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', 'spread', line),
      type: 'EXPRESSION',
      name: 'spread',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

// ─── Passthrough: nodes that don't create graph nodes ────────────────

export function visitIdentifier(
  node: Node, parent: Node | null, ctx: WalkContext,
): VisitResult {
  // Identifiers in "read" contexts produce READS_FROM deferred.
  // Skip identifiers that are:
  //   - Declaration names (VariableDeclarator.id, FunctionDeclaration.id, etc.)
  //   - Assignment LHS (AssignmentExpression.left)
  //   - Property keys (ObjectProperty.key, MemberExpression.property)
  //   - Import/Export specifiers
  //   - Labels

  if (!parent) return EMPTY_RESULT;

  const id = node as Identifier;
  const pt = parent.type;

  // Write/declaration contexts — not a "read"
  if (pt === 'VariableDeclarator' && (parent as VariableDeclarator).id === node) return EMPTY_RESULT;
  if (pt === 'FunctionDeclaration' && (parent as FunctionDeclaration).id === node) return EMPTY_RESULT;
  if (pt === 'FunctionExpression' && (parent as FunctionExpression).id === node) return EMPTY_RESULT;
  if (pt === 'ClassDeclaration' && (parent as ClassDeclaration).id === node) return EMPTY_RESULT;
  if (pt === 'ClassExpression' && (parent as ClassExpression).id === node) return EMPTY_RESULT;
  if (pt === 'AssignmentExpression' && (parent as AssignmentExpression).left === node) return EMPTY_RESULT;
  if (pt === 'UpdateExpression') return EMPTY_RESULT;  // i++ is a modify, not a read
  if (pt === 'LabeledStatement' || pt === 'BreakStatement' || pt === 'ContinueStatement') return EMPTY_RESULT;
  if (pt === 'PrivateName') return EMPTY_RESULT;  // #field → PrivateName → Identifier is not a read

  // Property key contexts — not a "read" of the identifier itself
  if (pt === 'ObjectProperty' && (parent as ObjectProperty).key === node) return EMPTY_RESULT;
  if (pt === 'ObjectMethod' && (parent as ObjectMethod).key === node) return EMPTY_RESULT;
  if (pt === 'ClassMethod' && (parent as ClassMethod).key === node) return EMPTY_RESULT;
  if (pt === 'ClassProperty' && (parent as ClassProperty).key === node) return EMPTY_RESULT;
  if (pt === 'MemberExpression' && (parent as MemberExpression).property === node
      && !(parent as MemberExpression).computed) return EMPTY_RESULT;

  // Import/export specifiers — handled by their own visitors
  if (pt === 'ImportSpecifier' || pt === 'ImportDefaultSpecifier' || pt === 'ImportNamespaceSpecifier') return EMPTY_RESULT;
  if (pt === 'ExportSpecifier') return EMPTY_RESULT;

  // Function/method params — declarations, not reads
  if (pt === 'FunctionDeclaration' || pt === 'FunctionExpression' || pt === 'ArrowFunctionExpression' || pt === 'ClassMethod' || pt === 'ClassPrivateMethod' || pt === 'ObjectMethod') {
    const fn = parent as { params?: Node[] };
    if (fn.params && fn.params.includes(node)) return EMPTY_RESULT;
  }

  // TS declaration names
  if (pt === 'TSInterfaceDeclaration' || pt === 'TSTypeAliasDeclaration' || pt === 'TSEnumDeclaration' || pt === 'TSModuleDeclaration') return EMPTY_RESULT;
  if (pt === 'TSEnumMember') return EMPTY_RESULT;
  if (pt === 'TSTypeReference') return EMPTY_RESULT;  // handled by TSTypeReference visitor
  if (pt === 'TSTypeParameter') return EMPTY_RESULT;

  // CatchClause param
  if (pt === 'CatchClause' && (parent as CatchClause).param === node) return EMPTY_RESULT;

  // CallExpression callee — handled by CallExpression visitor
  if (pt === 'CallExpression' && (parent as CallExpression).callee === node) return EMPTY_RESULT;
  if (pt === 'NewExpression' && (parent as NewExpression).callee === node) return EMPTY_RESULT;
  // Decorator expression — CALLS deferred created by visitDecorator
  if (pt === 'Decorator') return EMPTY_RESULT;

  // For-in/of left side — declaration, not read
  if ((pt === 'ForInStatement' || pt === 'ForOfStatement') &&
      (parent as ForInStatement).left === node) return EMPTY_RESULT;

  // Global literal-like identifiers → produce LITERAL node
  const LITERAL_GLOBALS = new Set(['undefined', 'NaN', 'Infinity']);
  if (LITERAL_GLOBALS.has(id.name)) {
    const litLine = node.loc?.start.line ?? 0;
    return {
      nodes: [{
        id: ctx.nodeId('LITERAL', id.name, litLine),
        type: 'LITERAL',
        name: id.name,
        file: ctx.file,
        line: litLine,
        column: node.loc?.start.column ?? 0,
        metadata: {
          value: id.name === 'undefined' ? undefined : id.name === 'NaN' ? NaN : Infinity,
          valueType: id.name === 'undefined' ? 'undefined' : 'number',
        },
      }],
      edges: [],
      deferred: [],
    };
  }

  // This IS a read context — emit READS_FROM deferred
  return {
    nodes: [],
    edges: [],
    deferred: [{
      kind: 'scope_lookup',
      name: id.name,
      fromNodeId: '', // placeholder — walk engine will use parentNodeId
      edgeType: 'READS_FROM',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line: node.loc?.start.line ?? 0,
      column: node.loc?.start.column ?? 0,
    }],
  };
}

export function visitThisExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('LITERAL', 'this', line),
      type: 'LITERAL',
      name: 'this',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { value: 'this', literalType: 'keyword' },
    }],
    edges: [],
    deferred: [],
  };
}

export function visitSequenceExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', ',', line),
      type: 'EXPRESSION',
      name: ',',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { operator: ',' },
    }],
    edges: [],
    deferred: [],
  };
}

export function visitParenthesizedExpression(
  _node: Node, _parent: Node | null, _ctx: WalkContext,
): VisitResult {
  return EMPTY_RESULT;
}

export function visitTaggedTemplateExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const tagged = node as TaggedTemplateExpression;
  const line = node.loc?.start.line ?? 0;
  // Use the tag name as the CALL name (e.g., `html`, `css`, `gql`)
  let tagName: string;
  if (tagged.tag.type === 'Identifier') {
    tagName = tagged.tag.name;
  } else if (tagged.tag.type === 'MemberExpression' && tagged.tag.property.type === 'Identifier') {
    const obj = tagged.tag.object.type === 'Identifier' ? tagged.tag.object.name : '?';
    tagName = `${obj}.${tagged.tag.property.name}`;
  } else {
    tagName = 'tagged-template';
  }

  const nodeId = ctx.nodeId('CALL', tagName, line);
  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'CALL',
      name: tagName,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { tagged: true },
    }],
    edges: [],
    deferred: [],
  };

  // Resolve tag function
  if (tagged.tag.type === 'Identifier') {
    result.deferred.push({
      kind: 'scope_lookup',
      name: tagged.tag.name,
      fromNodeId: nodeId,
      edgeType: 'CALLS',
      scopeId: ctx.currentScope.id,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    });
  }

  return result;
}

export function visitClassExpression(
  node: Node, parent: Node | null, ctx: WalkContext,
): VisitResult {
  // Reuse ClassDeclaration logic
  const cls = node as ClassExpression;
  const name = cls.id?.name ?? '<anonymous>';
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('CLASS', name, line);

  ctx.pushScope('class', `${nodeId}$scope`);

  return {
    nodes: [{
      id: nodeId,
      type: 'CLASS',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitObjectExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const obj = node as ObjectExpression;
  const line = node.loc?.start.line ?? 0;
  // Produce LITERAL node for object expressions
  const name = obj.properties.length === 0 ? '{}' : '{...}';
  return {
    nodes: [{
      id: ctx.nodeId('LITERAL', name, line),
      type: 'LITERAL',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { valueType: 'object', properties: obj.properties.length },
    }],
    edges: [],
    deferred: [],
  };
}

export function visitArrayExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const arr = node as ArrayExpression;
  const line = node.loc?.start.line ?? 0;
  // Produce LITERAL node for array expressions
  const name = arr.elements.length === 0 ? '[]' : '[...]';
  return {
    nodes: [{
      id: ctx.nodeId('LITERAL', name, line),
      type: 'LITERAL',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { valueType: 'array', elements: arr.elements.length },
    }],
    edges: [],
    deferred: [],
  };
}

export function visitObjectProperty(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const prop = node as ObjectProperty;
  const name = prop.key.type === 'Identifier' ? prop.key.name
    : prop.key.type === 'StringLiteral' ? (prop.key as StringLiteral).value
    : prop.key.type === 'NumericLiteral' ? String((prop.key as NumericLiteral).value)
    : prop.computed ? computedKeyName(prop.key as Node) : '<computed>';
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('PROPERTY_ACCESS', name, line),
      type: 'PROPERTY_ACCESS',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

/** Extract a human-readable name from a computed member expression property (e.g., arr[0] → [0]) */
function computedPropertyName(prop: Node): string {
  if (prop.type === 'NumericLiteral') return `[${(prop as NumericLiteral).value}]`;
  if (prop.type === 'StringLiteral') return `['${(prop as StringLiteral).value}']`;
  if (prop.type === 'Identifier') return `[${(prop as Identifier).name}]`;
  return '<computed>';
}

function computedKeyName(key: Node): string {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'MemberExpression'
      && key.object.type === 'Identifier'
      && key.property.type === 'Identifier') {
    return `[${key.object.name}.${key.property.name}]`;
  }
  return '<computed>';
}

export function visitObjectMethod(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const method = node as ObjectMethod;
  const name = method.computed ? computedKeyName(method.key as Node)
    : method.key.type === 'Identifier' ? method.key.name
    : method.key.type === 'StringLiteral' ? (method.key as StringLiteral).value
    : method.key.type === 'NumericLiteral' ? String((method.key as NumericLiteral).value)
    : '<computed>';
  const line = node.loc?.start.line ?? 0;

  // Differentiate getter/setter from regular methods — matches ClassMethod behavior
  const nodeType = method.kind === 'get' ? 'GETTER'
    : method.kind === 'set' ? 'SETTER'
    : 'FUNCTION';
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
      metadata: { kind: method.kind },
    }],
    edges: [],
    deferred: [],
  };

  for (const param of method.params) {
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

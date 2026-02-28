/**
 * Visitors for TypeScript-specific AST nodes.
 *
 * All TS nodes that Babel parses: type annotations, interfaces,
 * enums, type aliases, as-expressions, etc.
 */
import type {
  Identifier,
  Node,
  TSArrayType,
  TSAsExpression,
  TSCallSignatureDeclaration,
  TSConditionalType,
  TSConstructSignatureDeclaration,
  TSConstructorType,
  TSDeclareFunction,
  TSDeclareMethod,
  TSEnumDeclaration,
  TSEnumMember,
  TSFunctionType,
  TSIndexSignature,
  TSIndexedAccessType,
  TSInferType,
  TSInterfaceDeclaration,
  TSIntersectionType,
  TSLiteralType,
  TSMappedType,
  TSMethodSignature,
  TSModuleDeclaration,
  TSNonNullExpression,
  TSParameterProperty,
  TSParenthesizedType,
  TSPropertySignature,
  TSQualifiedName,
  TSSatisfiesExpression,
  TSTemplateLiteralType,
  TSTupleType,
  TSTypeAliasDeclaration,
  TSTypeAssertion,
  TSTypeLiteral,
  TSTypeOperator,
  TSTypeParameter,
  TSTypePredicate,
  TSTypeQuery,
  TSTypeReference,
  TSUnionType,
  TemplateLiteral,
} from '@babel/types';
import type { VisitResult, WalkContext } from '../types.js';
import { EMPTY_RESULT, paramTypeRefInfo } from '../types.js';

const passthrough = (_node: Node, _parent: Node | null, _ctx: WalkContext): VisitResult =>
  EMPTY_RESULT;

// ─── TS Keyword type → TYPE_REFERENCE factory ───────────────────────

function makeKeywordVisitor(typeName: string) {
  return function visitKeyword(node: Node, _parent: Node | null, ctx: WalkContext): VisitResult {
    const line = node.loc?.start.line ?? 0;
    return {
      nodes: [{
        id: ctx.nodeId('TYPE_REFERENCE', typeName, line),
        type: 'TYPE_REFERENCE',
        name: typeName,
        file: ctx.file,
        line,
        column: node.loc?.start.column ?? 0,
      }],
      edges: [],
      deferred: [],
    };
  };
}

// ─── Helper: extract readable name from a TS type node ──────────────

function typeToName(t: Node): string {
  switch (t.type) {
    case 'TSTypeReference': {
      const ref = t as TSTypeReference;
      let baseName: string;
      if (ref.typeName.type === 'Identifier') baseName = ref.typeName.name;
      else if (ref.typeName.type === 'TSQualifiedName') {
        const q = ref.typeName as TSQualifiedName;
        baseName = q.left.type === 'Identifier'
          ? `${q.left.name}.${q.right.name}`
          : q.right.name;
      } else {
        baseName = '?';
      }
      if (ref.typeParameters?.params?.length) {
        const args = ref.typeParameters.params.map(typeToName).join(', ');
        return `${baseName}<${args}>`;
      }
      return baseName;
    }
    case 'TSStringKeyword': return 'string';
    case 'TSNumberKeyword': return 'number';
    case 'TSBooleanKeyword': return 'boolean';
    case 'TSAnyKeyword': return 'any';
    case 'TSVoidKeyword': return 'void';
    case 'TSUndefinedKeyword': return 'undefined';
    case 'TSNullKeyword': return 'null';
    case 'TSNeverKeyword': return 'never';
    case 'TSUnknownKeyword': return 'unknown';
    case 'TSSymbolKeyword': return 'symbol';
    case 'TSBigIntKeyword': return 'bigint';
    case 'TSObjectKeyword': return 'object';
    case 'TSThisType': return 'this';
    case 'TSLiteralType': {
      const lt = t as TSLiteralType;
      if (lt.literal.type === 'StringLiteral') return `'${lt.literal.value}'`;
      if ('value' in lt.literal) return String(lt.literal.value);
      return '<literal>';
    }
    case 'TSUnionType': {
      const u = t as TSUnionType;
      return u.types.map(typeToName).join(' | ');
    }
    case 'TSIntersectionType': {
      const i = t as TSIntersectionType;
      return i.types.map(typeToName).join(' & ');
    }
    case 'TSArrayType': {
      const a = t as TSArrayType;
      return `${typeToName(a.elementType)}[]`;
    }
    case 'TSTypeLiteral': {
      const tl = t as TSTypeLiteral;
      const parts: string[] = [];
      for (const m of tl.members) {
        if (m.type === 'TSPropertySignature' && m.key.type === 'Identifier') {
          const valType = m.typeAnnotation?.typeAnnotation
            ? typeToName(m.typeAnnotation.typeAnnotation)
            : '?';
          const ro = m.readonly ? 'readonly ' : '';
          parts.push(`${ro}${m.key.name}: ${valType}`);
        } else if (m.type === 'TSIndexSignature') {
          parts.push('[index]');
        }
      }
      return `{ ${parts.join(', ')} }`;
    }
    case 'TSTypeOperator': {
      const op = t as TSTypeOperator;
      return op.typeAnnotation
        ? `${op.operator} ${typeToName(op.typeAnnotation)}`
        : op.operator ?? 'type-operator';
    }
    case 'TSIndexedAccessType': {
      const ia = t as TSIndexedAccessType;
      return `${typeToName(ia.objectType)}[${typeToName(ia.indexType)}]`;
    }
    case 'TSParenthesizedType': {
      const p = t as TSParenthesizedType;
      return typeToName(p.typeAnnotation);
    }
    case 'TSTypeQuery': {
      const tq = t as TSTypeQuery;
      if (tq.exprName.type === 'Identifier') return `typeof ${tq.exprName.name}`;
      return 'typeof ?';
    }
    case 'TSInferType': {
      const inf = t as TSInferType;
      return `infer ${inf.typeParameter?.name ?? '?'}`;
    }
    case 'TSConditionalType': {
      const ct = t as TSConditionalType;
      return `${typeToName(ct.checkType)} extends ${typeToName(ct.extendsType)}`;
    }
    case 'TSFunctionType': {
      const ft = t as TSFunctionType;
      const ret = ft.typeAnnotation?.typeAnnotation
        ? typeToName(ft.typeAnnotation.typeAnnotation)
        : 'void';
      return `() => ${ret}`;
    }
    case 'TSConstructorType': {
      const ct = t as TSConstructorType;
      const ret = ct.typeAnnotation?.typeAnnotation
        ? typeToName(ct.typeAnnotation.typeAnnotation)
        : 'void';
      const abs = ct.abstract ? 'abstract ' : '';
      return `${abs}new (...args: any[]) => ${ret}`;
    }
    case 'TSTupleType': {
      const tt = t as TSTupleType;
      return `[${tt.elementTypes?.map(typeToName).join(', ') ?? ''}]`;
    }
    default:
      return '?';
  }
}

// ─── Declarations that produce graph nodes ───────────────────────────

export function visitTSInterfaceDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const iface = node as TSInterfaceDeclaration;
  const name = iface.id.name;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('INTERFACE', name, line);
  ctx.declare(name, 'class', nodeId);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'INTERFACE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };

  // Push scope so type parameters are scoped to this interface
  ctx.pushScope('block', `${nodeId}$scope`);

  // interface Foo extends Bar, Baz
  if (iface.extends) {
    for (const ext of iface.extends) {
      if (ext.expression.type === 'Identifier') {
        result.deferred.push({
          kind: 'type_resolve',
          name: ext.expression.name,
          fromNodeId: nodeId,
          edgeType: 'EXTENDS',
          file: ctx.file,
          line,
          column: node.loc?.start.column ?? 0,
        });
      }
    }
  }

  return result;
}

export function visitTSTypeAliasDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const alias = node as TSTypeAliasDeclaration;
  const name = alias.id.name;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('TYPE_ALIAS', name, line);
  ctx.declare(name, 'class', nodeId);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'TYPE_ALIAS',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { isTypeAlias: true },
    }],
    edges: [],
    deferred: [],
  };

  // Push scope so type parameters are scoped to this declaration
  // (prevents T from leaking to module scope and being overwritten by later type aliases)
  ctx.pushScope('block', `${nodeId}$scope`);

  // Type parameters: type Foo<T extends Bar>
  if (alias.typeParameters?.params) {
    for (const tp of alias.typeParameters.params) {
      const tpName = tp.type === 'TSTypeParameter' ? (tp as TSTypeParameter).name ?? '<unnamed>' : '<unnamed>';
      const tpLine = tp.loc?.start.line ?? line;
      const tpId = ctx.nodeId('TYPE_PARAMETER', tpName, tpLine);
      result.nodes.push({
        id: tpId,
        type: 'TYPE_PARAMETER',
        name: tpName,
        file: ctx.file,
        line: tpLine,
        column: tp.loc?.start.column ?? 0,
      });
      result.edges.push({ src: nodeId, dst: tpId, type: 'HAS_TYPE_PARAMETER' });
    }
  }

  return result;
}

export function visitTSEnumDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const en = node as TSEnumDeclaration;
  const name = en.id.name;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('ENUM', name, line);
  ctx.declare(name, 'class', nodeId);
  return {
    nodes: [{
      id: nodeId,
      type: 'ENUM',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitTSEnumMember(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const member = node as TSEnumMember;
  const name = member.id.type === 'Identifier' ? member.id.name : '<computed>';
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('ENUM_MEMBER', name, line),
      type: 'ENUM_MEMBER',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitTSModuleDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const mod = node as TSModuleDeclaration;
  const name = mod.id.type === 'Identifier' ? mod.id.name : String(mod.id.value);
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('NAMESPACE', name, line);
  ctx.declare(name, 'class', nodeId);
  return {
    nodes: [{
      id: nodeId,
      type: 'NAMESPACE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

// ─── Type annotations that produce nodes ─────────────────────────────

export function visitTSTypeAnnotation(
  _node: Node, _parent: Node | null, _ctx: WalkContext,
): VisitResult {
  // Passthrough — the type reference inside it will produce the node
  return EMPTY_RESULT;
}

export function visitTSTypeReference(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const ref = node as TSTypeReference;
  const name = ref.typeName.type === 'Identifier'
    ? ref.typeName.name
    : '<qualified>';
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('TYPE_REFERENCE', name, line);
  return {
    nodes: [{
      id: nodeId,
      type: 'TYPE_REFERENCE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [
      {
        kind: 'type_resolve',
        name,
        fromNodeId: nodeId,
        edgeType: 'HAS_TYPE',
        file: ctx.file,
        line,
        column: node.loc?.start.column ?? 0,
      },
      // RESOLVES_TO: try file-scope resolution first, falls back to project stage
      {
        kind: 'scope_lookup',
        name,
        fromNodeId: nodeId,
        edgeType: 'RESOLVES_TO',
        scopeId: ctx.currentScope.id,
        file: ctx.file,
        line,
        column: node.loc?.start.column ?? 0,
      },
    ],
  };
}

export function visitTSTypeParameter(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const tp = node as TSTypeParameter;
  const name = tp.name ?? '<unnamed>';
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('TYPE_PARAMETER', name, line);

  // Declare type parameter in current scope so TSTypeReference scope_lookups resolve
  ctx.declare(name, 'class', nodeId);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'TYPE_PARAMETER',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };

  // constraint (T extends Foo) and default (T = string) are handled
  // by edge-map: TSTypeParameter.constraint → CONSTRAINED_BY,
  // TSTypeParameter.default → DEFAULTS_TO

  return result;
}

export function visitTSUnionType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const u = node as TSUnionType;
  const name = u.types.map(typeToName).join(' | ');
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', name, line),
      type: 'TYPE_REFERENCE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { union: true },
    }],
    edges: [],
    deferred: [],
  };
}

export function visitTSIntersectionType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const i = node as TSIntersectionType;
  const name = i.types.map(typeToName).join(' & ');
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', name, line),
      type: 'TYPE_REFERENCE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { intersection: true },
    }],
    edges: [],
    deferred: [],
  };
}

export function visitTSLiteralType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const lt = node as TSLiteralType;
  const line = node.loc?.start.line ?? 0;
  const column = node.loc?.start.column ?? 0;

  // Template literal types: TSLiteralType { literal: TemplateLiteral }
  if (lt.literal.type === 'TemplateLiteral') {
    const tpl = lt.literal as TemplateLiteral;
    let name = '`';
    for (let i = 0; i < tpl.quasis.length; i++) {
      name += tpl.quasis[i].value.raw;
      if (i < tpl.expressions.length) {
        const expr = tpl.expressions[i];
        name += '${' + typeToName(expr as Node) + '}';
      }
    }
    name += '`';
    return {
      nodes: [{
        id: ctx.nodeId('TYPE_REFERENCE', name, line),
        type: 'TYPE_REFERENCE',
        name,
        file: ctx.file,
        line,
        column,
        metadata: { templateLiteralType: true },
      }],
      edges: [],
      deferred: [],
    };
  }

  const value = 'value' in lt.literal ? String(lt.literal.value) : '<literal>';
  return {
    nodes: [{
      id: ctx.nodeId('LITERAL_TYPE', value, line),
      type: 'LITERAL_TYPE',
      name: value,
      file: ctx.file,
      line,
      column,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitTSConditionalType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('CONDITIONAL_TYPE', 'conditional', line),
      type: 'CONDITIONAL_TYPE',
      name: 'conditional',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

export function visitTSInferType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const inf = node as TSInferType;
  const name = inf.typeParameter?.name ?? '<infer>';
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('INFER_TYPE', name, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'INFER_TYPE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };

  // INFERS: enclosing conditional type → this infer type
  const ctStack = (ctx as unknown as { _conditionalTypeStack?: string[] })._conditionalTypeStack;
  if (ctStack?.length) {
    result.edges.push({ src: ctStack[ctStack.length - 1], dst: nodeId, type: 'INFERS' });
  }

  return result;
}

// ─── Passthrough: TS syntax that doesn't produce graph nodes ─────────

export const visitTSQualifiedName = passthrough;
export const visitTSTypeParameterInstantiation = passthrough;
export const visitTSTypeParameterDeclaration = passthrough;
export function visitTSFunctionType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const fn = node as TSFunctionType;
  const line = node.loc?.start.line ?? 0;
  const result: VisitResult = {
    nodes: [],
    edges: [],
    deferred: [],
  };
  for (const param of fn.parameters ?? []) {
    if (param.type === 'Identifier') {
      const paramName = param.name;
      const paramLine = param.loc?.start.line ?? line;
      const paramId = ctx.nodeId('PARAMETER', paramName, paramLine);
      result.nodes.push({
        id: paramId,
        type: 'PARAMETER',
        name: paramName,
        file: ctx.file,
        line: paramLine,
        column: param.loc?.start.column ?? 0,
      });
    }
  }
  return result;
}
export function visitTSConstructSignatureDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const sig = node as TSConstructSignatureDeclaration;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('METHOD', 'new', line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'METHOD',
      name: 'new',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { signature: true, construct: true },
    }],
    edges: [],
    deferred: [],
  };

  for (const param of sig.parameters ?? []) {
    if (param.type === 'Identifier') {
      const paramName = (param as Identifier).name;
      const paramLine = param.loc?.start.line ?? line;
      const paramId = ctx.nodeId('PARAMETER', paramName, paramLine);
      result.nodes.push({
        id: paramId,
        type: 'PARAMETER',
        name: paramName,
        file: ctx.file,
        line: paramLine,
        column: param.loc?.start.column ?? 0,
      });
      result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT' });
      ctx.declare(paramName, 'param', paramId);
      const typeRef = paramTypeRefInfo(param);
      if (typeRef) {
        result.edges.push({ src: paramId, dst: ctx.nodeId('TYPE_REFERENCE', typeRef.name, typeRef.line), type: 'HAS_TYPE' });
      }
    }
  }

  return result;
}

export function visitTSCallSignatureDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const sig = node as TSCallSignatureDeclaration;
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('METHOD', '<call>', line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'METHOD',
      name: '<call>',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { signature: true, callSignature: true },
    }],
    edges: [],
    deferred: [],
  };

  for (const param of sig.parameters ?? []) {
    if (param.type === 'Identifier') {
      const paramName = (param as Identifier).name;
      const paramLine = param.loc?.start.line ?? line;
      const paramId = ctx.nodeId('PARAMETER', paramName, paramLine);
      result.nodes.push({
        id: paramId,
        type: 'PARAMETER',
        name: paramName,
        file: ctx.file,
        line: paramLine,
        column: param.loc?.start.column ?? 0,
      });
      result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT' });
      ctx.declare(paramName, 'param', paramId);
      const typeRef = paramTypeRefInfo(param);
      if (typeRef) {
        result.edges.push({ src: paramId, dst: ctx.nodeId('TYPE_REFERENCE', typeRef.name, typeRef.line), type: 'HAS_TYPE' });
      }
    }
  }

  return result;
}
export function visitTSPropertySignature(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const prop = node as TSPropertySignature;
  const name = prop.key.type === 'Identifier'
    ? prop.key.name
    : prop.key.type === 'StringLiteral'
      ? prop.key.value
      : '<computed>';
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('PROPERTY', name, line),
      type: 'PROPERTY',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: {
        optional: prop.optional ?? false,
        readonly: prop.readonly ?? false,
      },
    }],
    edges: [],
    deferred: [],
  };
}

export function visitTSMethodSignature(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const method = node as TSMethodSignature;
  const name = method.key.type === 'Identifier'
    ? method.key.name
    : '<computed>';
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('METHOD', name, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'METHOD',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { signature: true },
    }],
    edges: [],
    deferred: [],
  };

  for (const param of method.parameters ?? []) {
    if (param.type === 'Identifier') {
      const paramName = (param as Identifier).name;
      const paramLine = param.loc?.start.line ?? line;
      const paramId = ctx.nodeId('PARAMETER', paramName, paramLine);
      result.nodes.push({
        id: paramId,
        type: 'PARAMETER',
        name: paramName,
        file: ctx.file,
        line: paramLine,
        column: param.loc?.start.column ?? 0,
      });
      result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT' });
      ctx.declare(paramName, 'param', paramId);
      const typeRef = paramTypeRefInfo(param);
      if (typeRef) {
        result.edges.push({ src: paramId, dst: ctx.nodeId('TYPE_REFERENCE', typeRef.name, typeRef.line), type: 'HAS_TYPE' });
      }
    }
  }

  return result;
}

export function visitTSIndexSignature(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const sig = node as TSIndexSignature;
  const line = node.loc?.start.line ?? 0;
  const result: VisitResult = {
    nodes: [],
    edges: [],
    deferred: [],
  };

  for (const param of sig.parameters ?? []) {
    if (param.type === 'Identifier') {
      const paramName = param.name;
      const paramLine = param.loc?.start.line ?? line;
      const paramId = ctx.nodeId('PARAMETER', paramName, paramLine);
      result.nodes.push({
        id: paramId,
        type: 'PARAMETER',
        name: paramName,
        file: ctx.file,
        line: paramLine,
        column: param.loc?.start.column ?? 0,
      });
    }
  }
  return result;
}
export function visitTSTypePredicate(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const pred = node as TSTypePredicate;
  const line = node.loc?.start.line ?? 0;
  const paramName = pred.parameterName?.type === 'Identifier'
    ? pred.parameterName.name
    : 'this';
  const typePart = pred.typeAnnotation?.typeAnnotation
    ? typeToName(pred.typeAnnotation.typeAnnotation)
    : '?';
  const prefix = pred.asserts ? 'asserts ' : '';
  const name = `${prefix}${paramName} is ${typePart}`;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', name, line),
      type: 'TYPE_REFERENCE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}
export function visitTSTypeOperator(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const op = node as TSTypeOperator;
  const name = typeToName(node);
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', name, line),
      type: 'TYPE_REFERENCE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { operator: op.operator },
    }],
    edges: [],
    deferred: [],
  };
}
export function visitTSIndexedAccessType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const name = typeToName(node);
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', name, line),
      type: 'TYPE_REFERENCE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { indexedAccess: true },
    }],
    edges: [],
    deferred: [],
  };
}
export function visitTSMappedType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const mapped = node as TSMappedType;
  const paramName = mapped.typeParameter?.name ?? 'K';
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', `${paramName}:mapped`, line),
      type: 'TYPE_REFERENCE',
      name: `${paramName}:mapped`,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { mapped: true },
    }],
    edges: [],
    deferred: [],
  };
}
export const visitTSExpressionWithTypeArguments = passthrough;
export const visitTSInterfaceBody = passthrough;
export const visitTSParenthesizedType = passthrough;
export function visitTSArrayType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const name = typeToName(node);
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', name, line),
      type: 'TYPE_REFERENCE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}
export function visitTSTupleType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const name = typeToName(node);
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', name, line),
      type: 'TYPE_REFERENCE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { tuple: true },
    }],
    edges: [],
    deferred: [],
  };
}
export const visitTSOptionalType = passthrough;
export const visitTSRestType = passthrough;
export const visitTSNamedTupleMember = passthrough;
export function visitTSTemplateLiteralType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const tl = node as TSTemplateLiteralType;
  // Build a representation like `${string}-${string}`
  let name = '`';
  for (let i = 0; i < tl.quasis.length; i++) {
    name += tl.quasis[i].value.raw;
    if (i < tl.types.length) {
      const t = tl.types[i];
      const tn = typeToName(t);
      name += '${' + tn + '}';
    }
  }
  name += '`';
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', name, line),
      type: 'TYPE_REFERENCE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { templateLiteralType: true },
    }],
    edges: [],
    deferred: [],
  };
}
export const visitTSAnyKeyword = makeKeywordVisitor('any');
export const visitTSBooleanKeyword = makeKeywordVisitor('boolean');
export const visitTSBigIntKeyword = makeKeywordVisitor('bigint');
export const visitTSIntrinsicKeyword = makeKeywordVisitor('intrinsic');
export const visitTSNeverKeyword = makeKeywordVisitor('never');
export const visitTSNullKeyword = makeKeywordVisitor('null');
export const visitTSNumberKeyword = makeKeywordVisitor('number');
export const visitTSObjectKeyword = makeKeywordVisitor('object');
export const visitTSStringKeyword = makeKeywordVisitor('string');
export const visitTSSymbolKeyword = makeKeywordVisitor('symbol');
export const visitTSUndefinedKeyword = makeKeywordVisitor('undefined');
export const visitTSUnknownKeyword = makeKeywordVisitor('unknown');
export const visitTSVoidKeyword = makeKeywordVisitor('void');
export const visitTSThisType = makeKeywordVisitor('this');
export function visitTSTypeQuery(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const q = node as TSTypeQuery;
  const name = q.exprName.type === 'Identifier'
    ? q.exprName.name
    : '<qualified>';
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', `typeof ${name}`, line),
      type: 'TYPE_REFERENCE',
      name: `typeof ${name}`,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { typeQuery: true },
    }],
    edges: [],
    deferred: [],
  };
}
export function visitTSTypeLiteral(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const name = typeToName(node);
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', name, line),
      type: 'TYPE_REFERENCE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { objectType: true },
    }],
    edges: [],
    deferred: [],
  };
}
export function visitTSAsExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const as = node as TSAsExpression;
  const line = node.loc?.start.line ?? 0;
  // Name: expr `as` type
  const exprName = as.expression.type === 'Identifier' ? as.expression.name : '?';
  const typeName = as.typeAnnotation.type === 'TSTypeReference'
      && (as.typeAnnotation as TSTypeReference).typeName.type === 'Identifier'
    ? ((as.typeAnnotation as TSTypeReference).typeName as Identifier).name
    : '?';
  const name = `${exprName} as ${typeName}`;
  return {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', name, line),
      type: 'EXPRESSION',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}
export function visitTSSatisfiesExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const sat = node as TSSatisfiesExpression;
  const line = node.loc?.start.line ?? 0;
  const exprName = sat.expression.type === 'Identifier' ? sat.expression.name : '?';
  const typeName = sat.typeAnnotation.type === 'TSTypeReference'
      && (sat.typeAnnotation as TSTypeReference).typeName.type === 'Identifier'
    ? ((sat.typeAnnotation as TSTypeReference).typeName as Identifier).name
    : '?';
  const name = `${exprName} satisfies ${typeName}`;
  return {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', name, line),
      type: 'EXPRESSION',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}
export function visitTSTypeAssertion(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const ta = node as TSTypeAssertion;
  const line = node.loc?.start.line ?? 0;
  const typeName = ta.typeAnnotation.type === 'TSTypeReference'
      && (ta.typeAnnotation as TSTypeReference).typeName.type === 'Identifier'
    ? ((ta.typeAnnotation as TSTypeReference).typeName as Identifier).name
    : '?';
  const exprName = ta.expression.type === 'Identifier' ? ta.expression.name : '?';
  const name = `<${typeName}>${exprName}`;
  return {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', name, line),
      type: 'EXPRESSION',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}
export function visitTSNonNullExpression(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const nn = node as TSNonNullExpression;
  const line = node.loc?.start.line ?? 0;
  const exprName = nn.expression.type === 'Identifier' ? nn.expression.name
    : nn.expression.type === 'CallExpression' ? '?()' : '?';
  const name = `${exprName}!`;
  return {
    nodes: [{
      id: ctx.nodeId('EXPRESSION', name, line),
      type: 'EXPRESSION',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}
export const visitTSInstantiationExpression = passthrough;
export const visitTSImportType = passthrough;
export const visitTSExternalModuleReference = passthrough;
export const visitTSModuleBlock = passthrough;
export const visitTSImportEqualsDeclaration = passthrough;
export const visitTSExportAssignment = passthrough;
export const visitTSNamespaceExportDeclaration = passthrough;
export function visitTSDeclareFunction(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const fn = node as TSDeclareFunction;
  const name = fn.id?.name ?? '<anonymous>';
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('FUNCTION', `${name}$overload`, line);

  // Don't declare in scope — the real implementation declares the name
  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'FUNCTION',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { isOverload: true, declare: fn.declare },
    }],
    edges: [],
    deferred: [],
  };

  for (const param of fn.params ?? []) {
    if (param.type === 'Identifier') {
      const paramName = (param as Identifier).name;
      const paramLine = param.loc?.start.line ?? line;
      const paramId = ctx.nodeId('PARAMETER', paramName, paramLine);
      result.nodes.push({
        id: paramId,
        type: 'PARAMETER',
        name: paramName,
        file: ctx.file,
        line: paramLine,
        column: param.loc?.start.column ?? 0,
      });
      result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT' });
      ctx.declare(paramName, 'param', paramId);
      const typeRef = paramTypeRefInfo(param);
      if (typeRef) {
        result.edges.push({ src: paramId, dst: ctx.nodeId('TYPE_REFERENCE', typeRef.name, typeRef.line), type: 'HAS_TYPE' });
      }
    }
  }

  return result;
}
export function visitTSDeclareMethod(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const method = node as TSDeclareMethod;
  const name = method.key.type === 'Identifier'
    ? method.key.name
    : '<computed>';
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('METHOD', `${name}$overload`, line);

  const result: VisitResult = {
    nodes: [{
      id: nodeId,
      type: 'METHOD',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: { isOverload: true, kind: method.kind },
    }],
    edges: [],
    deferred: [],
  };

  for (const param of method.params ?? []) {
    if (param.type === 'Identifier') {
      const paramName = param.name;
      const paramLine = param.loc?.start.line ?? line;
      const paramId = ctx.nodeId('PARAMETER', paramName, paramLine);
      result.nodes.push({
        id: paramId,
        type: 'PARAMETER',
        name: paramName,
        file: ctx.file,
        line: paramLine,
        column: param.loc?.start.column ?? 0,
      });
      result.edges.push({ src: nodeId, dst: paramId, type: 'RECEIVES_ARGUMENT' });
      const typeRef = paramTypeRefInfo(param);
      if (typeRef) {
        result.edges.push({ src: paramId, dst: ctx.nodeId('TYPE_REFERENCE', typeRef.name, typeRef.line), type: 'HAS_TYPE' });
      }
    }
  }

  return result;
}
export const visitTSTemplateParameterInstantiation = passthrough;
export function visitTSParameterProperty(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const pp = node as TSParameterProperty;
  // TSParameterProperty wraps a param (Identifier or AssignmentPattern)
  // constructor(private name: string) or constructor(readonly x = 5)
  const param = pp.parameter;
  const name = param.type === 'Identifier'
    ? param.name
    : param.type === 'AssignmentPattern' && param.left.type === 'Identifier'
      ? param.left.name
      : null;
  if (!name) return EMPTY_RESULT;

  const line = node.loc?.start.line ?? 0;
  const paramId = ctx.nodeId('PARAMETER', name, line);

  ctx.declare(name, 'param', paramId);

  const result: VisitResult = {
    nodes: [{
      id: paramId,
      type: 'PARAMETER',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: {
        accessibility: pp.accessibility ?? undefined,
        readonly: pp.readonly ?? undefined,
      },
    }],
    edges: [],
    deferred: [],
  };

  // TSParameterProperty creates a class property — emit PROPERTY + DECLARES edge
  if (pp.accessibility || pp.readonly) {
    const classStack = (ctx as unknown as { _classStack?: string[] })._classStack;
    let className = '';
    if (classStack?.length) {
      // nodeId format: file->CLASS->ClassName#line
      const classNodeId = classStack[classStack.length - 1];
      const classMatch = classNodeId.match(/->CLASS->(.+?)#/);
      if (classMatch) className = classMatch[1];
    }
    const propName = className ? `${className}.${name}` : name;
    const propId = ctx.nodeId('PROPERTY', propName, line);
    result.nodes.push({
      id: propId,
      type: 'PROPERTY',
      name: propName,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      metadata: {
        accessibility: pp.accessibility ?? undefined,
        readonly: pp.readonly ?? undefined,
      },
    });
    result.edges.push({ src: paramId, dst: propId, type: 'DECLARES' });
  }

  return result;
}
export function visitTSConstructorType(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const name = typeToName(node);
  const line = node.loc?.start.line ?? 0;
  return {
    nodes: [{
      id: ctx.nodeId('TYPE_REFERENCE', name, line),
      type: 'TYPE_REFERENCE',
      name,
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
    }],
    edges: [],
    deferred: [],
  };
}

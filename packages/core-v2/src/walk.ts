/**
 * Walk engine — Stage 1 + Stage 2 of the three-stage pipeline.
 *
 * Single recursive pass over Babel AST. Dispatches each node
 * to its visitor function from the registry. Manages scope stack.
 *
 * Scope management:
 *   Visitors push scopes (function, block, class, catch, with).
 *   Walk engine auto-pops after all children are visited.
 *   DeferredRefs capture the current scope ID at creation time.
 *   Stage 2 resolves file-scoped refs using scope registry.
 *
 * Invariant 1: throws if AST node type has no registered visitor.
 * Invariant 2: after walk, every non-MODULE node must have a CONTAINS edge.
 * Invariant 3: every edge src/dst must reference a known node or deferred ref.
 */
import { parse } from '@babel/parser';
import type { Node, File } from '@babel/types';
import type {
  VisitorRegistry,
  WalkContext,
  GraphNode,
  GraphEdge,
  DeferredRef,
  ScopeNode,
  ScopeKind,
  DeclKind,
  FileResult,
} from './types.js';
import {
  ScopeRegistry,
  createModuleScope,
  createChildScope,
  declare as scopeDeclare,
  scopeLookup,
} from './scope.js';
import { EDGE_MAP } from './edge-map.js';

// ─── Parse ───────────────────────────────────────────────────────────

export function parseFile(code: string, file: string): File {
  return parse(code, {
    sourceType: 'unambiguous',
    plugins: [
      'typescript',
      'jsx',
      'decorators',
      'classProperties',
      'classPrivateProperties',
      'classPrivateMethods',
      'exportDefaultFrom',
      'exportNamespaceFrom',
      'dynamicImport',
      'nullishCoalescingOperator',
      'optionalChaining',
      'optionalCatchBinding',
      'topLevelAwait',
      'importMeta',
      'importAssertions',
    ],
    sourceFilename: file,
    errorRecovery: true,
  });
}

// ─── Walk Context Implementation ─────────────────────────────────────

interface InternalWalkContext extends WalkContext {
  _scopeStack: ScopeNode[];
  _rootScope: ScopeNode;
  _scopeRegistry: ScopeRegistry;
  /** Stack of enclosing FUNCTION/METHOD node IDs (for RETURNS, YIELDS, AWAITS) */
  _functionStack: string[];
  /** Stack of enclosing CLASS node IDs (for DECORATED_BY etc.) */
  _classStack: string[];
  /** Stack of enclosing CONDITIONAL_TYPE node IDs (for INFERS) */
  _conditionalTypeStack: string[];
  /** Collected DECLARES edges (scope owner → declared node) */
  _declareEdges: GraphEdge[];
}

function createWalkContext(file: string, moduleId: string, strict: boolean): InternalWalkContext {
  const registry = new ScopeRegistry();
  const rootScope = createModuleScope(moduleId, strict, registry);
  const scopeStack: ScopeNode[] = [rootScope];

  return {
    file,
    moduleId,
    _scopeStack: scopeStack,
    _rootScope: rootScope,
    _scopeRegistry: registry,
    _functionStack: [],
    _classStack: [],
    _conditionalTypeStack: [],
    _declareEdges: [],

    get currentScope(): ScopeNode {
      return scopeStack[scopeStack.length - 1];
    },

    pushScope(kind: ScopeKind, id: string): ScopeNode {
      const child = createChildScope(this.currentScope, kind, id, registry);
      scopeStack.push(child);
      return child;
    },

    popScope(): void {
      if (scopeStack.length <= 1) {
        throw new Error(`FATAL: cannot pop module scope in ${file}`);
      }
      scopeStack.pop();
    },

    declare(name: string, kind: DeclKind, nodeId: string): string | null {
      const shadowedId = scopeDeclare(this.currentScope, name, kind, nodeId);

      // DECLARES: nearest function/class/module scope → declared node
      const DECLARING_KINDS = new Set(['function', 'module', 'class']);
      let declaringScope = kind === 'var' ? this.currentScope.hoistTarget : this.currentScope;
      while (!DECLARING_KINDS.has(declaringScope.kind) && declaringScope.parent) {
        declaringScope = declaringScope.parent;
      }
      const ownerId = declaringScope.id.replace(/\$scope$/, '');
      this._declareEdges.push({ src: ownerId, dst: nodeId, type: 'DECLARES' });

      return shadowedId;
    },

    nodeId(type: string, name: string, line: number): string {
      return `${file}->${type}->${name}#${line}`;
    },
  };
}

// ─── AST Children ────────────────────────────────────────────────────

const CHILD_KEYS: Record<string, string[]> = {};
let visitorKeysLoaded = false;

async function ensureVisitorKeys(): Promise<void> {
  if (visitorKeysLoaded) return;
  try {
    const babelTypes = await import('@babel/types');
    const vk = babelTypes.VISITOR_KEYS as Record<string, string[]>;
    for (const [type, keys] of Object.entries(vk)) {
      CHILD_KEYS[type] = keys;
    }
  } catch {
    // Fall through
  }
  visitorKeysLoaded = true;
}

/** Walk up from a scope to find the nearest enclosing function scope. */
function findEnclosingFunctionScope(scope: ScopeNode): ScopeNode | null {
  let current: ScopeNode | null = scope;
  while (current) {
    if (current.kind === 'function') return current;
    current = current.parent;
  }
  return null;
}

// ─── Walk ────────────────────────────────────────────────────────────

export async function walkFile(
  code: string,
  file: string,
  registry: VisitorRegistry,
  strict = true,
): Promise<FileResult> {
  await ensureVisitorKeys();

  const ast = parseFile(code, file);
  const moduleId = `MODULE#${file}`;
  const ctx = createWalkContext(file, moduleId, strict);

  const allNodes: GraphNode[] = [];
  const allEdges: GraphEdge[] = [];
  const allDeferred: DeferredRef[] = [];

  // MODULE node
  allNodes.push({
    id: moduleId,
    type: 'MODULE',
    name: file,
    file,
    line: 1,
    column: 0,
  });

  // FILE node (physical file representation)
  const fileId = `FILE#${file}`;
  allNodes.push({
    id: fileId,
    type: 'FILE',
    name: file,
    file,
    line: 1,
    column: 0,
  });
  allEdges.push({ src: fileId, dst: moduleId, type: 'CONTAINS' });

  // ─── Recursive walk with auto scope-pop ──────────────────────────

  function visit(node: Node, parent: Node | null, parentNodeId: string, edgeType: string = 'CONTAINS'): void {
    const visitor = registry[node.type];
    if (!visitor) {
      const loc = node.loc?.start;
      throw new Error(
        `FATAL: no visitor for AST node type "${node.type}" ` +
        `at ${file}:${loc?.line ?? '?'}:${loc?.column ?? '?'}`,
      );
    }

    // Snapshot scope depth BEFORE visitor runs
    const scopeDepthBefore = ctx._scopeStack.length;

    const result = visitor(node, parent, ctx);

    // Collect results
    for (const n of result.nodes) allNodes.push(n);
    for (const e of result.edges) allEdges.push(e);
    for (const d of result.deferred) {
      // Fill in fromNodeId for deferred refs that don't know their parent graph node
      if (!d.fromNodeId) d.fromNodeId = parentNodeId;
      allDeferred.push(d);
    }

    // Structural edge from parent graph node to first result node
    if (result.nodes.length > 0) {
      allEdges.push({
        src: parentNodeId,
        dst: result.nodes[0].id,
        type: edgeType,
      });
    }

    // Track enclosing function/class for srcFrom resolution
    const thisNodeId = result.nodes.length > 0 ? result.nodes[0].id : null;
    const thisNodeType = result.nodes.length > 0 ? result.nodes[0].type : null;
    const isFunctionLike = thisNodeType === 'FUNCTION' || thisNodeType === 'METHOD'
      || thisNodeType === 'GETTER' || thisNodeType === 'SETTER';
    const isClassLike = thisNodeType === 'CLASS';
    const isConditionalType = thisNodeType === 'CONDITIONAL_TYPE';

    if (isFunctionLike && thisNodeId) ctx._functionStack.push(thisNodeId);
    if (isClassLike && thisNodeId) ctx._classStack.push(thisNodeId);
    if (isConditionalType && thisNodeId) ctx._conditionalTypeStack.push(thisNodeId);

    // HAS_SCOPE: if visitor pushed a scope and produced a graph node, emit edge
    // Skip when the owning node IS already a scope node (standalone blocks, finally blocks)
    const SCOPE_NODE_TYPES = new Set(['SCOPE', 'FINALLY_BLOCK', 'CATCH_BLOCK']);
    if (ctx._scopeStack.length > scopeDepthBefore && thisNodeId && !SCOPE_NODE_TYPES.has(thisNodeType!)) {
      const pushedScope = ctx._scopeStack[ctx._scopeStack.length - 1];
      const scopeGraphId = `SCOPE#${pushedScope.id}`;
      allNodes.push({
        id: scopeGraphId,
        type: 'SCOPE',
        name: pushedScope.kind,
        file,
        line: node.loc?.start.line ?? 0,
        column: node.loc?.start.column ?? 0,
        metadata: { scopeKind: pushedScope.kind },
      });
      allEdges.push({ src: thisNodeId, dst: scopeGraphId, type: 'HAS_SCOPE' });
    }

    // Walk children — key-aware, checks EDGE_MAP per (parentASTType, childKey)
    const childParentId = thisNodeId ?? parentNodeId;
    // When this node is a passthrough (no graph nodes), propagate the incoming
    // edgeType to children so that e.g. ForStatement.init → VariableDeclaration
    // → VariableDeclarator gets HAS_INIT (not CONTAINS).
    const isPassthrough = result.nodes.length === 0;
    const keys = CHILD_KEYS[node.type] || [];
    const record = node as unknown as Record<string, unknown>;

    for (const key of keys) {
      const mapKey = `${node.type}.${key}`;
      const mapping = EDGE_MAP[mapKey];

      let childEdgeType: string;
      let edgeSrc: string;

      if (mapping) {
        // Explicit edge map entry — always use it
        childEdgeType = mapping.edgeType;
        edgeSrc = childParentId;
        if (mapping.srcFrom === 'enclosingFunction') {
          edgeSrc = ctx._functionStack.length > 0
            ? ctx._functionStack[ctx._functionStack.length - 1]
            : childParentId;
        } else if (mapping.srcFrom === 'enclosingClass') {
          edgeSrc = ctx._classStack.length > 0
            ? ctx._classStack[ctx._classStack.length - 1]
            : childParentId;
        } else if (mapping.srcFrom === 'grandparent') {
          edgeSrc = parentNodeId;
        }
      } else if (isPassthrough) {
        // No mapping + passthrough: propagate incoming edge type and source
        childEdgeType = edgeType;
        edgeSrc = parentNodeId;
      } else {
        // Default: CONTAINS from this node
        childEdgeType = 'CONTAINS';
        edgeSrc = childParentId;
      }

      const val = record[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object' && 'type' in item) {
            visit(item as Node, node, edgeSrc, childEdgeType);
          }
        }
      } else if (val && typeof val === 'object' && 'type' in val) {
        visit(val as Node, node, edgeSrc, childEdgeType);
      }
    }

    // Pop function/class/conditional-type stacks
    if (isFunctionLike && thisNodeId) ctx._functionStack.pop();
    if (isClassLike && thisNodeId) ctx._classStack.pop();
    if (isConditionalType && thisNodeId) ctx._conditionalTypeStack.pop();

    // AUTO-POP: restore scope depth to what it was before this visitor.
    while (ctx._scopeStack.length > scopeDepthBefore) {
      ctx.popScope();
    }
  }

  // Start from Program body
  const program = ast.program;
  for (const stmt of program.body) {
    visit(stmt, program, moduleId);
  }

  // ─── Post-walk: detect TS overload groups ──────────────────────

  const overloads = allNodes.filter(n => n.type === 'FUNCTION' && n.metadata?.isOverload);
  if (overloads.length > 0) {
    const implsByName = new Map<string, GraphNode>();
    for (const n of allNodes) {
      if (n.type === 'FUNCTION' && !n.metadata?.isOverload && n.file === file) {
        implsByName.set(n.name, n);
      }
    }
    for (const overload of overloads) {
      const impl = implsByName.get(overload.name);
      if (impl) {
        allEdges.push({ src: impl.id, dst: overload.id, type: 'HAS_OVERLOAD' });
        allEdges.push({ src: overload.id, dst: impl.id, type: 'IMPLEMENTS_OVERLOAD' });
      }
    }
  }

  // ─── Post-walk: detect OVERRIDES (child method overrides parent method) ──

  // Build class→methods and class→superClass maps
  const classNodes = allNodes.filter(n => n.type === 'CLASS');
  if (classNodes.length > 1) {
    // Map: classNodeId → method names → methodNodeId
    const classMethods = new Map<string, Map<string, string>>();
    for (const edge of allEdges) {
      if (edge.type === 'CONTAINS') {
        const methodNode = allNodes.find(n => n.id === edge.dst && (n.type === 'METHOD' || n.type === 'GETTER' || n.type === 'SETTER'));
        if (methodNode) {
          let methods = classMethods.get(edge.src);
          if (!methods) {
            methods = new Map();
            classMethods.set(edge.src, methods);
          }
          methods.set(methodNode.name, methodNode.id);
        }
      }
    }

    // For each class with a superClass metadata, find the parent class in same file
    const classById = new Map<string, { name: string; superClass?: string }>();
    for (const cls of classNodes) {
      classById.set(cls.id, { name: cls.name, superClass: cls.metadata?.superClass as string | undefined });
    }
    const classByName = new Map<string, string>();
    for (const cls of classNodes) {
      classByName.set(cls.name, cls.id);
    }

    for (const cls of classNodes) {
      const superName = cls.metadata?.superClass as string | undefined;
      if (!superName) continue;
      const parentId = classByName.get(superName);
      if (!parentId) continue;

      const childMethods = classMethods.get(cls.id);
      const parentMethods = classMethods.get(parentId);
      if (!childMethods || !parentMethods) continue;

      for (const [methodName, childMethodId] of childMethods) {
        const parentMethodId = parentMethods.get(methodName);
        if (parentMethodId) {
          allEdges.push({ src: childMethodId, dst: parentMethodId, type: 'OVERRIDES' });
        }
      }
    }
  }

  // ─── Stage 2: File-scope resolution ────────────────────────────

  const resolvedEdges: GraphEdge[] = [];
  const unresolvedRefs: DeferredRef[] = [];

  for (const ref of allDeferred) {
    if (ref.kind === 'scope_lookup') {
      // Find the scope where this ref was created
      const refScope = ref.scopeId
        ? ctx._scopeRegistry.get(ref.scopeId)
        : ctx._rootScope;

      if (!refScope) {
        // Scope not found — shouldn't happen, but defensive
        unresolvedRefs.push(ref);
        continue;
      }

      const result = scopeLookup(ref.name, refScope);
      if (result.kind === 'found') {
        resolvedEdges.push({
          src: ref.fromNodeId,
          dst: result.nodeId,
          type: ref.edgeType,
        });
        // CAPTURES: if lookup crossed a function boundary, the enclosing
        // function captures the outer variable (closure capture)
        if (result.crossedFunction && ctx._functionStack.length === 0) {
          // We can't use _functionStack here (it's for walk-time).
          // Instead, find enclosing function from the scope chain.
          const enclosingFn = findEnclosingFunctionScope(refScope);
          if (enclosingFn) {
            // The function scope's ID is `functionNodeId$scope` — strip $scope
            const fnNodeId = enclosingFn.id.replace(/\$scope$/, '');
            if (fnNodeId !== result.nodeId) {
              resolvedEdges.push({
                src: fnNodeId,
                dst: result.nodeId,
                type: 'CAPTURES',
              });
            }
          }
        }
      } else if (result.kind === 'ambiguous') {
        // with() scope — mark as unresolved with reason
        unresolvedRefs.push(ref);
      } else {
        // not_found — could be global, import, or typo
        unresolvedRefs.push(ref);
      }
    } else if (ref.kind === 'export_lookup') {
      // Exports resolve from module scope
      const result = scopeLookup(ref.name, ctx._rootScope);
      if (result.kind === 'found') {
        resolvedEdges.push({
          src: ref.fromNodeId,
          dst: result.nodeId,
          type: ref.edgeType,
        });
      } else {
        unresolvedRefs.push(ref);
      }
    } else {
      // Project-stage deferred (import_resolve, call_resolve, type_resolve, alias_resolve)
      unresolvedRefs.push(ref);
    }
  }

  return {
    file,
    moduleId,
    nodes: allNodes,
    edges: [...allEdges, ...resolvedEdges, ...ctx._declareEdges],
    unresolvedRefs,
    scopeTree: ctx._rootScope,
  };
}

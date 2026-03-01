/**
 * Core v2 types — the entire type system for the three-stage pipeline.
 *
 * Stage 1 (Walk):  AST node → GraphNode[] + GraphEdge[] + DeferredRef[]
 * Stage 2 (File):  DeferredRef(file-scope) → GraphEdge[]
 * Stage 3 (Project): DeferredRef(cross-file) → GraphEdge[]
 */

// ─── Graph Primitives ────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  file: string;
  line: number;
  column: number;
  exported?: boolean;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  src: string;
  dst: string;
  type: string;
  metadata?: Record<string, unknown>;
}

// ─── Visitor Contract ────────────────────────────────────────────────

/**
 * Every visitor returns this. Pure data, no side effects.
 */
export interface VisitResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  deferred: DeferredRef[];
}

export const EMPTY_RESULT: VisitResult = { nodes: [], edges: [], deferred: [] };

// ─── Deferred References ─────────────────────────────────────────────

/**
 * 6 concrete lookup types — cover ALL 64 edge types.
 * File-stage: scope_lookup, export_lookup
 * Project-stage: import_resolve, call_resolve, type_resolve, alias_resolve
 */
export type DeferredKind =
  | 'scope_lookup'
  | 'export_lookup'
  | 'import_resolve'
  | 'call_resolve'
  | 'type_resolve'
  | 'alias_resolve';

export interface DeferredRef {
  kind: DeferredKind;
  /** The name to look up (variable name, import specifier, type name, etc.) */
  name: string;
  /** Graph node ID of the source end of the edge */
  fromNodeId: string;
  /** Edge type to create when resolved */
  edgeType: string;
  /** Scope chain at point of reference (for scope_lookup) */
  scopeId?: string;
  /** Source module specifier (for import_resolve) */
  source?: string;
  /** Location for diagnostics */
  file: string;
  line: number;
  column: number;
  /** Receiver context for call_resolve (class node ID if inside class with `this`) */
  receiver?: string;
}

// ─── Scope Tree ──────────────────────────────────────────────────────

export type ScopeKind = 'global' | 'module' | 'function' | 'block' | 'class' | 'with' | 'catch';
export type DeclKind = 'var' | 'let' | 'const' | 'function' | 'class' | 'param' | 'import' | 'catch';

export interface Declaration {
  nodeId: string;
  kind: DeclKind;
  name: string;
}

export interface ScopeNode {
  id: string;
  kind: ScopeKind;
  strict: boolean;
  parent: ScopeNode | null;
  children: ScopeNode[];
  declarations: Map<string, Declaration>;
  /** For var hoisting: nearest function/module scope */
  hoistTarget: ScopeNode;
  /** For 'with' scopes: the object node being with'd */
  withObjectId?: string;
}

// ─── Scope Lookup Result ─────────────────────────────────────────────

export type ScopeLookupResult =
  | { kind: 'found'; nodeId: string; declaration: Declaration; crossedFunction: boolean }
  | { kind: 'ambiguous'; withObjectId: string; outerResult: ScopeLookupResult | null }
  | { kind: 'not_found' };

// ─── Walk Context ────────────────────────────────────────────────────

/**
 * Passed to every visitor. Provides file info and scope management.
 * Visitors call ctx methods to register declarations and create scopes.
 */
export interface WalkContext {
  /** Relative file path (for node IDs and file fields) */
  file: string;
  /** Current module ID */
  moduleId: string;
  /** Current scope (visitors read, walk engine manages) */
  currentScope: ScopeNode;

  /** Push a new scope (called by block/function/class visitors) */
  pushScope(kind: ScopeKind, id: string): ScopeNode;
  /** Pop current scope (called on exit) */
  popScope(): void;
  /** Register a declaration in current scope (handles var hoisting).
   *  Returns shadowed node ID if this declaration shadows an ancestor. */
  declare(name: string, kind: DeclKind, nodeId: string): string | null;
  /** Generate a unique node ID */
  nodeId(type: string, name: string, line: number): string;
}

// ─── Visitor Registry ────────────────────────────────────────────────

import type { Node, File } from '@babel/types';

/**
 * A visitor function. Pure: (node, parent, ctx) → VisitResult.
 * Must not access anything outside its arguments.
 */
export type VisitorFn = (node: Node, parent: Node | null, ctx: WalkContext) => VisitResult;

/**
 * Map of AST node type → visitor function.
 * Invariant 1: every AST node type encountered must have an entry.
 */
export type VisitorRegistry = Record<string, VisitorFn>;

// ─── Parameter Type Annotation Helper ─────────────────────────────────

const TS_KEYWORD_MAP: Record<string, string> = {
  TSStringKeyword: 'string', TSNumberKeyword: 'number', TSBooleanKeyword: 'boolean',
  TSAnyKeyword: 'any', TSVoidKeyword: 'void', TSNullKeyword: 'null',
  TSNeverKeyword: 'never', TSUnknownKeyword: 'unknown', TSUndefinedKeyword: 'undefined',
  TSObjectKeyword: 'object', TSSymbolKeyword: 'symbol', TSBigIntKeyword: 'bigint',
};

/**
 * Extract the type name and line from a parameter's type annotation.
 * Returns null for complex types (unions, intersections, etc.) that need
 * richer handling.
 */
export function paramTypeRefInfo(param: Node): { name: string; line: number } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = param as any;
  const typeAnno = p.typeAnnotation;
  if (!typeAnno || typeAnno.type !== 'TSTypeAnnotation') return null;
  const inner = typeAnno.typeAnnotation;
  if (!inner) return null;

  const line = inner.loc?.start.line ?? 0;

  if (inner.type === 'TSTypeReference' && inner.typeName?.type === 'Identifier') {
    return { name: inner.typeName.name, line };
  }

  const name = TS_KEYWORD_MAP[inner.type];
  return name ? { name, line } : null;
}

// ─── File Result (output of Stage 1+2 per file) ─────────────────────

export interface FileResult {
  file: string;
  moduleId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Unresolved refs that need Stage 3 (cross-file) */
  unresolvedRefs: DeferredRef[];
  /** Scope tree (for diagnostics / debugging) */
  scopeTree: ScopeNode;
}

// ─── Domain Plugin API ───────────────────────────────────────────────

/**
 * What a domain plugin returns for one file.
 * All required arrays may be empty but must not be undefined.
 * deferred is optional — omit if the plugin creates no cross-file refs.
 */
export interface DomainPluginResult {
  /** Additional graph nodes to merge into FileResult. Must not duplicate existing node IDs. */
  nodes: GraphNode[];
  /** Additional graph edges to merge into FileResult. */
  edges: GraphEdge[];
  /**
   * Optional deferred refs for cross-file resolution.
   * Use kinds: import_resolve, call_resolve, type_resolve, alias_resolve.
   * Do NOT emit scope_lookup or export_lookup — Stage 2 is already complete.
   */
  deferred?: DeferredRef[];
}

/**
 * A domain plugin analyzes one file INSIDE walkFile(), after Stage 2 (file-scope resolution).
 *
 * Contracts (not enforced at runtime — violation is a plugin bug):
 *   - Pure function: no I/O, no file reads, no side effects, no mutations.
 *   - Must not mutate fileResult or ast.
 *   - Must only CREATE new nodes/edges — never replicate or modify existing ones.
 *   - Node IDs must be globally unique; use the file path as prefix.
 *   - Return empty arrays for files that have no relevant patterns.
 *
 * When to implement DomainPlugin:
 *   - Detecting framework patterns (Express routes, Socket.IO events, DB queries).
 *   - Pattern is expressible as: scan CALL nodes where metadata.object/method match X/Y.
 *   - Need string argument values from calls (paths, event names, SQL strings).
 *
 * When NOT to use DomainPlugin:
 *   - Need to modify existing graph nodes (not supported by design).
 *   - Need cross-file context at detection time (use Stage 3 instead).
 *   - Analyzing a non-JS/TS language (needs a separate entry point).
 *   - Plugin needs state across files (domain plugins are stateless per-file).
 */
export interface DomainPlugin {
  /**
   * Unique plugin name. Lowercase, no spaces.
   * Used in log messages and error reporting.
   * Examples: "express", "socketio", "fetch", "database".
   */
  readonly name: string;

  /**
   * Called once per file inside walkFile(), after Stage 2 (file-scope resolution).
   *
   * @param fileResult  The completed per-file analysis. Read-only by contract.
   *                    Contains all CALL, IMPORT, MODULE, EXTERNAL nodes.
   * @param ast         The parsed Babel File node from the SAME parse as walkFile used.
   *                    Available as escape hatch for patterns that cannot be expressed
   *                    via fileResult.nodes alone (e.g., nested route builders).
   *                    Most plugins will not need this.
   * @returns           Additional nodes and edges to merge. Empty arrays are valid.
   */
  analyzeFile(
    fileResult: Readonly<FileResult>,
    ast: File,
  ): DomainPluginResult;
}

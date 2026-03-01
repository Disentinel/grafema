/**
 * Stage 2.5: File-level name-based resolution.
 * Stage 3: Project-level resolution.
 *
 * Stage 2.5 resolves unresolved refs against same-file declarations
 * by name matching (forward refs, out-of-scope same-file decls).
 *
 * Stage 3 takes FileResult[] from Stage 1+2, builds in-memory indices,
 * resolves cross-file deferred refs into edges.
 *
 * 4 resolver types:
 *   import_resolve  → IMPORTS_FROM
 *   call_resolve    → CALLS
 *   type_resolve    → HAS_TYPE, EXTENDS, IMPLEMENTS, overloads
 *   alias_resolve   → ALIASES, RESOLVES_TO, DERIVES_FROM, MERGES_WITH, OVERRIDES
 */
import type { FileResult, GraphEdge, GraphNode, DeferredRef } from './types.js';
import type { BuiltinRegistry } from '@grafema/lang-defs';

// ─── Stage 2.5: File-level name resolution ──────────────────────────

/** Node types eligible for same-file name resolution */
const DECLARABLE_TYPES = new Set([
  'FUNCTION', 'VARIABLE', 'CONSTANT', 'CLASS', 'PARAMETER', 'METHOD',
  'INTERFACE', 'TYPE_ALIAS', 'NAMESPACE', 'ENUM', 'TYPE_PARAMETER',
  'PROPERTY', 'GETTER', 'SETTER', 'EXTERNAL',
]);

/**
 * Stage 2.5: File-level name-based resolution.
 *
 * After scope_lookup/export_lookup in walkFile(),
 * remaining unresolved refs are tried against declared nodes
 * in the same file by name matching. Catches forward refs,
 * out-of-scope same-file declarations.
 *
 * Returns a new FileResult — does not mutate the input.
 */
export function resolveFileRefs(result: FileResult): FileResult {
  if (!result.unresolvedRefs || result.unresolvedRefs.length === 0) {
    return result;
  }

  // Build name → nodes index for declarable types
  const declared = new Map<string, GraphNode[]>();
  for (const n of result.nodes) {
    if (DECLARABLE_TYPES.has(n.type)) {
      const arr = declared.get(n.name);
      if (arr) arr.push(n);
      else declared.set(n.name, [n]);
    }
  }

  const newEdges: GraphEdge[] = [];
  const stillUnresolved: DeferredRef[] = [];

  for (const ref of result.unresolvedRefs) {
    const targets = declared.get(ref.name);
    if (targets && targets.length > 0) {
      // Pick closest target by line proximity
      const target = targets.length === 1 ? targets[0]
        : targets.reduce((best, t) => {
            const dist = Math.abs(t.line - ref.line);
            const bestDist = Math.abs(best.line - ref.line);
            return dist < bestDist ? t : best;
          });
      newEdges.push({
        src: ref.fromNodeId,
        dst: target.id,
        type: ref.edgeType,
        ...(ref.metadata ? { metadata: ref.metadata } : {}),
      });
    } else {
      stillUnresolved.push(ref);
    }
  }

  return {
    file: result.file,
    moduleId: result.moduleId,
    nodes: result.nodes,
    edges: [...result.edges, ...newEdges],
    unresolvedRefs: stillUnresolved,
    scopeTree: result.scopeTree,
  };
}

// ─── Project Index ───────────────────────────────────────────────────

export class ProjectIndex {
  /** name → nodes with that name (across all files) */
  private byName = new Map<string, GraphNode[]>();
  /** type:name → nodes (for call_resolve: find FUNCTION named X) */
  private byTypeName = new Map<string, GraphNode[]>();
  /** file → exported name → node */
  private exports = new Map<string, Map<string, GraphNode>>();
  /** file → module node */
  private modules = new Map<string, GraphNode>();
  /** all nodes by ID for O(1) lookup */
  private byId = new Map<string, GraphNode>();
  /** file → name → DeferredRef[] for re-export chain resolution */
  private importResolveByFile = new Map<string, Map<string, DeferredRef[]>>();

  constructor(results: FileResult[]) {
    for (const result of results) {
      // Index module node
      const moduleNode = result.nodes.find(n => n.type === 'MODULE');
      if (moduleNode) {
        this.modules.set(result.file, moduleNode);
      }

      for (const node of result.nodes) {
        this.byId.set(node.id, node);

        // By name
        const byName = this.byName.get(node.name);
        if (byName) byName.push(node);
        else this.byName.set(node.name, [node]);

        // By type:name
        const key = `${node.type}:${node.name}`;
        const byTN = this.byTypeName.get(key);
        if (byTN) byTN.push(node);
        else this.byTypeName.set(key, [node]);

        // Exports
        if (node.exported) {
          let fileExports = this.exports.get(node.file);
          if (!fileExports) {
            fileExports = new Map();
            this.exports.set(node.file, fileExports);
          }
          fileExports.set(node.name, node);
        }
      }

      // Also index EXPORT nodes' edges to find what they export
      for (const edge of result.edges) {
        if (edge.type === 'EXPORTS') {
          const exportNode = this.byId.get(edge.src);
          const targetNode = this.byId.get(edge.dst);
          if (exportNode && targetNode) {
            let fileExports = this.exports.get(targetNode.file);
            if (!fileExports) {
              fileExports = new Map();
              this.exports.set(targetNode.file, fileExports);
            }
            fileExports.set(exportNode.name, targetNode);
          }
        }
      }

      // Index import_resolve refs for re-export chain resolution
      for (const ref of result.unresolvedRefs) {
        if (ref.kind === 'import_resolve' && ref.source) {
          let fileRefs = this.importResolveByFile.get(result.file);
          if (!fileRefs) {
            fileRefs = new Map();
            this.importResolveByFile.set(result.file, fileRefs);
          }
          const existing = fileRefs.get(ref.name);
          if (existing) existing.push(ref);
          else fileRefs.set(ref.name, [ref]);
        }
      }
    }
  }

  findByName(name: string): GraphNode[] {
    return this.byName.get(name) || [];
  }

  findByTypeName(type: string, name: string): GraphNode[] {
    return this.byTypeName.get(`${type}:${name}`) || [];
  }

  findExport(file: string, name: string): GraphNode | undefined {
    return this.exports.get(file)?.get(name);
  }

  getModule(file: string): GraphNode | undefined {
    return this.modules.get(file);
  }

  getNode(id: string): GraphNode | undefined {
    return this.byId.get(id);
  }

  getImportResolveRefs(file: string, name: string): DeferredRef[] {
    return this.importResolveByFile.get(file)?.get(name) || [];
  }

  get nodeCount(): number {
    return this.byId.size;
  }
}

// ─── Module Resolution ───────────────────────────────────────────────

/**
 * Resolve a bare package specifier to a file within the project.
 *
 * Handles:
 *   - Exact: `@grafema/types` → looks up entrypoint in packageMap
 *   - Subpath: `@grafema/types/edges` → strip package prefix, resolve relative to package src dir
 */
function resolvePackageImport(
  source: string,
  knownFiles: Set<string>,
  packageMap: Record<string, string>,
): string | null {
  // Exact match: '@grafema/types' → 'packages/types/src/index.ts'
  const exact = packageMap[source];
  if (exact && knownFiles.has(exact)) return exact;

  // Subpath: find longest matching package prefix
  let bestPrefix = '';
  let bestEntry = '';
  for (const [pkg, entry] of Object.entries(packageMap)) {
    if (source.startsWith(pkg + '/') && pkg.length > bestPrefix.length) {
      bestPrefix = pkg;
      bestEntry = entry;
    }
  }

  if (!bestPrefix) return null;

  // Strip package prefix, resolve relative to package's src directory
  const subpath = source.slice(bestPrefix.length + 1); // e.g. 'edges' from '@grafema/types/edges'
  const pkgDir = bestEntry.replace(/\/[^/]+$/, ''); // e.g. 'packages/types/src'
  const resolved = `${pkgDir}/${subpath}`;

  // Try exact
  if (knownFiles.has(resolved)) return resolved;

  // Try extensions
  for (const ext of ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs']) {
    if (knownFiles.has(resolved + ext)) return resolved + ext;
  }

  // Try index files
  for (const ext of ['/index.js', '/index.ts', '/index.tsx']) {
    if (knownFiles.has(resolved + ext)) return resolved + ext;
  }

  return null;
}

/**
 * Resolve a module specifier to a file path.
 * Simple: strip relative prefix, try common extensions.
 */
function resolveModulePath(
  source: string,
  fromFile: string,
  knownFiles: Set<string>,
  packageMap?: Record<string, string>,
): string | null {
  if (!source.startsWith('.')) {
    if (packageMap) {
      const resolved = resolvePackageImport(source, knownFiles, packageMap);
      if (resolved) return resolved;
    }
    return null;
  }

  // Resolve relative path
  const fromDir = fromFile.replace(/\/[^/]+$/, '');
  const resolved = normalizePath(`${fromDir}/${source}`);

  // Try exact match
  if (knownFiles.has(resolved)) return resolved;

  // TypeScript convention: import from './foo.js' but actual file is foo.ts
  // Strip .js/.jsx/.mjs/.cjs and try .ts/.tsx equivalents
  const tsRemapped = remapTsExtension(resolved);
  if (tsRemapped && knownFiles.has(tsRemapped)) return tsRemapped;

  // Try appending extensions (for extensionless imports)
  for (const ext of ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs']) {
    if (knownFiles.has(resolved + ext)) return resolved + ext;
  }

  // Try index files
  for (const ext of ['/index.js', '/index.ts', '/index.tsx']) {
    if (knownFiles.has(resolved + ext)) return resolved + ext;
  }

  return null;
}

/** Remap TS-style .js imports to actual .ts files. */
function remapTsExtension(path: string): string | null {
  if (path.endsWith('.js')) return path.slice(0, -3) + '.ts';
  if (path.endsWith('.jsx')) return path.slice(0, -4) + '.tsx';
  if (path.endsWith('.mjs')) return path.slice(0, -4) + '.mts';
  if (path.endsWith('.cjs')) return path.slice(0, -4) + '.cts';
  return null;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
}

// ─── Resolvers ───────────────────────────────────────────────────────

export class AmbiguousBuiltinError extends Error {
  constructor(public method: string, public types: string[]) {
    super(`Ambiguous builtin: ${method} exists on ${types.join(', ')}`);
  }
}

export interface ResolveResult {
  edges: GraphEdge[];
  nodes: GraphNode[];
  unresolved: DeferredRef[];
  stats: {
    importResolved: number;
    callResolved: number;
    typeResolved: number;
    aliasResolved: number;
    unresolved: number;
    ambiguousBuiltin: number;
    builtinInferred: number;
    derivesFrom: number;
    instanceOf: number;
    importsToModule: number;
    reExportResolved: number;
    argsLinked: number;
    issuesCreated: number;
  };
}

export function resolveProject(
  results: FileResult[],
  builtins?: BuiltinRegistry,
  packageMap?: Record<string, string>,
): ResolveResult {
  const index = new ProjectIndex(results);
  const knownFiles = new Set(results.map(r => r.file));

  const edges: GraphEdge[] = [];
  const nodes: GraphNode[] = [];
  const unresolved: DeferredRef[] = [];
  const unresolvedImports: DeferredRef[] = [];
  const stats = {
    importResolved: 0,
    callResolved: 0,
    typeResolved: 0,
    aliasResolved: 0,
    unresolved: 0,
    ambiguousBuiltin: 0,
    builtinInferred: 0,
    derivesFrom: 0,
    instanceOf: 0,
    importsToModule: 0,
    reExportResolved: 0,
    argsLinked: 0,
    issuesCreated: 0,
  };

  // Collect all per-file edges for receiver type inference
  const fileEdges: GraphEdge[] = [];
  for (const result of results) {
    fileEdges.push(...result.edges);
  }

  // Phase 1: Resolve deferred refs (single-hop)
  for (const result of results) {
    for (const ref of result.unresolvedRefs) {
      switch (ref.kind) {
        case 'import_resolve': {
          const resolved = resolveImport(ref, index, knownFiles, packageMap);
          if (resolved.length > 0) {
            edges.push(...resolved);
            stats.importResolved++;
            for (const e of resolved) {
              if (e.type === 'IMPORTS') stats.importsToModule++;
            }
          } else {
            unresolvedImports.push(ref);
          }
          break;
        }

        case 'call_resolve': {
          try {
            const resolved = resolveCall(ref, index, builtins);
            if (resolved) {
              edges.push(resolved);
              stats.callResolved++;
            } else {
              unresolved.push(ref);
              stats.unresolved++;
            }
          } catch (e) {
            if (e instanceof AmbiguousBuiltinError) {
              const inferred = inferReceiverType(ref, index, fileEdges, e.types);
              if (inferred) {
                const targetId = `EXTERNAL#${inferred}`;
                if (index.getNode(targetId)) {
                  edges.push({ src: ref.fromNodeId, dst: targetId, type: ref.edgeType });
                  stats.callResolved++;
                  stats.builtinInferred++;
                } else {
                  unresolved.push(ref);
                  stats.ambiguousBuiltin++;
                }
              } else {
                unresolved.push(ref);
                stats.ambiguousBuiltin++;
              }
            } else throw e;
          }
          break;
        }

        case 'type_resolve': {
          const resolved = resolveType(ref, index);
          if (resolved) {
            edges.push(resolved);
            stats.typeResolved++;
          } else {
            unresolved.push(ref);
            stats.unresolved++;
          }
          break;
        }

        case 'alias_resolve': {
          const resolved = resolveAlias(ref, index);
          if (resolved) {
            edges.push(resolved);
            stats.aliasResolved++;
          } else {
            unresolved.push(ref);
            stats.unresolved++;
          }
          break;
        }

        default:
          // scope_lookup / export_lookup should have been resolved in Stage 2
          unresolved.push(ref);
          stats.unresolved++;
      }
    }
  }

  // Phase 2: Re-export chain resolution for remaining import_resolve refs
  for (const ref of unresolvedImports) {
    const resolved = resolveImportViaReExportChain(ref, index, knownFiles, packageMap);
    if (resolved.length > 0) {
      edges.push(...resolved);
      stats.reExportResolved++;
      for (const e of resolved) {
        if (e.type === 'IMPORTS') stats.importsToModule++;
      }
    } else {
      unresolved.push(ref);
      stats.unresolved++;
    }
  }

  // Phase 3: Derived edges
  const allEdges = collectAllEdges(results, edges);

  const derivesFromEdges = deriveTransitiveExtends(allEdges);
  edges.push(...derivesFromEdges);
  stats.derivesFrom = derivesFromEdges.length;

  const instanceOfEdges = deriveInstanceOf(results, allEdges, index);
  edges.push(...instanceOfEdges);
  stats.instanceOf = instanceOfEdges.length;

  const computedAccessEdges = deriveComputedAccessElementOf(results, [...allEdges, ...instanceOfEdges]);
  edges.push(...computedAccessEdges);

  const mapGetEdges = deriveMapGetElementOf(results, [...allEdges, ...instanceOfEdges], index);
  edges.push(...mapGetEdges);

  // Phase 3 continued: link call arguments to function parameters
  const allNodesForLinking: GraphNode[] = [];
  for (const result of results) {
    allNodesForLinking.push(...result.nodes);
  }
  const updatedAllEdges = collectAllEdges(results, edges);
  const linkResult = linkArgumentsToParameters(allNodesForLinking, updatedAllEdges, index);
  edges.push(...linkResult.edges);
  nodes.push(...linkResult.nodes);
  stats.argsLinked = linkResult.argsLinked;
  stats.issuesCreated = linkResult.issuesCreated;

  return { edges, nodes, unresolved, stats };
}

// ─── Argument-Parameter Linker ────────────────────────────────────────

interface ArgInfo {
  argIndex: number;
  dst: string;
}

interface ParamInfo {
  paramIndex: number;
  paramId: string;
  isRest: boolean;
  isDestructured: boolean;
}

interface LinkResult {
  edges: GraphEdge[];
  nodes: GraphNode[];
  argsLinked: number;
  issuesCreated: number;
}

/**
 * Link call arguments to function parameters by position.
 * Emits PARAMETER → ARG_BINDING → argument_node edges with { argIndex, callId } metadata.
 * Also emits ISSUE nodes for extra arguments and unresolved calls.
 */
function linkArgumentsToParameters(
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
  index: ProjectIndex,
): LinkResult {
  const edges: GraphEdge[] = [];
  const nodes: GraphNode[] = [];
  let argsLinked = 0;
  let issuesCreated = 0;

  // Build callToArgs map: for each PASSES_ARGUMENT edge, group by src (callId)
  const callToArgs = new Map<string, ArgInfo[]>();
  for (const edge of allEdges) {
    if (edge.type === 'PASSES_ARGUMENT') {
      const argIndex = (edge.metadata?.argIndex as number) ?? -1;
      let args = callToArgs.get(edge.src);
      if (!args) {
        args = [];
        callToArgs.set(edge.src, args);
      }
      args.push({ argIndex, dst: edge.dst });
    }
  }

  // Build targetToParams map: for each RECEIVES_ARGUMENT edge, group by src (function/method)
  const targetToParams = new Map<string, ParamInfo[]>();
  for (const edge of allEdges) {
    if (edge.type === 'RECEIVES_ARGUMENT') {
      const paramIndex = (edge.metadata?.paramIndex as number) ?? -1;
      const paramNode = index.getNode(edge.dst);
      const isRest = paramNode?.metadata?.rest === true;
      const isDestructured = paramNode?.metadata?.destructured === true;
      let params = targetToParams.get(edge.src);
      if (!params) {
        params = [];
        targetToParams.set(edge.src, params);
      }
      params.push({ paramIndex, paramId: edge.dst, isRest, isDestructured });
    }
  }

  // Build sets for resolved calls: src of CALLS or CALLS_ON edges
  const callsWithAnyEdge = new Set<string>();
  const callToTargets = new Map<string, { dst: string; type: string }[]>();
  for (const edge of allEdges) {
    if (edge.type === 'CALLS' || edge.type === 'CALLS_ON') {
      callsWithAnyEdge.add(edge.src);
      let targets = callToTargets.get(edge.src);
      if (!targets) {
        targets = [];
        callToTargets.set(edge.src, targets);
      }
      targets.push({ dst: edge.dst, type: edge.type });
    }
  }

  // Build HAS_MEMBER index for constructor resolution (new Foo())
  const classToConstructor = new Map<string, string>();
  for (const edge of allEdges) {
    if (edge.type === 'HAS_MEMBER') {
      const memberNode = index.getNode(edge.dst);
      if (memberNode && memberNode.type === 'METHOD' && memberNode.name === 'constructor') {
        classToConstructor.set(edge.src, edge.dst);
      }
    }
  }

  // Build ASSIGNED_FROM index for variable→callable resolution (const fn = () => {})
  const assignedFrom = new Map<string, string[]>();
  // Build IMPORTS_FROM index for import→callable resolution (import { greet } from './a.js')
  const importsFromMap = new Map<string, string[]>();
  for (const edge of allEdges) {
    if (edge.type === 'ASSIGNED_FROM') {
      let targets = assignedFrom.get(edge.src);
      if (!targets) {
        targets = [];
        assignedFrom.set(edge.src, targets);
      }
      targets.push(edge.dst);
    } else if (edge.type === 'IMPORTS_FROM') {
      let targets = importsFromMap.get(edge.src);
      if (!targets) {
        targets = [];
        importsFromMap.set(edge.src, targets);
      }
      targets.push(edge.dst);
    }
  }

  const CALLABLE_TYPES = new Set(['FUNCTION', 'METHOD', 'GETTER', 'SETTER']);

  /**
   * Resolve a CALLS target to its actual callable entity.
   * Follows VARIABLE → ASSIGNED_FROM → FUNCTION chains and CLASS → constructor.
   * Returns the node ID that has RECEIVES_ARGUMENT edges, or null.
   */
  function resolveCallableTarget(targetId: string): string | null {
    const targetNode = index.getNode(targetId);
    if (!targetNode) return null;

    // Direct callable
    if (CALLABLE_TYPES.has(targetNode.type)) return targetId;

    // CLASS → constructor
    if (targetNode.type === 'CLASS') {
      const constructorId = classToConstructor.get(targetId);
      return constructorId ?? null;
    }

    // VARIABLE/CONSTANT → follow ASSIGNED_FROM to find callable
    if (targetNode.type === 'VARIABLE' || targetNode.type === 'CONSTANT') {
      const assigned = assignedFrom.get(targetId);
      if (assigned) {
        for (const dstId of assigned) {
          const dstNode = index.getNode(dstId);
          if (dstNode && CALLABLE_TYPES.has(dstNode.type)) return dstId;
          // Could be a CLASS assigned to a variable
          if (dstNode && dstNode.type === 'CLASS') {
            const constructorId = classToConstructor.get(dstId);
            if (constructorId) return constructorId;
          }
        }
      }
      return null;
    }

    // IMPORT → follow IMPORTS_FROM to find the actual callable in source
    if (targetNode.type === 'IMPORT') {
      const imports = importsFromMap.get(targetId);
      if (imports) {
        for (const dstId of imports) {
          const dstNode = index.getNode(dstId);
          if (dstNode && CALLABLE_TYPES.has(dstNode.type)) return dstId;
          if (dstNode && dstNode.type === 'CLASS') {
            const constructorId = classToConstructor.get(dstId);
            if (constructorId) return constructorId;
          }
        }
      }
      return null;
    }

    return null;
  }

  // For each eligible call → target edge, match args to params
  for (const [callId, targets] of callToTargets) {
    const args = callToArgs.get(callId);
    if (!args || args.length === 0) continue;

    for (const { dst: targetId, type: edgeType } of targets) {
      const targetNode = index.getNode(targetId);
      if (!targetNode) continue;

      // For CALLS_ON edges: target must be METHOD/FUNCTION/GETTER/SETTER
      if (edgeType === 'CALLS_ON') {
        if (!CALLABLE_TYPES.has(targetNode.type)) continue;
      }

      // Resolve to actual callable
      const paramsTarget = resolveCallableTarget(targetId);
      if (!paramsTarget) continue;

      const params = targetToParams.get(paramsTarget);
      if (!params || params.length === 0) continue;

      // Sort params by paramIndex
      const sortedParams = [...params].sort((a, b) => a.paramIndex - b.paramIndex);

      // Find rest param
      const restParam = sortedParams.find(p => p.isRest);
      const restParamIndex = restParam ? restParam.paramIndex : -1;

      // Sort args by argIndex
      const sortedArgs = [...args].sort((a, b) => a.argIndex - b.argIndex);

      for (const arg of sortedArgs) {
        if (arg.argIndex < 0) continue;

        // Check if arg is a spread
        const argNode = index.getNode(arg.dst);
        const isSpread = argNode?.type === 'EXPRESSION' && argNode?.name === 'spread';

        if (isSpread) {
          // Spread arg at rest position → link to rest param, then stop
          if (restParam && arg.argIndex >= restParamIndex) {
            edges.push({
              src: restParam.paramId,
              dst: arg.dst,
              type: 'ARG_BINDING',
              metadata: { argIndex: arg.argIndex, callId },
            });
            argsLinked++;
          }
          continue;
        }

        if (restParamIndex >= 0 && arg.argIndex >= restParamIndex) {
          // Link to rest param
          edges.push({
            src: restParam!.paramId,
            dst: arg.dst,
            type: 'ARG_BINDING',
            metadata: { argIndex: arg.argIndex, callId },
          });
          argsLinked++;
        } else if (arg.argIndex < sortedParams.length) {
          // Normal positional match
          const param = sortedParams[arg.argIndex];
          if (param) {
            edges.push({
              src: param.paramId,
              dst: arg.dst,
              type: 'ARG_BINDING',
              metadata: { argIndex: arg.argIndex, callId },
            });
            argsLinked++;
          }
        } else {
          // Extra argument — no matching param and no rest param
          const callNode = index.getNode(callId);
          const issueId = `ISSUE#extra-argument:${callId}:${arg.argIndex}`;
          nodes.push({
            id: issueId,
            type: 'ISSUE',
            name: 'issue:extra-argument',
            file: callNode?.file ?? '<unknown>',
            line: callNode?.line ?? 0,
            column: callNode?.column ?? 0,
            metadata: {
              issueKind: 'extra-argument',
              callId,
              argIndex: arg.argIndex,
              targetId: paramsTarget,
            },
          });
          issuesCreated++;
        }
      }
    }
  }

  // Emit issue:unresolved-call for CALL nodes that have PASSES_ARGUMENT but NO CALLS AND NO CALLS_ON
  for (const [callId] of callToArgs) {
    if (callsWithAnyEdge.has(callId)) continue;
    // Verify this is actually a CALL node
    const callNode = index.getNode(callId);
    if (!callNode || callNode.type !== 'CALL') continue;
    const issueId = `ISSUE#unresolved-call:${callId}`;
    nodes.push({
      id: issueId,
      type: 'ISSUE',
      name: 'issue:unresolved-call',
      file: callNode.file,
      line: callNode.line,
      column: callNode.column,
      metadata: {
        issueKind: 'unresolved-call',
        callId,
        calleeName: callNode.name,
      },
    });
    issuesCreated++;
  }

  return { edges, nodes, argsLinked, issuesCreated };
}

// ─── Import Resolver ─────────────────────────────────────────────────

function resolveImport(
  ref: DeferredRef,
  index: ProjectIndex,
  knownFiles: Set<string>,
  packageMap?: Record<string, string>,
): GraphEdge[] {
  if (!ref.source) return [];

  const targetFile = resolveModulePath(ref.source, ref.file, knownFiles, packageMap);
  if (!targetFile) {
    // External module — link to EXTERNAL node created by walker
    const externalId = `${ref.file}->EXTERNAL->${ref.source}#0`;
    const externalNode = index.getNode(externalId);
    if (externalNode) {
      return [{ src: ref.fromNodeId, dst: externalId, type: ref.edgeType }];
    }
    return [];
  }

  const moduleNode = index.getModule(targetFile);

  if (ref.name === '*') {
    // import * — link to module
    if (moduleNode) {
      return [{ src: ref.fromNodeId, dst: moduleNode.id, type: ref.edgeType }];
    }
    return [];
  }

  if (ref.name === 'default') {
    // import default — find default export
    const exported = index.findExport(targetFile, 'default');
    if (exported) {
      const edges: GraphEdge[] = [
        { src: ref.fromNodeId, dst: exported.id, type: ref.edgeType },
      ];
      if (moduleNode) {
        edges.push({ src: ref.fromNodeId, dst: moduleNode.id, type: 'IMPORTS' });
      }
      return edges;
    }
    return [];
  }

  // Named import
  const exported = index.findExport(targetFile, ref.name);
  if (exported) {
    const edges: GraphEdge[] = [
      { src: ref.fromNodeId, dst: exported.id, type: ref.edgeType },
    ];
    if (moduleNode) {
      edges.push({ src: ref.fromNodeId, dst: moduleNode.id, type: 'IMPORTS' });
    }
    return edges;
  }

  return [];
}

// ─── Receiver Type Inference ─────────────────────────────────────────

function inferReceiverType(
  ref: DeferredRef,
  index: ProjectIndex,
  allFileEdges: GraphEdge[],
  ambiguousTypes: string[],
): string | null {
  // Strategy 1: this/super → check enclosing class EXTENDS edges
  if (ref.receiver) {
    const classNode = index.getNode(ref.receiver);
    if (classNode) {
      for (const edge of allFileEdges) {
        if (edge.src === classNode.id && edge.type === 'EXTENDS') {
          const parent = index.getNode(edge.dst);
          if (parent && ambiguousTypes.includes(parent.name)) {
            return parent.name;
          }
        }
      }
    }
  }

  // Strategy 2: CHAINS_FROM → infer from previous method's type
  const callNode = index.getNode(ref.fromNodeId);
  if (callNode) {
    for (const edge of allFileEdges) {
      if (edge.src === callNode.id && edge.type === 'CHAINS_FROM') {
        const prevCall = index.getNode(edge.dst);
        if (prevCall?.metadata?.method) {
          const builtins = index.findByTypeName('EXTERNAL', prevCall.metadata.method as string);
          if (builtins.length === 0) {
            // Look up in the builtin registry via the CALLS_ON edges from prevCall
            for (const callEdge of allFileEdges) {
              if (callEdge.src === prevCall.id && callEdge.type === 'CALLS_ON') {
                const target = index.getNode(callEdge.dst);
                if (target?.type === 'EXTERNAL' && ambiguousTypes.includes(target.name)) {
                  return target.name;
                }
              }
            }
          }
        }
      }
    }
  }

  return null;
}

// ─── Call Resolver ───────────────────────────────────────────────────

function resolveCall(
  ref: DeferredRef,
  index: ProjectIndex,
  builtins?: BuiltinRegistry,
): GraphEdge | null {
  // Find FUNCTION or METHOD with matching name
  const functions = index.findByTypeName('FUNCTION', ref.name);
  if (functions.length === 1) {
    return { src: ref.fromNodeId, dst: functions[0].id, type: ref.edgeType };
  }

  // Multiple matches — try same file first
  if (functions.length > 1) {
    const sameFile = functions.find(f => f.file === ref.file);
    if (sameFile) {
      return { src: ref.fromNodeId, dst: sameFile.id, type: ref.edgeType };
    }
    // Ambiguous — pick first (could be improved with scope info)
    return { src: ref.fromNodeId, dst: functions[0].id, type: ref.edgeType };
  }

  // Try METHOD
  const methods = index.findByTypeName('METHOD', ref.name);
  if (methods.length >= 1) {
    return { src: ref.fromNodeId, dst: methods[0].id, type: ref.edgeType };
  }

  // Try CLASS (for new X())
  const classes = index.findByTypeName('CLASS', ref.name);
  if (classes.length >= 1) {
    return { src: ref.fromNodeId, dst: classes[0].id, type: ref.edgeType };
  }

  // Builtin fallback: resolve method calls to EXTERNAL#Type nodes
  if (builtins) {
    const types = builtins.resolveMethod(ref.name);
    if (types.length === 1) {
      const targetId = `EXTERNAL#${types[0]}`;
      if (index.getNode(targetId)) {
        return { src: ref.fromNodeId, dst: targetId, type: ref.edgeType };
      }
    }
    if (types.length > 1) {
      throw new AmbiguousBuiltinError(ref.name, types);
    }
  }

  return null;
}

// ─── Type Resolver ───────────────────────────────────────────────────

function resolveType(ref: DeferredRef, index: ProjectIndex): GraphEdge | null {
  // Find INTERFACE
  const interfaces = index.findByTypeName('INTERFACE', ref.name);
  if (interfaces.length >= 1) {
    return { src: ref.fromNodeId, dst: interfaces[0].id, type: ref.edgeType };
  }

  // Find CLASS
  const classes = index.findByTypeName('CLASS', ref.name);
  if (classes.length >= 1) {
    return { src: ref.fromNodeId, dst: classes[0].id, type: ref.edgeType };
  }

  // Find TYPE_ALIAS
  const aliases = index.findByTypeName('TYPE_ALIAS', ref.name);
  if (aliases.length >= 1) {
    return { src: ref.fromNodeId, dst: aliases[0].id, type: ref.edgeType };
  }

  // Find ENUM
  const enums = index.findByTypeName('ENUM', ref.name);
  if (enums.length >= 1) {
    return { src: ref.fromNodeId, dst: enums[0].id, type: ref.edgeType };
  }

  // Fallback: follow import chain to EXTERNAL node
  // For external types like `NodePath` from '@babel/traverse',
  // find the IMPORT node → derive EXTERNAL node from its source metadata
  const imports = index.findByTypeName('IMPORT', ref.name);
  const imp = imports.find(n => n.file === ref.file) || imports[0];
  if (imp && imp.metadata?.source) {
    const externalId = `${imp.file}->EXTERNAL->${imp.metadata.source}#0`;
    const externalNode = index.getNode(externalId);
    if (externalNode) {
      return { src: ref.fromNodeId, dst: externalId, type: ref.edgeType };
    }
  }

  return null;
}

// ─── Alias Resolver ──────────────────────────────────────────────────

function resolveAlias(ref: DeferredRef, index: ProjectIndex): GraphEdge | null {
  // Find any node with matching name
  const nodes = index.findByName(ref.name);
  if (nodes.length >= 1) {
    // Prefer same file
    const sameFile = nodes.find(n => n.file === ref.file);
    return { src: ref.fromNodeId, dst: (sameFile || nodes[0]).id, type: ref.edgeType };
  }
  return null;
}

// ─── Re-export Chain Resolver ────────────────────────────────────────

/**
 * Resolve an import by following re-export chains in barrel files.
 * Handles both `export { X } from './sub'` and `export * from './sub'`.
 */
function resolveImportViaReExportChain(
  ref: DeferredRef,
  index: ProjectIndex,
  knownFiles: Set<string>,
  packageMap?: Record<string, string>,
): GraphEdge[] {
  if (!ref.source || ref.name === '*') return [];

  const targetFile = resolveModulePath(ref.source, ref.file, knownFiles, packageMap);
  if (!targetFile) return [];

  const resolved = followReExportChain(ref.name, targetFile, index, knownFiles, packageMap);
  if (!resolved) return [];

  const edges: GraphEdge[] = [
    { src: ref.fromNodeId, dst: resolved.id, type: ref.edgeType },
  ];
  const moduleNode = index.getModule(targetFile);
  if (moduleNode) {
    edges.push({ src: ref.fromNodeId, dst: moduleNode.id, type: 'IMPORTS' });
  }
  return edges;
}

/**
 * BFS through re-export chains to find the actual exported node.
 * Follows both named re-exports (`export { X } from`) and
 * star re-exports (`export * from`), up to a bounded depth.
 */
function followReExportChain(
  name: string,
  startFile: string,
  index: ProjectIndex,
  knownFiles: Set<string>,
  packageMap?: Record<string, string>,
): GraphNode | null {
  const visited = new Set<string>();
  const queue: string[] = [startFile];

  for (let i = 0; i < queue.length && i < 20; i++) {
    const currentFile = queue[i];
    if (visited.has(currentFile)) continue;
    visited.add(currentFile);

    // Named re-export: export { X } from './sub'
    for (const ref of index.getImportResolveRefs(currentFile, name)) {
      if (!ref.source) continue;
      const nextFile = resolveModulePath(ref.source, currentFile, knownFiles, packageMap);
      if (!nextFile) continue;
      const exported = index.findExport(nextFile, name);
      if (exported) return exported;
      queue.push(nextFile);
    }

    // Star re-export: export * from './sub'
    for (const ref of index.getImportResolveRefs(currentFile, '*')) {
      if (!ref.source) continue;
      const nextFile = resolveModulePath(ref.source, currentFile, knownFiles, packageMap);
      if (!nextFile) continue;
      const exported = index.findExport(nextFile, name);
      if (exported) return exported;
      queue.push(nextFile);
    }
  }

  return null;
}

// ─── Derived Edges ───────────────────────────────────────────────────

/** Collect all edges: per-file edges + newly resolved project-stage edges. */
function collectAllEdges(results: FileResult[], resolvedEdges: GraphEdge[]): GraphEdge[] {
  const all: GraphEdge[] = [...resolvedEdges];
  for (const result of results) {
    all.push(...result.edges);
  }
  return all;
}

/**
 * DERIVES_FROM: transitive closure of EXTENDS.
 * A extends B extends C → A -DERIVES_FROM-> B, A -DERIVES_FROM-> C.
 */
function deriveTransitiveExtends(allEdges: GraphEdge[]): GraphEdge[] {
  // Build parent map from EXTENDS edges
  const parentMap = new Map<string, string[]>();
  for (const edge of allEdges) {
    if (edge.type === 'EXTENDS') {
      const parents = parentMap.get(edge.src);
      if (parents) parents.push(edge.dst);
      else parentMap.set(edge.src, [edge.dst]);
    }
  }

  const derived: GraphEdge[] = [];

  for (const [childId] of parentMap) {
    const visited = new Set<string>();
    const queue = [...(parentMap.get(childId) || [])];

    for (let i = 0; i < queue.length; i++) {
      const ancestorId = queue[i];
      if (visited.has(ancestorId)) continue;
      visited.add(ancestorId);

      derived.push({ src: childId, dst: ancestorId, type: 'DERIVES_FROM' });

      const grandparents = parentMap.get(ancestorId);
      if (grandparents) {
        for (const gp of grandparents) {
          if (!visited.has(gp)) queue.push(gp);
        }
      }
    }
  }

  return derived;
}

/**
 * INSTANCE_OF: link CALL nodes with isNew metadata to the CLASS they instantiate.
 * Looks at resolved CALLS edges from new-expression CALL nodes to CLASS nodes.
 */
function deriveInstanceOf(
  results: FileResult[],
  allEdges: GraphEdge[],
  index: ProjectIndex,
): GraphEdge[] {
  // Collect all CALL node IDs with isNew metadata
  const newCallIds = new Set<string>();
  for (const result of results) {
    for (const node of result.nodes) {
      if (node.type === 'CALL' && node.metadata?.isNew) {
        newCallIds.add(node.id);
      }
    }
  }

  const derived: GraphEdge[] = [];
  const seen = new Set<string>(); // dedup: one INSTANCE_OF per call

  for (const edge of allEdges) {
    if (edge.type === 'CALLS' && newCallIds.has(edge.src) && !seen.has(edge.src)) {
      const dst = index.getNode(edge.dst);
      if (dst && dst.type === 'CLASS') {
        derived.push({ src: edge.src, dst: edge.dst, type: 'INSTANCE_OF' });
        seen.add(edge.src);
      }
    }
  }

  return derived;
}

// ─── Derived: Computed Access ELEMENT_OF ─────────────────────────────

/**
 * For `arr[i]`, if `arr` is known to be array-like (assigned from array literal,
 * iterated via for-of, target of .push()), create PROPERTY_ACCESS → ELEMENT_OF → VARIABLE.
 */
function deriveComputedAccessElementOf(
  results: FileResult[],
  allEdges: GraphEdge[],
): GraphEdge[] {
  // Build set of array-like variable IDs:
  // 1. ASSIGNED_FROM array literal (metadata.valueType === 'array')
  // 2. ITERATES_OVER target (iterable)
  // 3. FLOWS_INTO target (push/unshift target)
  const arrayLikeIds = new Set<string>();

  // Signal 1: variable assigned from array literal
  for (const result of results) {
    for (const node of result.nodes) {
      if (node.type === 'LITERAL' && node.metadata?.valueType === 'array') {
        // Find ASSIGNED_FROM edges where dst is this LITERAL
        for (const edge of result.edges) {
          if (edge.type === 'ASSIGNED_FROM' && edge.dst === node.id) {
            arrayLikeIds.add(edge.src);
          }
        }
      }
    }
  }

  // Signal 2: ITERATES_OVER target
  for (const edge of allEdges) {
    if (edge.type === 'ITERATES_OVER') {
      arrayLikeIds.add(edge.dst);
    }
  }

  // Signal 3: FLOWS_INTO target (push/unshift)
  for (const edge of allEdges) {
    if (edge.type === 'FLOWS_INTO') {
      arrayLikeIds.add(edge.dst);
    }
  }

  if (arrayLikeIds.size === 0) return [];

  // Build variable name → ID map per file
  const varByFileAndName = new Map<string, Map<string, string>>();
  for (const result of results) {
    const fileVars = new Map<string, string>();
    for (const node of result.nodes) {
      if ((node.type === 'VARIABLE' || node.type === 'CONSTANT' || node.type === 'PARAMETER') && arrayLikeIds.has(node.id)) {
        fileVars.set(node.name, node.id);
      }
    }
    if (fileVars.size > 0) varByFileAndName.set(result.file, fileVars);
  }

  // Find computed PROPERTY_ACCESS nodes and link to array variables
  const derived: GraphEdge[] = [];
  for (const result of results) {
    const fileVars = varByFileAndName.get(result.file);
    if (!fileVars) continue;

    for (const node of result.nodes) {
      if (node.type === 'PROPERTY_ACCESS' && node.metadata?.computed === true) {
        const objName = node.metadata.object as string | undefined;
        if (objName) {
          const varId = fileVars.get(objName);
          if (varId) {
            derived.push({
              src: node.id,
              dst: varId,
              type: 'ELEMENT_OF',
              metadata: { via: 'computed-access' },
            });
          }
        }
      }
    }
  }

  return derived;
}

// ─── Derived: Map.get() ELEMENT_OF ──────────────────────────────────

/**
 * For `map.get(key)`, if `map` is linked via INSTANCE_OF to Map/WeakMap,
 * create CALL → ELEMENT_OF → VARIABLE.
 */
function deriveMapGetElementOf(
  results: FileResult[],
  allEdges: GraphEdge[],
  index: ProjectIndex,
): GraphEdge[] {
  // Find variables that are instances of Map/WeakMap
  // CALL(new Map) → INSTANCE_OF → CLASS(Map) chain:
  // 1. Find INSTANCE_OF edges where dst is EXTERNAL#Map or EXTERNAL#WeakMap
  // 2. Find ASSIGNED_FROM edges from variable to the new Map() CALL
  const mapCallIds = new Set<string>();
  for (const edge of allEdges) {
    if (edge.type === 'INSTANCE_OF') {
      const dst = index.getNode(edge.dst);
      if (dst && (dst.name === 'Map' || dst.name === 'WeakMap')) {
        mapCallIds.add(edge.src);
      }
    }
  }

  if (mapCallIds.size === 0) return [];

  // Find variables assigned from new Map() calls
  const mapVarIds = new Set<string>();
  for (const edge of allEdges) {
    if (edge.type === 'ASSIGNED_FROM' && mapCallIds.has(edge.dst)) {
      mapVarIds.add(edge.src);
    }
  }

  // Build name→id map for map variables
  const mapVarByFile = new Map<string, Map<string, string>>();
  for (const result of results) {
    for (const node of result.nodes) {
      if (mapVarIds.has(node.id)) {
        let fileMap = mapVarByFile.get(node.file);
        if (!fileMap) {
          fileMap = new Map();
          mapVarByFile.set(node.file, fileMap);
        }
        fileMap.set(node.name, node.id);
      }
    }
  }

  // Find CALL nodes with method='get' and receiver matching a Map variable
  const derived: GraphEdge[] = [];
  for (const result of results) {
    const fileMap = mapVarByFile.get(result.file);
    if (!fileMap) continue;

    for (const node of result.nodes) {
      if (node.type === 'CALL' && node.metadata?.method === 'get') {
        const objName = node.metadata.object as string | undefined;
        if (objName) {
          const varId = fileMap.get(objName);
          if (varId) {
            derived.push({
              src: node.id,
              dst: varId,
              type: 'ELEMENT_OF',
              metadata: { via: 'method-return' },
            });
          }
        }
      }
    }
  }

  return derived;
}

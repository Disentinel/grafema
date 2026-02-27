/**
 * Stage 3: Project-level resolution.
 *
 * Takes FileResult[] from Stage 1+2, builds in-memory indices,
 * resolves cross-file deferred refs into edges.
 *
 * 4 resolver types:
 *   import_resolve  → IMPORTS_FROM
 *   call_resolve    → CALLS
 *   type_resolve    → HAS_TYPE, EXTENDS, IMPLEMENTS, overloads
 *   alias_resolve   → ALIASES, RESOLVES_TO, DERIVES_FROM, MERGES_WITH, OVERRIDES
 */
import type { FileResult, GraphEdge, GraphNode, DeferredRef } from './types.js';

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

  get nodeCount(): number {
    return this.byId.size;
  }
}

// ─── Module Resolution ───────────────────────────────────────────────

/**
 * Resolve a module specifier to a file path.
 * Simple: strip relative prefix, try common extensions.
 */
function resolveModulePath(source: string, fromFile: string, knownFiles: Set<string>): string | null {
  if (!source.startsWith('.')) {
    // External module — not resolvable within project
    return null;
  }

  // Resolve relative path
  const fromDir = fromFile.replace(/\/[^/]+$/, '');
  let resolved = normalizePath(`${fromDir}/${source}`);

  // Try exact match
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

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
}

// ─── Resolvers ───────────────────────────────────────────────────────

export interface ResolveResult {
  edges: GraphEdge[];
  unresolved: DeferredRef[];
  stats: {
    importResolved: number;
    callResolved: number;
    typeResolved: number;
    aliasResolved: number;
    unresolved: number;
  };
}

export function resolveProject(results: FileResult[]): ResolveResult {
  const index = new ProjectIndex(results);
  const knownFiles = new Set(results.map(r => r.file));

  const edges: GraphEdge[] = [];
  const unresolved: DeferredRef[] = [];
  const stats = {
    importResolved: 0,
    callResolved: 0,
    typeResolved: 0,
    aliasResolved: 0,
    unresolved: 0,
  };

  // Collect all project-stage deferred refs
  for (const result of results) {
    for (const ref of result.unresolvedRefs) {
      switch (ref.kind) {
        case 'import_resolve': {
          const resolved = resolveImport(ref, index, knownFiles);
          if (resolved) {
            edges.push(resolved);
            stats.importResolved++;
          } else {
            unresolved.push(ref);
            stats.unresolved++;
          }
          break;
        }

        case 'call_resolve': {
          const resolved = resolveCall(ref, index);
          if (resolved) {
            edges.push(resolved);
            stats.callResolved++;
          } else {
            unresolved.push(ref);
            stats.unresolved++;
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

  return { edges, unresolved, stats };
}

// ─── Import Resolver ─────────────────────────────────────────────────

function resolveImport(
  ref: DeferredRef,
  index: ProjectIndex,
  knownFiles: Set<string>,
): GraphEdge | null {
  if (!ref.source) return null;

  const targetFile = resolveModulePath(ref.source, ref.file, knownFiles);
  if (!targetFile) return null;  // External module

  if (ref.name === '*') {
    // import * — link to module
    const moduleNode = index.getModule(targetFile);
    if (moduleNode) {
      return { src: ref.fromNodeId, dst: moduleNode.id, type: ref.edgeType };
    }
    return null;
  }

  if (ref.name === 'default') {
    // import default — find default export
    const exported = index.findExport(targetFile, 'default');
    if (exported) {
      return { src: ref.fromNodeId, dst: exported.id, type: ref.edgeType };
    }
    return null;
  }

  // Named import
  const exported = index.findExport(targetFile, ref.name);
  if (exported) {
    return { src: ref.fromNodeId, dst: exported.id, type: ref.edgeType };
  }

  return null;
}

// ─── Call Resolver ───────────────────────────────────────────────────

function resolveCall(ref: DeferredRef, index: ProjectIndex): GraphEdge | null {
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

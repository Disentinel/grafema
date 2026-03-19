/**
 * ManifestGenerator — generates manifest.yaml from a Grafema graph.
 *
 * Reads MODULE, EXPORT, EXTERNAL_MODULE, FUNCTION, CLASS nodes from the graph
 * and assembles a Manifest object describing the package's export surface.
 *
 * Effects are looked up from the effects-db (builtins + packages) and
 * propagated transitively via the call graph.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { GraphBackend, NodeRecord } from '@grafema/types';
import { GRAFEMA_VERSION } from '../version.js';
import type {
  Manifest,
  ManifestExport,
  ManifestImport,
  EffectType,
  ExportKind,
  FlowType,
} from './types.js';

const SCHEMA_VERSION = 1;
const VALID_EFFECTS: Set<string> = new Set([
  'PURE', 'MUTATION', 'IO', 'THROW', 'ASYNC', 'NONDETERMINISTIC', 'UNKNOWN',
]);

interface EffectsDB {
  runtimes: Record<string, Record<string, EffectType[]>>;
  packages: Record<string, Record<string, EffectType[]>>;
}

interface GeneratorOptions {
  /** Package purl (e.g., "pkg:npm/@grafema/util@0.2.0") */
  purl: string;
  /** Path to effects-db directory */
  effectsDbPath?: string;
  /** Path to the .grafema directory */
  grafemaDir: string;
  /** Source type of analyzed code */
  sourceType?: 'source' | 'compiled_js' | 'minified' | 'dts_only';
  /** Files that belong to this package (prefix filter) */
  packagePrefix?: string;
  /** Graph-relative path to the entry file (e.g., "packages/util/src/index.ts").
   *  When set, collects exports via EXPORT → EXPORT_BINDING graph traversal,
   *  ensuring only the public API surface is included. */
  entryFile?: string;
}

export class ManifestGenerator {
  private backend: GraphBackend;
  private options: GeneratorOptions;
  private effectsDb: EffectsDB;
  private effectsCache: Map<string, EffectType[]> = new Map();

  constructor(backend: GraphBackend, options: GeneratorOptions) {
    this.backend = backend;
    this.options = options;
    this.effectsDb = { runtimes: {}, packages: {} };
  }

  async generate(): Promise<Manifest> {
    this.loadEffectsDB();

    const exports = await this.collectExports();
    await this.enrichEffects(exports);
    const imports = await this.collectImports();
    const totalInternal = await this.countInternalSymbols();

    const manifest: Manifest = {
      schema_version: SCHEMA_VERSION,
      analyzer_version: GRAFEMA_VERSION,
      authored: false,
      confidence: this.computeConfidence(exports),
      generated: new Date().toISOString(),

      package: {
        purl: this.options.purl,
        source_type: this.options.sourceType ?? 'source',
      },

      exports,
      imports,

      capabilities: {
        total_exports: exports.length,
        total_internal_symbols: totalInternal,
        has_graph: existsSync(join(this.options.grafemaDir, 'graph.rfdb')),
      },

      access: {
        local: './graph.rfdb',
      },

      language: 'typescript',
      language_specific: {
        module_system: 'esm',
      },
    };

    return manifest;
  }

  /** Serialize manifest to YAML string */
  static toYaml(manifest: Manifest): string {
    return stringifyYaml(manifest, {
      lineWidth: 120,
      defaultKeyType: 'PLAIN',
      defaultStringType: 'PLAIN',
    });
  }

  // ── Effects DB loading ─────────────────────────────────────

  private loadEffectsDB(): void {
    const dbPath = this.options.effectsDbPath;
    if (!dbPath) return;

    // Load runtime builtins
    const nodeYaml = join(dbPath, 'runtimes', 'node.yaml');
    if (existsSync(nodeYaml)) {
      const raw = parseYaml(readFileSync(nodeYaml, 'utf-8')) as Record<string, Record<string, EffectType[]>>;
      this.effectsDb.runtimes = raw;
    }

    // Load package effects
    const pkgDir = join(dbPath, 'packages');
    if (existsSync(pkgDir)) {
      for (const file of readdirSync(pkgDir)) {
        if (!file.endsWith('.yaml')) continue;
        const raw = parseYaml(readFileSync(join(pkgDir, file), 'utf-8'));
        if (raw && typeof raw === 'object') {
          for (const [pkg, fns] of Object.entries(raw)) {
            this.effectsDb.packages[pkg] = fns as Record<string, EffectType[]>;
          }
        }
      }
    }
  }

  /** Look up effects for a builtin or external function */
  private lookupEffects(module: string, fn: string): EffectType[] | null {
    // Check runtime builtins (node:fs → readFileSync)
    const nodeModule = `node:${module}`;
    if (this.effectsDb.runtimes[nodeModule]?.[fn]) {
      return this.effectsDb.runtimes[nodeModule][fn];
    }
    // Also check without node: prefix
    if (this.effectsDb.runtimes[module]?.[fn]) {
      return this.effectsDb.runtimes[module][fn];
    }

    // Check package effects
    if (this.effectsDb.packages[module]?.[fn]) {
      return this.effectsDb.packages[module][fn];
    }

    return null;
  }

  // ── Export collection ──────────────────────────────────────

  /** Definition node types we look up for exported symbols */
  private static readonly DEF_TYPES = ['FUNCTION', 'CLASS', 'CONSTANT', 'INTERFACE'] as const;

  private async collectExports(): Promise<ManifestExport[]> {
    const seen = new Set<string>();
    const exports: ManifestExport[] = [];
    const entryFile = this.options.entryFile;

    if (entryFile) {
      // Graph-based approach:
      // EXPORT(named) --EXPORTS--> EXPORT_BINDING(name, source) --> definition in source file
      await this.collectExportsViaBindings(entryFile, exports, seen, new Set());
    }

    // Fallback: if entry-file mode found 0 exports (e.g., CJS barrel,
    // broken re-export chain in compiled_js), scan all exported definitions
    if (exports.length === 0) {
      const prefix = this.options.packagePrefix ?? '';
      // Check standard definition types (FUNCTION, CLASS, CONSTANT, INTERFACE)
      for (const type of ManifestGenerator.DEF_TYPES) {
        for await (const node of this.backend.queryNodes({ type: type as never })) {
          if (prefix && !node.file?.startsWith(prefix)) continue;
          if (!node.exported) continue;
          if (!node.name || node.name.startsWith('<')) continue;
          if (seen.has(node.name)) continue;
          seen.add(node.name);
          await this.addExportFromDefinition(node, exports);
        }
      }
      // Also check EXPORT_BINDING nodes (from CJS exports.foo = ...)
      if (exports.length === 0) {
        for await (const node of this.backend.queryNodes({ type: 'EXPORT_BINDING' as never })) {
          if (prefix && !node.file?.startsWith(prefix)) continue;
          if (!node.name || node.name === 'named' || node.name === 'default') continue;
          if (seen.has(node.name)) continue;
          seen.add(node.name);
          exports.push({
            name: node.name,
            kind: 'VARIABLE',
            semanticId: node.id,
            effects: ['UNKNOWN'],
          });
        }
      }
    }

    exports.sort((a, b) => a.name.localeCompare(b.name));
    return exports;
  }

  /** Collect exports by traversing EXPORT → EXPORT_BINDING graph edges from entry file */
  private async collectExportsViaBindings(
    file: string,
    exports: ManifestExport[],
    seen: Set<string>,
    visitedFiles: Set<string>,
  ): Promise<void> {
    if (visitedFiles.has(file)) return;
    visitedFiles.add(file);

    for await (const exportNode of this.backend.queryNodes({ type: 'EXPORT' as never, file })) {
      // Star re-exports: follow RE_EXPORTS edge to source module
      if (exportNode.name?.startsWith('*:') || exportNode.name === '*') {
        const reExportEdges = await this.backend.getOutgoingEdges(exportNode.id, ['RE_EXPORTS' as never]);
        for (const edge of reExportEdges) {
          const targetModule = await this.backend.getNode(edge.dst);
          if (targetModule?.file) {
            await this.collectExportsViaBindings(targetModule.file, exports, seen, visitedFiles);
          }
        }
        continue;
      }

      // Named exports: follow EXPORTS edges to EXPORT_BINDING nodes
      const bindingEdges = await this.backend.getOutgoingEdges(exportNode.id, ['EXPORTS' as never]);
      for (const edge of bindingEdges) {
        const binding = await this.backend.getNode(edge.dst);
        if (!binding?.name || seen.has(binding.name)) continue;
        seen.add(binding.name);

        // Resolve the definition node from the source file
        const source = (binding as Record<string, unknown>).source as string | undefined;
        const defNode = source
          ? await this.findDefinition(binding.name, source, file)
          : await this.findDefinitionInFile(binding.name, file);

        if (defNode) {
          await this.addExportFromDefinition(defNode, exports);
        } else {
          // Type-only export or unresolvable — add as TYPE/VARIABLE
          exports.push({
            name: binding.name,
            kind: 'TYPE',
            semanticId: binding.id,
            effects: ['PURE'],
          });
        }
      }
    }
  }

  /** Find a definition node by name, resolving source path relative to the importing file.
   *  Follows barrel re-export chains: if the source file is a barrel (index.ts),
   *  looks for EXPORT_BINDING nodes there and follows their source recursively. */
  private async findDefinition(
    name: string, source: string, fromFile: string, depth = 0,
  ): Promise<NodeRecord | null> {
    if (depth > 5) return null;

    const resolved = this.resolveSourcePath(source, fromFile);

    // Direct definition in resolved file
    const def = await this.findDefinitionInFile(name, resolved);
    if (def) return def;

    // Follow barrel re-export chain via EXPORT_BINDING
    for await (const binding of this.backend.queryNodes({
      type: 'EXPORT_BINDING' as never, name, file: resolved,
    })) {
      const nextSource = (binding as Record<string, unknown>).source as string | undefined;
      if (nextSource) {
        return this.findDefinition(name, nextSource, resolved, depth + 1);
      }
    }

    return null;
  }

  /** Resolve a relative source path to a graph-relative file path */
  private resolveSourcePath(source: string, fromFile: string): string {
    const dir = fromFile.substring(0, fromFile.lastIndexOf('/'));
    let resolved = source.startsWith('.') ? `${dir}/${source}` : source;
    resolved = resolved.replace(/\/\.\//g, '/');
    // Only replace .js → .ts for source TypeScript code, not compiled_js
    if (this.options.sourceType !== 'compiled_js' && resolved.endsWith('.js')) {
      resolved = resolved.replace(/\.js$/, '.ts');
    }
    return resolved;
  }

  /** Find a FUNCTION/CLASS/CONSTANT/INTERFACE node by name in a specific file */
  private async findDefinitionInFile(name: string, file: string): Promise<NodeRecord | null> {
    for (const type of ManifestGenerator.DEF_TYPES) {
      for await (const node of this.backend.queryNodes({ type: type as never, name, file })) {
        return node;
      }
    }
    return null;
  }

  /** Build a ManifestExport entry from a definition node */
  private async addExportFromDefinition(node: NodeRecord, exports: ManifestExport[]): Promise<void> {
    const kind = this.nodeTypeToExportKind(node.type);
    const entry: ManifestExport = {
      name: node.name ?? '<unknown>',
      kind,
      semanticId: node.id,
      effects: ['PURE'],
    };

    if (kind === 'FUNCTION' || kind === 'CLASS') {
      const params = (node as Record<string, unknown>).params as string[] | undefined;
      if (params && params.length > 0) {
        entry.params = params.map(p => ({ name: p, flow: 'IN' as FlowType }));
      }
      entry.returns = { flow: 'OUT' };
    }

    exports.push(entry);
  }

  /** Map node type → ExportKind */
  private nodeTypeToExportKind(type: string): ExportKind {
    switch (type) {
      case 'FUNCTION': return 'FUNCTION';
      case 'CLASS': return 'CLASS';
      case 'CONSTANT': return 'CONSTANT';
      case 'INTERFACE': return 'INTERFACE';
      default: return 'VARIABLE';
    }
  }


  // ── Effect computation ─────────────────────────────────────

  /** Enrich all exports with computed effects (transitive call graph analysis) */
  private async enrichEffects(exports: ManifestExport[]): Promise<void> {
    for (const entry of exports) {
      // Enrich FUNCTION, CLASS, and VARIABLE (CJS exports may be VARIABLE kind)
      if (entry.kind !== 'FUNCTION' && entry.kind !== 'CLASS' && entry.kind !== 'VARIABLE') continue;

      const effects = new Set<EffectType>();
      const visited = new Set<string>();
      await this.collectEffectsTransitively(entry.semanticId, effects, visited);

      const computed = [...effects].filter(e => e !== 'PURE');
      if (computed.length > 0) {
        entry.effects = computed;
      }
    }
  }

  private async collectEffectsTransitively(
    nodeId: string,
    effects: Set<EffectType>,
    visited: Set<string>,
    depth = 0
  ): Promise<void> {
    if (visited.has(nodeId) || depth > 20) return;
    visited.add(nodeId);

    // Get outgoing CALLS edges
    const callEdges = await this.backend.getOutgoingEdges(nodeId, ['CALLS' as never]);

    for (const edge of callEdges) {
      const targetNode = await this.backend.getNode(edge.dst);
      if (!targetNode) continue;

      // Check if target is an external call → look up in effects-db
      if (targetNode.type === 'EXTERNAL_MODULE' || targetNode.type === 'GLOBAL_DEFINITION') {
        const [module, fn] = this.parseCallTarget(targetNode);
        if (module && fn) {
          const knownEffects = this.lookupEffects(module, fn);
          if (knownEffects) {
            for (const e of knownEffects) {
              if (VALID_EFFECTS.has(e) && e !== 'PURE') effects.add(e);
            }
          } else {
            effects.add('UNKNOWN');
          }
        }
        continue;
      }

      // Recurse into internal calls
      await this.collectEffectsTransitively(edge.dst, effects, visited, depth + 1);
    }

    // Check node's own properties for async/throw
    const node = await this.backend.getNode(nodeId);
    if (node) {
      const meta = node as Record<string, unknown>;
      if (meta.async === true) effects.add('ASYNC');
      const cf = meta.controlFlow as Record<string, boolean> | undefined;
      if (cf?.hasThrow) effects.add('THROW');
      if (cf?.canReject) effects.add('THROW');
    }
  }

  private parseCallTarget(node: NodeRecord): [string | null, string | null] {
    // Parse semantic ID like "EXTERNAL_MODULE:fs" or call name like "fs.readFileSync"
    const name = node.name ?? '';
    if (name.includes('.')) {
      const parts = name.split('.');
      return [parts[0], parts.slice(1).join('.')];
    }
    return [name, null];
  }

  // ── Import collection ──────────────────────────────────────

  private async collectImports(): Promise<ManifestImport[]> {
    const importMap = new Map<string, Set<string>>();
    const prefix = this.options.packagePrefix ?? '';

    for await (const node of this.backend.queryNodes({ type: 'IMPORT' as never })) {
      if (prefix && !node.file?.startsWith(prefix)) continue;

      const source = (node as Record<string, unknown>).source as string;
      if (!source) continue;

      // Skip relative imports (internal modules)
      if (source.startsWith('.') || source.startsWith('/')) continue;

      const purl = this.sourceToPurl(source);
      if (!importMap.has(purl)) {
        importMap.set(purl, new Set());
      }

      const importName = node.name ?? '*';
      importMap.get(purl)!.add(importName);
    }

    return [...importMap.entries()]
      .map(([purl, symbols]) => ({
        purl,
        symbols: [...symbols].sort(),
      }))
      .sort((a, b) => a.purl.localeCompare(b.purl));
  }

  private sourceToPurl(source: string): string {
    // Node builtins: node:fs, node:path, etc.
    if (source.startsWith('node:')) {
      const mod = source.replace('node:', '');
      return `pkg:npm/node@*#${mod}`;
    }

    // Scoped packages: @scope/name or @scope/name/path → pkg:npm/@scope/name
    if (source.startsWith('@')) {
      const parts = source.split('/');
      const pkg = `${parts[0]}/${parts[1]}`;
      return `pkg:npm/${pkg}`;
    }

    // Regular packages: name or name/path → pkg:npm/name
    const pkg = source.split('/')[0];
    return `pkg:npm/${pkg}`;
  }

  // ── Helpers ────────────────────────────────────────────────

  private async countInternalSymbols(): Promise<number> {
    const prefix = this.options.packagePrefix ?? '';
    let count = 0;
    for (const type of ['FUNCTION', 'CLASS', 'VARIABLE', 'CONSTANT', 'INTERFACE']) {
      for await (const node of this.backend.queryNodes({ type: type as never })) {
        if (prefix && !node.file?.startsWith(prefix)) continue;
        count++;
      }
    }
    return count;
  }

  private computeConfidence(exports: ManifestExport[]): number {
    if (exports.length === 0) return 0;

    const unknownCount = exports.filter(e =>
      e.effects.includes('UNKNOWN')
    ).length;

    // confidence = 1.0 - (unknown_ratio * 0.5)
    const unknownRatio = unknownCount / exports.length;
    return Math.round((1.0 - unknownRatio * 0.5) * 100) / 100;
  }
}

/**
 * ManifestGenerator — generates manifest.yaml from a Grafema graph.
 *
 * Reads MODULE, EXPORT, EXTERNAL_MODULE, FUNCTION, CLASS nodes from the graph
 * and assembles a Manifest object describing the package's export surface.
 *
 * Effects are looked up from the effects-db (builtins + packages) and
 * propagated transitively via the call graph.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { stringify as stringifyYaml } from 'yaml';
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
import { isValidEffect } from './types.js';
import { EffectsLookup, parseCallTarget } from './effects-lookup.js';

const SCHEMA_VERSION = 2;

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
  private effectsLookup: EffectsLookup;

  constructor(backend: GraphBackend, options: GeneratorOptions) {
    this.backend = backend;
    this.options = options;
    this.effectsLookup = EffectsLookup.empty();
  }

  async generate(): Promise<Manifest> {
    this.effectsLookup = this.options.effectsDbPath
      ? EffectsLookup.load(this.options.effectsDbPath)
      : EffectsLookup.empty();

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

    // Filter minified single-character exports (signal of internal bundler code)
    const filtered = exports.filter(e => e.name.length > 1);
    return filtered;
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
    const candidates = this.candidateFiles(resolved);

    // Direct definition in any candidate file (verbatim + extension/index forms).
    for (const file of candidates) {
      const def = await this.findDefinitionInFile(name, file);
      if (def) return def;
    }

    // Follow barrel re-export chain: an EXPORT_BINDING for `name` in a candidate
    // file re-exports from a deeper source. fuzzyNameFallback:false keeps the
    // lookup file-scoped (see findDefinitionInFile).
    for (const file of candidates) {
      for await (const binding of this.backend.queryNodes({
        type: 'EXPORT_BINDING' as never, name, file, fuzzyNameFallback: false,
      })) {
        const nextSource = (binding as Record<string, unknown>).source as string | undefined;
        if (nextSource) {
          return this.findDefinition(name, nextSource, file, depth + 1);
        }
      }
    }

    return null;
  }

  /**
   * Expand a resolved (possibly extensionless) source specifier into the
   * concrete graph file paths the analyzer would have indexed.
   *
   * The JS analyzer stores `EXPORT_BINDING.source` verbatim from the
   * `from '...'` clause (packages/js-analyzer/src/Rules/Declarations.hs:644,742),
   * which for source TypeScript is typically extensionless (`./impl`) or a
   * directory (`./utils`). RFDB's `file` filter is an exact match, so an
   * extensionless `resolved` never matches the real `.ts` or `/index.ts` file
   * unless we try those forms explicitly. Source TypeScript variants are tried
   * first; `.js` variants cover `compiled_js` inputs.
   */
  private candidateFiles(resolved: string): string[] {
    const exts =
      this.options.sourceType === 'compiled_js'
        ? ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '/index.js', '/index.mjs', '/index.ts', '/index.tsx']
        : ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const ext of exts) {
      const file = ext === '' || resolved.endsWith(ext) ? resolved : resolved + ext;
      if (!seen.has(file)) {
        seen.add(file);
        out.push(file);
      }
    }
    return out;
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
      // fuzzyNameFallback:false — without it, RFDB's name-similarity fallback
      // fires whenever the exact (name+file) query returns 0 rows and resolves
      // a re-export to a same-named symbol in an UNRELATED file, ignoring the
      // `file` constraint entirely. The manifest export surface must be
      // file-scoped, so we require an exact file match (mirrors the sibling
      // packageApiEnricher.findDefinitionTarget).
      for await (const node of this.backend.queryNodes({
        type: type as never, name, file, fuzzyNameFallback: false,
      })) {
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
        const parsed = parseCallTarget(targetNode.name ?? '');
        if (parsed) {
          const [module, fn] = parsed;
          const knownEffects = this.effectsLookup.lookup(module, fn);
          if (knownEffects) {
            for (const e of knownEffects) {
              if (isValidEffect(e) && e !== 'PURE') effects.add(e);
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

/**
 * packageApiEnricher — L0 cross-package public API surface detection.
 *
 * For every monorepo package's barrel `src/index.ts` (or `index.ts`), each
 * EXPORT_BINDING in that file becomes a `package:export` FEATURE-class node:
 *
 *   - node id    = `<barrel.file>::package:export::<exportedName>`
 *   - node type  = `package:export`
 *   - HANDLES    → the underlying FUNCTION/CLASS/CONSTANT (when resolvable)
 *
 * This complements the L0 enrichers `enrichLibraryCallbacks` and
 * `enrichMcpToolDefinitions` (which detect callback/tool entry points) by
 * surfacing the "exported function consumed by another package in the same
 * monorepo" pattern. The contract enricher then attaches inputs/outputs/errors
 * to each `package:export` just like any other FEATURE.
 *
 * Re-exports (EXPORT_BINDING with metadata.source) still produce a
 * `package:export` node — the fact that a barrel re-exports a symbol IS part
 * of that package's API surface, separate from whichever package actually
 * defines it. The HANDLES edge points at the resolved target if we can find
 * it in the same graph; otherwise `exportsWithoutHandler` is incremented.
 *
 * Like sibling enrichers, this writes nodes/edges via direct addNodes/addEdges
 * (chunked) rather than BatchHandle.commit, since BatchHandle.commit deletes
 * pre-existing nodes whose `file` field appears in changedFiles. See the skill
 * `rfdb-batchhandle-deletes-existing-nodes` for the full story.
 */

import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireEdge, WireNode } from '@grafema/types';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PackageApiEnrichResult {
  /** Number of `package:export` nodes created (or re-upserted). */
  apiNodesCreated: number;
  /** Number of HANDLES edges emitted (one per export with a resolvable target). */
  handlesEdgesCreated: number;
  /** Distinct barrel files scanned. */
  packagesScanned: number;
  /** Diagnostic — exports we created a node for but couldn't resolve a HANDLES
   *  target (re-exports whose source file isn't in this graph, type-only
   *  exports, broken chains, etc.). */
  exportsWithoutHandler: number;
}

export interface PackageApiEnrichOptions {
  /** Glob-like file patterns recognised as package public-API barrels.
   *  Defaults to the canonical Grafema layouts.
   *
   *  Currently we don't run a full glob: each entry must be a literal suffix
   *  to match the right-hand side of MODULE.file. The defaults cover both the
   *  TypeScript (`packages/<pkg>/src/index.ts`) and pre-built JS
   *  (`packages/<pkg>/index.ts`) layouts. Override only if your monorepo has
   *  unusual barrel locations. */
  barrelSuffixes?: string[];
  /** Maximum nodes/edges to flush per addNodes/addEdges round-trip. */
  flushBatchSize?: number;
}

const DEFAULT_BARREL_SUFFIXES: readonly string[] = [
  '/src/index.ts',
  '/src/index.js',
  '/index.ts',
  '/index.js',
];

const DEFAULT_FLUSH_BATCH_SIZE = 200;

/** Definition node types we resolve HANDLES targets to, in priority order. */
const DEFINITION_TYPES: readonly string[] = ['FUNCTION', 'CLASS', 'CONSTANT', 'INTERFACE', 'METHOD'];

/**
 * Scan the graph for monorepo barrels and emit `package:export` nodes for
 * every EXPORT_BINDING in those files.
 *
 * Idempotent: node IDs are deterministic (`barrel::package:export::name`), and
 * HANDLES edges have stable (src, dst, edgeType) tuples — RFDB dedupes both.
 */
export async function enrichPackageApis(
  client: RFDBClient,
  options?: PackageApiEnrichOptions,
): Promise<PackageApiEnrichResult> {
  const result: PackageApiEnrichResult = {
    apiNodesCreated: 0,
    handlesEdgesCreated: 0,
    packagesScanned: 0,
    exportsWithoutHandler: 0,
  };

  const suffixes = options?.barrelSuffixes ?? DEFAULT_BARREL_SUFFIXES;
  const flushSize = options?.flushBatchSize ?? DEFAULT_FLUSH_BATCH_SIZE;

  const barrelFiles = await findBarrelFiles(client, suffixes);
  if (barrelFiles.length === 0) return result;

  const newNodes: WireNode[] = [];
  const newEdges: WireEdge[] = [];
  const seenNodeIds = new Set<string>();

  for (const barrel of barrelFiles) {
    result.packagesScanned++;
    const packageName = resolvePackageName(barrel);

    // Materialize bindings before per-binding traversal: the queryNodes
    // generator and the per-binding getOutgoingEdges/queryNodes calls share
    // the same client connection.
    const bindings: WireNode[] = [];
    for await (const eb of client.queryNodes({ type: 'EXPORT_BINDING' as never, file: barrel })) {
      bindings.push(eb);
    }

    for (const binding of bindings) {
      const meta = parseMeta(binding);
      const exportedName = readExportedName(binding, meta);
      if (!exportedName) continue;
      // Skip the synthetic `<export>` placeholder the analyzer emits when it
      // can't extract a local identifier (e.g., `export { default } from ...`
      // with no rename). These aren't useful as FEATURE nodes.
      if (exportedName.startsWith('<')) continue;

      const reExportSource =
        typeof meta?.source === 'string' && meta.source.length > 0
          ? meta.source
          : undefined;

      const apiNodeId = makeApiNodeId(barrel, exportedName);
      if (seenNodeIds.has(apiNodeId)) continue;
      seenNodeIds.add(apiNodeId);

      // Resolve HANDLES target:
      //   - direct export (no source): definition (FUNCTION/CLASS/CONSTANT/...)
      //     in the same file with matching name.
      //   - re-export: try to find the definition in the resolved source file
      //     (single hop — no full re-export chain walk; that's manifestGenerator's
      //     job). If the source is outside the indexed graph, we still emit the
      //     node but increment exportsWithoutHandler.
      const targetId = reExportSource
        ? await resolveReExportTarget(client, exportedName, resolveRelative(barrel, reExportSource))
        : await findDefinitionTarget(client, exportedName, barrel);

      const nodeMeta: Record<string, unknown> = {
        package: packageName,
        barrel,
        exportedName,
      };
      if (reExportSource) nodeMeta.source = reExportSource;

      newNodes.push({
        id: apiNodeId,
        nodeType: 'package:export' as never,
        name: exportedName,
        file: barrel,
        exported: true,
        metadata: JSON.stringify(nodeMeta),
      });
      result.apiNodesCreated++;

      if (targetId) {
        newEdges.push({
          src: apiNodeId,
          dst: targetId,
          edgeType: 'HANDLES' as never,
          metadata: JSON.stringify({}),
        });
        result.handlesEdgesCreated++;
      } else {
        result.exportsWithoutHandler++;
      }

      if (newNodes.length >= flushSize) {
        await client.addNodes(newNodes.splice(0, newNodes.length));
      }
      if (newEdges.length >= flushSize) {
        await client.addEdges(newEdges.splice(0, newEdges.length));
      }
    }
  }

  if (newNodes.length > 0) await client.addNodes(newNodes);
  if (newEdges.length > 0) await client.addEdges(newEdges);

  return result;
}

/** ---------------------------------------------------------------------------
 *  Barrel discovery
 *  ------------------------------------------------------------------------ */

/**
 * Find every MODULE node whose file path ends with one of the configured
 * barrel suffixes AND lives under `packages/`. Returns a deduplicated, sorted
 * list of file paths so test runs are stable.
 */
async function findBarrelFiles(
  client: RFDBClient,
  suffixes: readonly string[],
): Promise<string[]> {
  const seen = new Set<string>();
  for (const suffix of suffixes) {
    // `file` defaults to exact match; we use substringMatch to find every
    // module whose file path *contains* the suffix, then filter to only those
    // that end with it AND start with `packages/` (or `packages` somewhere in
    // the path — see resolvePackageName for the same logic).
    for await (const mod of client.queryNodes({
      type: 'MODULE' as never,
      file: suffix,
      substringMatch: true,
    })) {
      const file = mod.file ?? '';
      if (!file.endsWith(suffix)) continue;
      if (!file.includes('packages/')) continue;
      seen.add(file);
    }
  }
  return Array.from(seen).sort();
}

/**
 * Map a barrel file path back to its npm package name.
 *
 * Strategy: walk up from the barrel until we find a `package.json` and read
 * its `name` field. This handles non-standard package names like `grafema`
 * (no `@scope/` prefix) and arbitrary directory names.
 *
 * If we can't find package.json (e.g., test fixtures, synthetic graphs), fall
 * back to `packages/<dir>` → `@grafema/<dir>`. Last resort is the raw barrel
 * file path so the node still has *some* identifying metadata.
 */
function resolvePackageName(barrelFile: string): string {
  const idx = barrelFile.lastIndexOf('packages/');
  if (idx < 0) return barrelFile;
  const afterPkgs = barrelFile.slice(idx + 'packages/'.length);
  const slash = afterPkgs.indexOf('/');
  const dirName = slash >= 0 ? afterPkgs.slice(0, slash) : afterPkgs;
  const pkgRoot = barrelFile.slice(0, idx) + 'packages/' + dirName;

  const pkgJsonPath = join(pkgRoot, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const raw = readFileSync(pkgJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.length > 0) return parsed.name;
    } catch {
      /* fall through */
    }
  }
  return `@grafema/${dirName}`;
}

/** ---------------------------------------------------------------------------
 *  Target resolution
 *  ------------------------------------------------------------------------ */

/**
 * Find a FUNCTION/CLASS/CONSTANT/... node by name in the given file. Returns
 * the wire ID of the first matching definition, or null if none exists.
 */
async function findDefinitionTarget(
  client: RFDBClient,
  name: string,
  file: string,
): Promise<string | null> {
  for (const t of DEFINITION_TYPES) {
    for await (const node of client.queryNodes({
      type: t as never,
      name,
      file,
      fuzzyNameFallback: false,
    })) {
      return String(node.id);
    }
  }
  return null;
}

/**
 * Normalize a relative re-export source (`./foo`, `./foo.js`, `./sub`, `../bar`)
 * into a logical base path relative to the barrel. Non-relative sources
 * (bare/scoped specifiers like `@scope/pkg`) are returned verbatim — they don't
 * map to an in-graph file and resolve to no HANDLES target.
 *
 * This deliberately does NOT pick a file extension: extension/index expansion
 * happens in {@link candidateFiles}, because a single specifier can map to a
 * `.ts`, `.tsx`, `.js`, … file, or a directory `index.*`, and the analyzer
 * indexes source TypeScript as `.ts` even when the specifier is `.js` or
 * extensionless.
 */
function resolveRelative(fromFile: string, source: string): string {
  if (!source.startsWith('.')) return source;
  const dir = dirname(fromFile);
  let resolved = `${dir}/${source}`;
  resolved = resolved.replace(/\/\.\//g, '/');
  // Collapse trailing /. and walk .. segments — keep it simple, no fancy
  // realpath: the graph stores logical paths.
  const parts = resolved.split('/');
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '..') stack.pop();
    else if (p !== '.' && p !== '') stack.push(p);
  }
  return (resolved.startsWith('/') ? '/' : '') + stack.join('/');
}

/** Source-file extensions a re-export specifier may resolve to, TS-first. */
const REEXPORT_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
/** Directory index file names, TS-first. */
const REEXPORT_INDEX_FILES: readonly string[] = REEXPORT_EXTENSIONS.map(e => `index${e}`);
const KNOWN_EXT_RE = /\.(?:ts|tsx|js|mjs|cjs|jsx)$/;

/**
 * Expand a normalized re-export base path into the candidate graph file paths
 * it may correspond to, ordered by likelihood (verbatim first when the
 * specifier already carries a known extension, otherwise TS source files before
 * the directory `index.*` forms).
 *
 * The analyzer stores `EXPORT_BINDING.source` as the verbatim `from '...'`
 * string. Source TypeScript commonly uses the extensionless (`./foo`) or
 * ESM `.js` (`./foo.js`) form, while the real graph node lives in `foo.ts`,
 * so a single fixed extension can never cover every layout.
 */
function candidateFiles(resolved: string): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    if (!out.includes(p)) out.push(p);
  };

  if (KNOWN_EXT_RE.test(resolved)) {
    // e.g. './foo.js' → try foo.js verbatim, then TS/JS siblings of foo.*
    push(resolved);
    const base = resolved.replace(KNOWN_EXT_RE, '');
    for (const ext of REEXPORT_EXTENSIONS) push(base + ext);
  } else {
    // e.g. './foo' or './sub' → file-with-extension first, then directory index
    for (const ext of REEXPORT_EXTENSIONS) push(resolved + ext);
    push(resolved);
    for (const idx of REEXPORT_INDEX_FILES) push(`${resolved}/${idx}`);
  }
  return out;
}

/**
 * Resolve a re-export's HANDLES target by trying each candidate file the
 * normalized source path may map to, returning the first definition found.
 * Returns null when no candidate file holds a matching definition — callers
 * treat that as an unresolved re-export (`exportsWithoutHandler`).
 */
async function resolveReExportTarget(
  client: RFDBClient,
  name: string,
  resolvedSource: string,
): Promise<string | null> {
  for (const file of candidateFiles(resolvedSource)) {
    const id = await findDefinitionTarget(client, name, file);
    if (id) return id;
  }
  return null;
}

/** ---------------------------------------------------------------------------
 *  Helpers
 *  ------------------------------------------------------------------------ */

function makeApiNodeId(barrelFile: string, exportedName: string): string {
  return `${barrelFile || '<unknown>'}::package:export::${exportedName}`;
}

function readExportedName(
  binding: WireNode,
  meta: Record<string, unknown> | null,
): string | null {
  // Prefer metadata.exportedName (handles `export { x as y }` rename), fall
  // back to the binding's `name`.
  if (meta && typeof meta.exportedName === 'string' && meta.exportedName.length > 0) {
    return meta.exportedName;
  }
  if (binding.name && binding.name.length > 0) return binding.name;
  return null;
}

function parseMeta(node: WireNode): Record<string, unknown> | null {
  if (!node.metadata) return null;
  try {
    return JSON.parse(node.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

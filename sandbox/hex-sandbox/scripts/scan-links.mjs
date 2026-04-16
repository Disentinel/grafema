#!/usr/bin/env node
// Scan the source tree for file-level import edges.
// Output: public/links-real.json with { edges: [{source, target, weight}] }
//
// Captures import/require for .ts/.tsx/.js/.jsx/.mjs files. Relative imports
// are resolved by walking the filesystem; bare package imports are skipped
// (they'd be node_modules external dependencies, not intra-project edges).
//
// This replaces the synthetic link generator in tree-sample.js so the
// layout algorithms can be tested against realistic grafema topology.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.cache', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '_tasks', '.grafema', '.vercel',
]);
const EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.rs', '.py', '.hs', '.ex', '.exs', '.rb', '.go',
]);
const JSTS_RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'];

function walkFiles(dir, out, base) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.grafema') continue;
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkFiles(full, out, base);
    } else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (EXTS.has(ext)) out.push(path.relative(base, full));
    }
  }
}

function tryResolveJsTs(absPath) {
  if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) return absPath;
  for (const suf of JSTS_RESOLVE_EXTS) {
    const candidate = absPath + suf;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const fileSet = [];
walkFiles(ROOT, fileSet, ROOT);
console.error(`scanned ${fileSet.length} source files under ${ROOT}`);

// ── npm package index ──────────────────────────────────────────
// Scan every package.json to build `name → dirRelativeToRoot` so bare
// scoped imports like `@grafema/util` resolve to `packages/util`.
/** @type {Map<string, string>} */
const npmPackageDirs = new Map();
function scanPackageJsons(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      scanPackageJsons(full, out);
    } else if (e.isFile() && e.name === 'package.json') {
      try {
        const pkg = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (pkg.name) {
          const dirRel = normFileRaw(path.relative(ROOT, path.dirname(full)));
          out.set(pkg.name, { dir: dirRel, main: pkg.main, module: pkg.module, exports: pkg.exports });
        }
      } catch {
        // ignore malformed package.json
      }
    }
  }
}
function normFileRaw(p) { return p.split(path.sep).join('/'); }
/** @type {Map<string, {dir:string, main?:string, module?:string, exports?:any}>} */
const npmPackages = new Map();
scanPackageJsons(ROOT, npmPackages);
console.error(`indexed ${npmPackages.size} npm packages`);

/** Resolve a bare specifier like `@grafema/util/core/FileOverview` to an
 *  absolute file path within this repo, if the package is local. */
function resolveBareSpec(spec) {
  // Pick the longest matching prefix from npmPackages (handles scoped
  // names with slashes: `@grafema/util`). Try exact, then pkg + subpath.
  let pkgName = null, rest = '';
  if (spec.startsWith('@')) {
    // @scope/name OR @scope/name/sub/path
    const parts = spec.split('/');
    if (parts.length < 2) return null;
    const base = parts[0] + '/' + parts[1];
    if (npmPackages.has(base)) {
      pkgName = base;
      rest = parts.slice(2).join('/');
    }
  } else {
    // name OR name/sub/path
    const firstSlash = spec.indexOf('/');
    const base = firstSlash < 0 ? spec : spec.slice(0, firstSlash);
    if (npmPackages.has(base)) {
      pkgName = base;
      rest = firstSlash < 0 ? '' : spec.slice(firstSlash + 1);
    }
  }
  if (!pkgName) return null;
  const pkg = npmPackages.get(pkgName);
  if (!pkg) return null;
  const pkgAbsDir = path.join(ROOT, pkg.dir);
  if (rest) {
    // pkg/sub/path — try resolving under src/, dist/, or the root
    const bases = [
      path.join(pkgAbsDir, 'src', rest),
      path.join(pkgAbsDir, rest),
      path.join(pkgAbsDir, 'dist', rest),
    ];
    for (const b of bases) {
      const r = tryResolveJsTs(b);
      if (r) return r;
    }
    return null;
  }
  // Bare entry — prefer src/ (source code lives there) over main/module
  // which typically point into dist/ and will get rejected by the file
  // set filter later (dist/ is in IGNORE_DIRS).
  const entries = [
    path.join(pkgAbsDir, 'src/index'),
    path.join(pkgAbsDir, 'src/main'),
    path.join(pkgAbsDir, 'index'),
  ];
  if (pkg.module) entries.push(path.join(pkgAbsDir, pkg.module.replace(/^dist\//, 'src/')));
  if (pkg.main) entries.push(path.join(pkgAbsDir, pkg.main.replace(/^dist\//, 'src/')));
  for (const e of entries) {
    const r = tryResolveJsTs(e);
    if (r) return r;
  }
  return null;
}

// Per-language import regexes. Each captures a raw target specifier; the
// language-specific resolver then maps it back to a file path.
const JS_IMPORT_RE = /(?:from\s+|import\(|require\()\s*['"]([^'"]+)['"]/g;
const RS_USE_RE = /\buse\s+([a-zA-Z0-9_:]+)/g;     // Rust use path::segment::Item
const RS_MOD_RE = /\bmod\s+([a-zA-Z0-9_]+)\s*;/g;  // Rust mod name;
const PY_FROM_RE = /^\s*from\s+([a-zA-Z0-9_.]+)\s+import/gm;
const PY_IMPORT_RE = /^\s*import\s+([a-zA-Z0-9_.]+)/gm;
const HS_IMPORT_RE = /^\s*import\s+(?:qualified\s+)?([A-Za-z0-9_.]+)/gm;

/** @type {Map<string, Map<string, number>>} */
const edges = new Map();
const normFile = (p) => p.split(path.sep).join('/');
const tgtFileSet = new Set(fileSet.map(normFile));
// Build module-name indexes for languages that use module paths, not file paths.
// For each language we build: moduleName → list of files whose path matches.
/** @type {Map<string, string[]>} */
const pyModuleToFiles = new Map();
for (const rel of fileSet) {
  if (!rel.endsWith('.py')) continue;
  const key = normFile(rel).replace(/\.py$/, '').replace(/\//g, '.').replace(/\.__init__$/, '');
  if (!pyModuleToFiles.has(key)) pyModuleToFiles.set(key, []);
  pyModuleToFiles.get(key).push(normFile(rel));
}
/** @type {Map<string, string[]>} */
const hsModuleToFiles = new Map();
for (const rel of fileSet) {
  if (!rel.endsWith('.hs')) continue;
  const key = normFile(rel).replace(/\.hs$/, '')
    .replace(/^.*?\/src\//, '')
    .replace(/\//g, '.');
  if (!hsModuleToFiles.has(key)) hsModuleToFiles.set(key, []);
  hsModuleToFiles.get(key).push(normFile(rel));
}
/** @type {Map<string, string[]>} */
const rsPathToFiles = new Map();
for (const rel of fileSet) {
  if (!rel.endsWith('.rs')) continue;
  const n = normFile(rel);
  // rust crate path heuristic: strip crate-root prefix, last segment is module name
  const noExt = n.replace(/\.rs$/, '');
  const segs = noExt.split('/');
  // index by last segment (filename without ext) for fuzzy match
  const last = segs[segs.length - 1];
  if (!rsPathToFiles.has(last)) rsPathToFiles.set(last, []);
  rsPathToFiles.get(last).push(n);
}

const addEdge = (sourceKey, targetKey) => {
  if (!targetKey || targetKey === sourceKey) return false;
  if (!tgtFileSet.has(targetKey)) return false;
  let bucket = edges.get(sourceKey);
  if (!bucket) { bucket = new Map(); edges.set(sourceKey, bucket); }
  bucket.set(targetKey, (bucket.get(targetKey) ?? 0) + 1);
  return true;
};

let importCount = 0;
let resolvedCount = 0;
let bareAttempted = 0;
let bareResolved = 0;
for (const rel of fileSet) {
  const abs = path.join(ROOT, rel);
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const ext = path.extname(rel);
  const srcDir = path.dirname(abs);
  const sourceKey = normFile(rel);

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    for (const m of src.matchAll(JS_IMPORT_RE)) {
      importCount++;
      const spec = m[1];
      let resolved = null;
      if (spec.startsWith('.')) {
        // Relative import
        resolved = tryResolveJsTs(path.resolve(srcDir, spec));
      } else {
        // Bare package spec — resolve to local workspace package if possible
        bareAttempted++;
        resolved = resolveBareSpec(spec);
        if (resolved) bareResolved++;
      }
      if (!resolved) continue;
      const targetKey = normFile(path.relative(ROOT, resolved));
      if (addEdge(sourceKey, targetKey)) resolvedCount++;
    }
  } else if (ext === '.py') {
    for (const m of src.matchAll(PY_FROM_RE)) {
      importCount++;
      const mod = m[1];
      const candidates = pyModuleToFiles.get(mod) ?? [];
      for (const t of candidates) if (addEdge(sourceKey, t)) resolvedCount++;
    }
    for (const m of src.matchAll(PY_IMPORT_RE)) {
      importCount++;
      const mod = m[1];
      const candidates = pyModuleToFiles.get(mod) ?? [];
      for (const t of candidates) if (addEdge(sourceKey, t)) resolvedCount++;
    }
  } else if (ext === '.hs') {
    for (const m of src.matchAll(HS_IMPORT_RE)) {
      importCount++;
      const mod = m[1];
      const candidates = hsModuleToFiles.get(mod) ?? [];
      for (const t of candidates) if (addEdge(sourceKey, t)) resolvedCount++;
    }
  } else if (ext === '.rs') {
    for (const m of src.matchAll(RS_MOD_RE)) {
      importCount++;
      const modName = m[1];
      // mod foo; ← resolves to ./foo.rs or ./foo/mod.rs next to this file
      const cand1 = normFile(path.relative(ROOT, path.join(srcDir, modName + '.rs')));
      const cand2 = normFile(path.relative(ROOT, path.join(srcDir, modName, 'mod.rs')));
      if (addEdge(sourceKey, cand1)) resolvedCount++;
      else if (addEdge(sourceKey, cand2)) resolvedCount++;
    }
    for (const m of src.matchAll(RS_USE_RE)) {
      importCount++;
      // use path::to::Item — we can't resolve paths without a crate graph.
      // Heuristic: use the last segment as a filename match.
      const segs = m[1].split('::');
      // Drop the last segment (usually an item name), use second-to-last as module hint
      const modHint = segs[segs.length - 2] ?? segs[0];
      const candidates = rsPathToFiles.get(modHint) ?? [];
      for (const t of candidates) if (addEdge(sourceKey, t)) resolvedCount++;
    }
  }
}

/** @type {Array<{source:string, target:string, weight:number}>} */
const edgesOut = [];
for (const [source, bucket] of edges) {
  for (const [target, weight] of bucket) {
    edgesOut.push({ source, target, weight });
  }
}

const outPath = path.resolve(__dirname, '../public/links-real.json');
fs.writeFileSync(
  outPath,
  JSON.stringify({ root: ROOT, files: fileSet.length, edges: edgesOut }, null, 0),
);

console.error(`imports: ${importCount} total, ${resolvedCount} resolved internal, ${edgesOut.length} unique edges`);
console.error(`bare: ${bareResolved}/${bareAttempted} bare specs resolved to local packages`);
// Show a sample of indexed package names to verify the index built correctly
console.error(`sample pkg names: ${[...npmPackages.keys()].slice(0, 5).join(', ')}`);
console.error(`written to ${path.relative(ROOT, outPath)}`);

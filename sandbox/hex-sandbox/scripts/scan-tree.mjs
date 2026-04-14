#!/usr/bin/env node
// Scan the Grafema repo and emit a JSON tree of project-significant files.
// Output: { root, leaves: [{path, folder, depth, ext, size}], folders: [{path, depth, parent, childCount}] }
//
// Usage:
//   node scripts/scan-tree.mjs /Users/vadimr/grafema > public/tree.json

import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, dirname, extname, basename } from 'node:path';
import { argv, stdout } from 'node:process';

const ROOT = argv[2] || '/Users/vadimr/grafema';

// Hard ignores: anything that isn't "the project itself".
const IGNORE_DIRS = new Set([
  'node_modules', 'target', 'dist', 'dist-newstyle', 'build', '.git',
  '.grafema', '.cache', '.next', '.turbo', '.venv', 'venv', '__pycache__',
  'coverage', '.nyc_output', '.pnpm-store', 'tmp', '.tmp',
  '.idea', '.vscode', '.DS_Store',
  // `_tasks` — mostly loose .md files with no graph structure; drowns
  // out the real code tree in visualisations. Keep `_ai` (structured).
  '_tasks',
]);
const IGNORE_FILE_PATTERNS = [
  /\.lock$/, /\.log$/, /\.map$/, /\.tsbuildinfo$/,
  /package-lock\.json$/, /pnpm-lock\.yaml$/, /yarn\.lock$/, /Cargo\.lock$/,
  /\.snap$/,
];
// Cap giant generated files so one 200k-line dump doesn't distort the layout.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Interesting extensions — everything else is ignored.
const KEEP_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.rs', '.hs', '.py', '.go', '.java', '.kt', '.rb', '.ex', '.exs',
  '.json', '.yaml', '.yml', '.toml',
  '.md', '.mdx',
  '.sql', '.sh', '.cabal',
  '.html', '.css',
]);

const leaves = [];
const folders = new Map(); // path -> { path, depth, parent, childCount }

function ensureFolder(path, depth, parent) {
  if (!folders.has(path)) folders.set(path, { path, depth, parent, childCount: 0 });
  return folders.get(path);
}

async function walk(dir, depth) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const rel = relative(ROOT, full);
      ensureFolder(rel, depth + 1, relative(ROOT, dir) || '.');
      await walk(full, depth + 1);
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      if (!KEEP_EXT.has(ext)) continue;
      if (IGNORE_FILE_PATTERNS.some((r) => r.test(e.name))) continue;
      let st;
      try { st = await stat(full); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue;
      const rel = relative(ROOT, full);
      const folder = relative(ROOT, dir) || '.';
      ensureFolder(folder, depth, relative(ROOT, dirname(dir)) || '.');
      leaves.push({
        path: rel,
        folder,
        depth,
        ext,
        size: st.size,
        name: basename(e.name),
      });
    }
  }
}

await walk(ROOT, 0);

// Fill childCount for each folder (count of leaves whose folder === this).
for (const l of leaves) {
  const f = folders.get(l.folder);
  if (f) f.childCount++;
}

// Leaves linear order: DFS with sorted children → siblings adjacent in the list.
// We already walked alphabetically, but `leaves` mixes files across subfolders
// because subdirs were walked depth-first. That's exactly what we want:
// two leaves next to each other in the array share the longest common prefix path.
// Re-sort to make it explicit and stable.
leaves.sort((a, b) => a.path.localeCompare(b.path));

const out = {
  root: ROOT,
  leaves,
  folders: [...folders.values()].sort((a, b) => a.path.localeCompare(b.path)),
  stats: {
    leafCount: leaves.length,
    folderCount: folders.size,
    totalBytes: leaves.reduce((s, l) => s + l.size, 0),
  },
};

const outPath = new URL('../public/tree.json', import.meta.url);
await writeFile(outPath, JSON.stringify(out));
stdout.write(`scanned ${leaves.length} leaves in ${folders.size} folders → ${outPath.pathname}\n`);

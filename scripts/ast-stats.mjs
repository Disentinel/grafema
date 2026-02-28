#!/usr/bin/env node
/**
 * ast-stats.mjs — Count AST node type frequency in a JS/TS codebase.
 *
 * Usage:
 *   node scripts/ast-stats.mjs <path>           # top 50 by default
 *   node scripts/ast-stats.mjs <path> --top 100
 *   node scripts/ast-stats.mjs <path> --all
 *   node scripts/ast-stats.mjs <path> --json
 */

import { createRequire } from 'module';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, resolve } from 'path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

// ─── Args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const targetPath = args.find(a => !a.startsWith('--'));
if (!targetPath) {
  console.error('Usage: node scripts/ast-stats.mjs <path> [--top N] [--all] [--json]');
  process.exit(1);
}

const asJson  = args.includes('--json');
const showAll = args.includes('--all');
const topIdx  = args.indexOf('--top');
const topN    = showAll ? 0 : topIdx !== -1 ? parseInt(args[topIdx + 1], 10) : 50;

// ─── SyntaxKind range markers (not real node types) ─────────────────────────

const SKIP_KINDS = new Set([
  'FirstAssignment', 'LastAssignment',
  'FirstCompoundAssignment', 'LastCompoundAssignment',
  'FirstReservedWord', 'LastReservedWord',
  'FirstKeyword', 'LastKeyword',
  'FirstFutureReservedWord', 'LastFutureReservedWord',
  'FirstTypeNode', 'LastTypeNode',
  'FirstPunctuation', 'LastPunctuation',
  'FirstToken', 'LastToken',
  'FirstTriviaToken', 'LastTriviaToken',
  'FirstLiteralToken', 'LastLiteralToken',
  'FirstTemplateToken', 'LastTemplateToken',
  'FirstBinaryOperator', 'LastBinaryOperator',
  'FirstStatement', 'LastStatement',
  'FirstNode',
  'FirstJSDocNode', 'LastJSDocNode',
  'FirstJSDocTagNode', 'LastJSDocTagNode',
  'Count',
]);

// ─── File collection ─────────────────────────────────────────────────────────

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (SOURCE_EXTS.has(extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.ts'))  return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

// ─── Count ───────────────────────────────────────────────────────────────────

const counts     = new Map(); // kind name → count
let totalNodes   = 0;
let totalFiles   = 0;
let skippedFiles = 0;

const absPath = resolve(targetPath);
const stat    = statSync(absPath);
const files   = stat.isDirectory() ? collectFiles(absPath) : [absPath];

for (const file of files) {
  try {
    const source = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));

    function walk(node) {
      const name = ts.SyntaxKind[node.kind];
      if (!SKIP_KINDS.has(name)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        totalNodes++;
      }
      ts.forEachChild(node, walk);
    }
    walk(sf);
    totalFiles++;
  } catch {
    skippedFiles++;
  }
}

// ─── Output ──────────────────────────────────────────────────────────────────

const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
const display = topN > 0 ? sorted.slice(0, topN) : sorted;

if (asJson) {
  console.log(JSON.stringify(Object.fromEntries(sorted), null, 2));
  process.exit(0);
}

const W = 42;
const maxCount = display[0]?.[1] ?? 1;
const BAR = 28;

console.log(`\nAST Node Type Frequency`);
console.log(`Path:         ${absPath}`);
console.log(`Files:        ${totalFiles}${skippedFiles ? ` (${skippedFiles} skipped)` : ''}`);
console.log(`Total nodes:  ${totalNodes.toLocaleString()}`);
console.log(`Unique types: ${counts.size}`);
console.log('─'.repeat(W + BAR + 20));

for (const [name, count] of display) {
  const pct   = ((count / totalNodes) * 100).toFixed(1).padStart(5);
  const bar   = '█'.repeat(Math.round((count / maxCount) * BAR)).padEnd(BAR, '░');
  const num   = count.toLocaleString().padStart(8);
  console.log(`${name.padEnd(W)} ${num}  ${pct}%  ${bar}`);
}

if (topN > 0 && sorted.length > topN) {
  console.log(`\n... and ${sorted.length - topN} more types (use --all or --top N)`);
}

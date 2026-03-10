#!/usr/bin/env node
// OXC wrapper: file → ESTree JSON to stdout
// Usage: node scripts/parse.js <file>
import { readFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';

const file = process.argv[2];
if (!file) { process.stderr.write('Usage: parse.js <file>\n'); process.exit(1); }

const source = readFileSync(file, 'utf8');
const result = parseSync(file, source, { sourceType: 'module' });
if (result.errors?.length) {
  process.stderr.write(JSON.stringify(result.errors) + '\n');
}

// Build line offset table: lineOffsets[i] = byte position of start of line i+1
const lineOffsets = [0];
for (let i = 0; i < source.length; i++) {
  if (source[i] === '\n') lineOffsets.push(i + 1);
}

function offsetToLine(offset) {
  let lo = 0, hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

// Walk AST and convert every `start` from byte offset to 1-based line number
function convertOffsets(node) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.start === 'number') {
    node.start = offsetToLine(node.start);
  }
  if (typeof node.end === 'number') {
    node.end = offsetToLine(node.end);
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      val.forEach(convertOffsets);
    } else if (val && typeof val === 'object') {
      convertOffsets(val);
    }
  }
}

convertOffsets(result.program);

process.stdout.write(JSON.stringify(result.program, (_, v) =>
  typeof v === 'bigint' ? v.toString() : v
));

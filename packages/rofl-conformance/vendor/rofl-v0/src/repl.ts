// repl.ts — interactive shell over the api. Not part of the evaluator.
// Commands:  ? L | why L | whynot L | excise F | budget N { CMD } |
//            load FILE | who NAME | retract F | tick | run [N] |
//            save FILE | restore FILE | facts [REL] | quit
// Any other line ending in '.' is asserted as program text.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { Rofl } from './api.ts';

let rofl = new Rofl();
let who: string | undefined;

const bootPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'boot.rofl');
if (fs.existsSync(bootPath)) {
  const res = rofl.load(fs.readFileSync(bootPath, 'utf8'));
  console.log(res.ok ? `loaded boot.rofl` : `boot.rofl failed: ${res.diagnostics.join('; ')}`);
}

function exec(line: string, budget?: number): void {
  line = line.trim();
  if (!line || line.startsWith('--')) return;
  const m = line.match(/^budget\s+(\d+)\s*\{(.*)\}$/s);
  if (m) return exec(m[2].trim(), parseInt(m[1], 10));
  if (line === 'quit' || line === 'exit') process.exit(0);
  if (line === 'tick') {
    const r = rofl.tickAdvance({ budget });
    console.log(JSON.stringify(r));
    return;
  }
  if (line.startsWith('run')) {
    const n = parseInt(line.slice(3).trim() || '1000', 10);
    const r = rofl.run({ maxTicks: n, budget });
    console.log(JSON.stringify(r));
    return;
  }
  if (line.startsWith('load ')) {
    const f = line.slice(5).trim();
    const r = rofl.load(fs.readFileSync(f, 'utf8'), { who, budget });
    console.log(r.ok ? 'ok' : 'REJECTED:\n' + r.diagnostics.join('\n'));
    return;
  }
  if (line.startsWith('who ')) { who = line.slice(4).trim() || undefined; return; }
  if (line.startsWith('save ')) { fs.writeFileSync(line.slice(5).trim(), rofl.save()); console.log('saved'); return; }
  if (line.startsWith('restore ')) { rofl = Rofl.fromSnapshot(fs.readFileSync(line.slice(8).trim(), 'utf8')); console.log('restored'); return; }
  if (line.startsWith('facts')) {
    const rel = line.slice(5).trim() || undefined;
    for (const k of rofl.factKeys(rel)) console.log(k);
    return;
  }
  if (line.startsWith('?')) {
    const q = rofl.query(line.slice(1).trim(), { budget });
    if (q.error) { console.log('error: ' + q.error); return; }
    if (q.rows.length === 0) console.log('(empty)');
    for (const r of q.rows) console.log(r.text);
    if (q.partial) console.log('[partial: budget exhausted, hole emitted]');
    return;
  }
  if (line.startsWith('why ')) { console.log(rofl.why(line.slice(4).trim(), { budget }).text); return; }
  if (line.startsWith('whynot ')) { console.log(rofl.whynot(line.slice(7).trim(), { budget }).text); return; }
  if (line.startsWith('excise ')) {
    const r = rofl.excise(line.slice(7).trim(), { budget });
    if (!r.ok) { console.log('error: ' + r.error); return; }
    for (const k of r.removed) console.log('- ' + k);
    for (const k of r.added) console.log('+ ' + k);
    if (r.removed.length + r.added.length === 0) console.log('(no change)');
    return;
  }
  if (line.startsWith('retract ')) {
    const r = rofl.retract(line.slice(8).trim());
    console.log(r.ok ? 'ok' : r.diagnostics.join('; '));
    return;
  }
  const r = rofl.assert(line, { who });
  console.log(r.ok ? 'ok' : r.diagnostics.join('\n'));
}

const files = process.argv.slice(2);
for (const f of files) {
  const r = rofl.load(fs.readFileSync(f, 'utf8'), { who });
  console.log(r.ok ? `loaded ${f}` : `${f} REJECTED:\n` + r.diagnostics.join('\n'));
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'rofl> ' });
  rl.prompt();
  for await (const l of rl) {
    try { exec(l); } catch (e) { console.log('error: ' + (e as Error).message); }
    rl.prompt();
  }
}
main();

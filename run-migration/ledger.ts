// ledger.ts — the ROFL-v0-driven working ledger of the RFDB→ROFL migration
// (ТЗ «Рабочий протокол»). Runs on the VENDORED oracle engine (pinned rev in
// packages/rofl-conformance/vendor/rofl-v0/REV) so ledger semantics are stable.
//
// Rebuild order (corpus driver.ts:27-66 precedent): boot.rofl → audit.rofl
// (= audit-v0.2 from corpus rev 6dfa003) → rounds/round-*.rofl sorted.
// Sources are the truth; snapshots are caches.
//
// Commands:
//   audit            — run the boot self-audits + the audit-v0.2 protocol queries;
//                      exit 1 on non-empty groundless/vocab_drift (slop gates).
//                      unevidenced/weak_ev are printed, not gated: pre-registered
//                      round claims legitimately sit there until their evidence round.
//   snapshot <name>  — write snapshots/<name>.snap.json + .sha256 (canonicalState hash)
//   q '<lit>'        — query a literal
//
// usage: node --experimental-strip-types run-migration/ledger.ts <audit|snapshot|q> [arg]

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Rofl } from '../packages/rofl-conformance/vendor/rofl-v0/src/api.ts';

const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const BUDGET = 5_000_000;

export function rebuild(): Rofl {
  const sources = [
    path.join(HERE, 'boot.rofl'),
    path.join(HERE, 'audit.rofl'),
    ...fs.readdirSync(path.join(HERE, 'rounds')).filter((f) => f.endsWith('.rofl')).sort()
      .map((f) => path.join(HERE, 'rounds', f)),
  ];
  const r = new Rofl();
  for (const src of sources) {
    const res = r.load(fs.readFileSync(src, 'utf8'), { budget: BUDGET });
    if (!res.ok) {
      console.error(`LOAD REJECTED ${path.basename(src)}: ${res.diagnostics.join(' | ')}`);
      process.exit(2);
    }
  }
  r.evaluate(BUDGET);
  return r;
}

function show(r: Rofl, q: string): string {
  const res = r.query(q, { budget: BUDGET });
  if (res.error) return `ERR ${res.error}`;
  return res.rows.map((x) => x.text).join('; ') || '(empty)';
}

const AUDITS: [string, string][] = [
  // boot self-audits (boot.rofl footer contract)
  ['unstratified', 'unstratified(X)'],
  ['malformed', 'malformed[audit](R)'],
  ['breach', 'breach[audit](R)'],
  ['leak', 'leak[audit](A, B)'], // non-empty is documented: audit-v0.2 rules read a/b/world without imports decls (corpus precedent: leak not gated)
  ['forged', 'forged[audit](F)'],
  ['unmoded', 'unmoded[audit](R)'],
  // audit-v0.2 protocol queries (corpus driver AUDIT_QUERIES precedent)
  ['open_risk', 'open_risk[audit](C)'],
  ['vocab_drift', 'vocab_drift[audit](P, L)'],
  ['groundless', 'groundless[audit](C)'],
  ['shaky', 'shaky[audit](C)'],
  ['unevidenced', 'unevidenced[audit](C)'],
  ['weak_ev', 'weak_ev[audit](C)'],
];

// Slop gates: these being non-empty means the ledger itself is malformed.
const GATED = new Set(['groundless', 'vocab_drift', 'malformed', 'breach', 'unstratified', 'unmoded']);

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'audit') {
  const r = rebuild();
  let failed = false;
  for (const [name, q] of AUDITS) {
    const out = show(r, q);
    console.log(`${name.padEnd(12)} ${out}`);
    if (GATED.has(name) && out !== '(empty)') failed = true;
  }
  if (failed) {
    console.error('AUDIT FAILED: a gated audit relation is non-empty');
    process.exit(1);
  }
} else if (cmd === 'snapshot') {
  if (!arg) { console.error('snapshot needs a name'); process.exit(2); }
  const r = rebuild();
  const state = r.store.canonicalState();
  const dir = path.join(HERE, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${arg}.snap.json`), r.save());
  const sha = crypto.createHash('sha256').update(state).digest('hex');
  fs.writeFileSync(path.join(dir, `${arg}.sha256`), sha + '\n');
  console.log(`snapshot ${arg}: ${r.store.facts.size} facts, canonicalState sha256=${sha}`);
} else if (cmd === 'q') {
  if (!arg) { console.error('q needs a literal'); process.exit(2); }
  const r = rebuild();
  console.log(show(r, arg));
} else {
  console.error('usage: ledger.ts <audit|snapshot NAME|q LITERAL>');
  process.exit(2);
}

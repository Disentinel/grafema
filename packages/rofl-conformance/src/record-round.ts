// record-round.ts — generate run-migration/rounds/round-NNN.rofl from
// conformance-report.json: evidence[world] + found[m] facts against the
// round-001 pre-registered claims, plus repair[a] for missed expectations.
// Assert-only, never retract (round-001 corpus precedent).
//
// EVIDENCE INTEGRITY: the exact report bytes are ARCHIVED per round at
// rounds/round-NNN.report.json and the recorded sha256 is computed over those
// archived bytes — evidence[world] always verifies against a persisted
// artifact, even after later runs regenerate conformance-report.json in place.
// A round can be recorded ONCE: re-recording an existing round is refused
// (any post-record change must produce a NEW round). Run identity comes from
// the conformance-run-meta.json sidecar (the report itself carries none, so
// identical runs are byte-identical).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = path.resolve(PKG, '../..');

const round = process.argv[2];
if (!round || !/^\d{3}$/.test(round)) {
  console.error('usage: record-round.ts <NNN>');
  process.exit(2);
}

const outPath = path.join(REPO, 'run-migration/rounds', `round-${round}.rofl`);
const archivePath = path.join(REPO, 'run-migration/rounds', `round-${round}.report.json`);
if (fs.existsSync(outPath) || fs.existsSync(archivePath)) {
  console.error(`ABORT: round ${round} is already recorded (${fs.existsSync(outPath) ? outPath : archivePath} exists).`);
  console.error('The ledger is assert-only: a post-record change must produce a NEW round, never a rewrite.');
  process.exit(3);
}

const reportPath = path.join(PKG, 'conformance-report.json');
const metaPath = path.join(PKG, 'conformance-run-meta.json');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
  expectedVsFound: { claim: string; expected: string; found: string; match: boolean; note: string }[];
};
if (!fs.existsSync(metaPath)) {
  console.error(`ABORT: ${metaPath} not found — record only a report produced by run.ts (which writes the run-identity sidecar).`);
  process.exit(3);
}
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { run_id: string; timestamp: string };

const reportBytes = fs.readFileSync(reportPath);
fs.copyFileSync(reportPath, archivePath);
const sha = crypto.createHash('sha256').update(reportBytes).digest('hex').slice(0, 16);
const runAtom = `run_${round}_report_sha_${sha}`;

const lines: string[] = [];
lines.push(`-- Round ${round} (${meta.timestamp.slice(0, 10)}) — evidence from the conformance harness run.`);
lines.push(`-- run_id: ${meta.run_id}; report sha256 prefix: ${sha} over the ARCHIVED bytes`);
lines.push(`-- rounds/round-${round}.report.json (verify: sha256sum that file — the live`);
lines.push(`-- conformance-report.json is regenerated per run and is NOT the evidence artifact).`);
lines.push(`-- Assert-only: found[m] records the actual outcome per pre-registered claim;`);
lines.push(`-- a mismatch gets a repair[a] with the reason (abandoned/adjusted), never a retract.`);
lines.push('');
for (const e of report.expectedVsFound) {
  const foundAtom = e.found.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
  lines.push(`evidence[world](${e.claim}, ${runAtom}).`);
  lines.push(`found[m](${e.claim}, ${foundAtom || 'unknown'}).`);
  if (!e.match) {
    const note = e.note.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 80);
    lines.push(`repair[a](${e.claim}, mismatch_documented(${note || 'see_report'})).`);
  }
}
lines.push('');

fs.writeFileSync(outPath, lines.join('\n'));
console.log(`wrote ${outPath} (${report.expectedVsFound.length} claims, run evidence ${runAtom})`);
console.log(`archived report bytes at ${archivePath}`);

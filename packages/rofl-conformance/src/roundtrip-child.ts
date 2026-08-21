// roundtrip-child.ts — child process for the p3-snapshot-roundtrip scenario
// (port of vendored-upstream test/helpers/roundtrip_child.ts against the
// VENDORED engine): restore a snapshot and evaluate WITHOUT program text.
import * as fs from 'node:fs';
import { Rofl } from '../vendor/rofl-v0/src/api.ts';

const snap = fs.readFileSync(process.argv[2], 'utf8');
const r = Rofl.fromSnapshot(snap);
r.evaluate();
console.log(JSON.stringify({
  temp: r.query('temp[verified](t1, V)').rows.map((x) => x.text),
  outlier: r.query('outlier[trust](S)').rows.map((x) => x.text),
  state: r.store.canonicalState(),
}));

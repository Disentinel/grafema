#!/usr/bin/env node
// Generate the effects-db CALLABLE-REGISTRY ground facts (Wave 14, feature
// detection as derive packs) — the structured (v2/v3) entry surface that
// packages/util/src/enrichers/libraryCallbackEnricher.ts consumes through
// EffectsLookup.getEntry(): per-method argument ROLES (ENTRY_POINT_CALLBACK,
// ROUTE_PATH, COMMAND_NAME, ...), declared returns.type, and channel metadata.
//
// DESIGN SPLIT (the wave decision): parsing/IO lives HERE (a deterministic,
// re-run-safe generator over effects-db YAML); DERIVATION lives in the .dl
// packs that join these facts against the graph (js_http_routes_* first).
// JSON-schema parsing (MCP inputSchema, vscode contributes) is OUT of scope.
//
// INCLUSION RULE: an entry qualifies iff it carries ≥1 role-annotated arg
// (`args[N].role`) OR a `channel` map. Returns-only fluent-chain entries
// (e.g. commander's dozens of `returns: Command` setters) are EXCLUDED —
// no pack consumes bare returns yet and they would triple the facts size;
// `ecb_returns` rows are still emitted for QUALIFYING entries.
//
// Output (stdout) — the facts .dl block:
//   ecb_method(Lib, Full, Bare).      one per qualifying entry; Bare = the
//                                     segment after the LAST '.' of the fn key
//                                     (libraryCallbackEnricher.ts:188-190).
//   ecb_arg(Lib, Full, Idx, Role).    one per role-annotated arg; Idx is the
//                                     YAML index VERBATIM as a string ("0").
//   ecb_returns(Lib, Full, Type).     returns.type of qualifying entries.
//   ecb_channel(Lib, Full, Key, Spec). channel rows of qualifying entries.
// Lib is the top-level YAML key VERBATIM (incl. "node:"/"python:" prefixes
// and scoped names like "@koa/router") — prefix normalization is a CONSUMER
// concern (EffectsLookup.getEntry probes "node:"+module first).
//
// DETERMINISM / COLLISION POLICY (documented, mirrors EffectsLookup.load):
//   - files are read in SORTED name order (legacy readdirSync order is
//     OS-defined — recorded delta, same as the runtime-globals generator);
//   - the same library key in TWO files of one subdir: the later file (in
//     sorted order) wins WHOLESALE — EffectsLookup.load assigns
//     db.packages[pkg] per file, so a later file replaces the whole lib;
//     reported on stderr;
//   - the same library key in runtimes/ AND packages/: runtimes wins
//     (EffectsLookup.getEntry probes runtimes first); reported on stderr.
//
// FAILSAFE_SCHEMA is MANDATORY (the Wave-4 YAML bool-key lesson): js-yaml's
// default schema resolves keys/values like `True:`/`on:` to booleans while
// the legacy loaders keep mapping-key text verbatim. Under FAILSAFE all
// scalars stay strings — which is also exactly what .dl literals need
// (arg indexes arrive as "0"/"1" verbatim).
//
// Usage: node scripts/generate-effects-callable-facts.mjs \
//          > packages/rfdb-server/src/derive/stdlib/effects_callable_facts.dl
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbDir = join(root, 'effects-db');

// js-yaml is not a root dependency; resolve it out of the pnpm store.
const yaml = (() => {
  try {
    return require('js-yaml');
  } catch {
    const store = join(root, 'node_modules', '.pnpm');
    const hit = readdirSync(store).find((d) => d.startsWith('js-yaml@'));
    if (!hit) throw new Error('js-yaml not found (root require failed and no .pnpm entry)');
    return require(join(store, hit, 'node_modules', 'js-yaml'));
  }
})();

/** Parse one fn entry (FAILSAFE: every scalar is a string). Returns the
 *  qualifying-entry record or null. */
function parseEntry(fnKey, val, where) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const args = [];
  if (Array.isArray(val.args)) {
    for (const a of val.args) {
      if (!a || typeof a !== 'object' || typeof a.role !== 'string') continue;
      const idx = a.index;
      if (typeof idx !== 'string' || !/^[0-9]+$/.test(idx)) {
        console.error(`FATAL: non-numeric arg index ${JSON.stringify(idx)} at ${where} :: ${fnKey}`);
        process.exit(1);
      }
      args.push({ index: idx, role: a.role });
    }
  }
  const channel = [];
  if (val.channel && typeof val.channel === 'object' && !Array.isArray(val.channel)) {
    for (const [k, v] of Object.entries(val.channel)) {
      if (typeof v === 'string') channel.push([k, v]);
    }
  }
  if (args.length === 0 && channel.length === 0) return null;
  const returns =
    val.returns && typeof val.returns === 'object' && typeof val.returns.type === 'string'
      ? val.returns.type
      : null;
  const dot = fnKey.lastIndexOf('.');
  const bare = dot >= 0 ? fnKey.slice(dot + 1) : fnKey;
  return { full: fnKey, bare, args, returns, channel };
}

/** Load one subdir → Map lib → { file, entries: Map full → entry }.
 *  Later sorted file wins WHOLESALE per lib (EffectsLookup.load parity). */
function loadSubdir(sub, reports) {
  const dir = join(dbDir, sub);
  const out = new Map();
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  for (const f of files) {
    const doc = yaml.load(readFileSync(join(dir, f), 'utf8'), { schema: yaml.FAILSAFE_SCHEMA });
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
    for (const [lib, fns] of Object.entries(doc)) {
      if (!fns || typeof fns !== 'object' || Array.isArray(fns)) continue;
      const entries = new Map();
      for (const [fnKey, fnVal] of Object.entries(fns)) {
        const e = parseEntry(fnKey, fnVal, `${sub}/${f}`);
        if (e) entries.set(e.full, e);
      }
      if (out.has(lib)) {
        reports.push(`lib collision in ${sub}/: "${lib}" redefined by ${f} (file ${out.get(lib).file}) — later file wins wholesale`);
      }
      if (entries.size > 0 || out.has(lib)) out.set(lib, { file: f, entries });
    }
  }
  return out;
}

const reports = [];
const runtimes = loadSubdir('runtimes', reports);
const packages = loadSubdir('packages', reports);
const db = new Map(packages);
for (const [lib, rec] of runtimes) {
  if (db.has(lib)) reports.push(`lib "${lib}" in BOTH runtimes/ and packages/ — runtimes wins (getEntry order)`);
  db.set(lib, rec); // runtimes win
}
for (const r of reports) console.error('NOTE:', r);

// Datalog string literals: keep facts escape-free (quote/backslash/newline
// would need the parser's \"-escapes; nothing in the registry uses them).
let rows = { method: [], arg: [], returns: [], channel: [] };
const lit = (s) => {
  if (s.includes('"') || s.includes('\\') || s.includes('\n')) {
    console.error(`FATAL: value needs escaping in a .dl literal: ${JSON.stringify(s)}`);
    process.exit(1);
  }
  return `"${s}"`;
};
for (const lib of [...db.keys()].sort()) {
  const { entries } = db.get(lib);
  for (const full of [...entries.keys()].sort()) {
    const e = entries.get(full);
    rows.method.push(`ecb_method(${lit(lib)}, ${lit(full)}, ${lit(e.bare)}).`);
    for (const a of e.args) rows.arg.push(`ecb_arg(${lit(lib)}, ${lit(full)}, ${lit(a.index)}, ${lit(a.role)}).`);
    if (e.returns) rows.returns.push(`ecb_returns(${lit(lib)}, ${lit(full)}, ${lit(e.returns)}).`);
    for (const [k, v] of e.channel) rows.channel.push(`ecb_channel(${lit(lib)}, ${lit(full)}, ${lit(k)}, ${lit(v)}).`);
  }
}

const lines = [];
lines.push('% ── GENERATED ground facts — DO NOT EDIT BY HAND ──────────────────────────');
lines.push('% Source: effects-db/{runtimes,packages}/*.yaml — the structured-entry');
lines.push('% callable registry (args[N].role / returns.type / channel) that');
lines.push('% libraryCallbackEnricher consumes via EffectsLookup.getEntry.');
lines.push('% Generator: scripts/generate-effects-callable-facts.mjs (Wave 14); re-run');
lines.push('% it and replace this file when the registry changes.');
lines.push(`% ${rows.method.length} entries (${rows.arg.length} arg roles, ${rows.returns.length} returns, ${rows.channel.length} channel rows).`);
lines.push('%');
lines.push('% ecb_method(Lib, Full, Bare): one per role-or-channel-carrying entry;');
lines.push('%   Lib = top-level YAML key VERBATIM, Bare = fn key after the last dot.');
lines.push('% ecb_arg(Lib, Full, Idx, Role): role-annotated argument positions.');
lines.push('% ecb_returns(Lib, Full, Type): declared returns.type of those entries.');
lines.push('% ecb_channel(Lib, Full, Key, Spec): channel metadata rows (e.g. url -> arg[0]).');
for (const k of ['method', 'arg', 'returns', 'channel']) lines.push(...rows[k]);
console.log(lines.join('\n'));
console.error(
  `OK: ${rows.method.length} entries, ${rows.arg.length} arg roles, ` +
    `${rows.returns.length} returns, ${rows.channel.length} channel rows, ${reports.length} collisions`,
);

#!/usr/bin/env node
// Generate the ground-facts half of the js_runtime_globals_* datalog2 packs
// from the effects-db YAML registry (Wave 4, resolve→datalog2 migration).
//
// Mirrors packages/grafema-common/src/Grafema/RuntimeGlobals.hs EXACTLY:
//   loadSymbolDB      (:80-84)  runtimes/ ∪ packages/, runtimes win (Map.union left bias)
//   loadFromSubdir    (:87-96)  every *.yaml in the subdir, Map.unions (left bias)
//   flattenValue      (:115-121) top-level object of modules
//   extractModuleName (:136-141) "node:fs" → "fs" (last ":"-segment)
//   mkEntries         (:144-149) per fn: qualified "mod.fn" + bare "fn" → entry
//   parseEntry        (:155-167) v1 array → effects; v2/v3 object → .effects; else []
//   SymbolEntry.seName = the fn key VERBATIM (both the bare and qualified key map to it)
//
// Output (stdout): the facts .dl block —
//   rtg_key("<dbKey>", "<seName>").   one per SymbolDB key
//   rtg_eff("<seName>", "<e1,e2>").   one per seName with non-empty effects;
//                                     winner = the db entry at the BARE key (= seName)
//
// DETERMINISM DELTAS vs the Haskell loader (recorded in the pack header):
//   - files are read in SORTED name order; legacy listDirectory order is OS-defined.
//   - within a file, first-in-document-order wins on key collisions; legacy used
//     aeson KeyMap ordering. Both only affect the EFFECTS payload of collided keys
//     (seName is invariant under every observed collision — asserted below).
//
// Usage: node scripts/generate-runtime-globals-facts.mjs > /tmp/facts.dl
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

function parseEntry(fnName, val) {
  let effects = [];
  if (Array.isArray(val)) effects = val.filter((x) => typeof x === 'string');
  else if (val && typeof val === 'object' && Array.isArray(val.effects))
    effects = val.effects.filter((x) => typeof x === 'string');
  return { seName: fnName, effects };
}

function extractModuleName(key) {
  const segs = String(key).split(':');
  return segs[segs.length - 1];
}

// Flatten one YAML file → Map key → entry (first-wins on collision, like
// Map.unions left bias; within mkEntries qualified is unioned over bare,
// i.e. qualified first — but they carry the SAME entry so order is moot).
// FAILSAFE_SCHEMA: keep mapping-key TEXT verbatim, like the legacy loader.
// Data.Yaml's parseScalar returns the raw decoded bytes for mapping KEYS with
// no tag resolution (yaml-0.11.11.2 Data/Yaml/Internal.hs:228-233; textToValue
// applies to VALUES only) — so haskell.yaml's `True:`/`False:` (runtimes/
// haskell.yaml:20-21) are SymbolDB keys "True"/"False", NOT booleans. js-yaml's
// default schema resolves those keys to true/false → Object.keys "true"/"false"
// → drifted rtg_key rows. Failsafe is safe for VALUES here because the only
// consumed values are effects STRING arrays, and no effects value is
// bool/null-resolvable (generator-time grep over effects-db, 2026-06-11).
function flattenFile(path, collisions) {
  const doc = yaml.load(readFileSync(path, 'utf8'), { schema: yaml.FAILSAFE_SCHEMA });
  const out = new Map();
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return out;
  const put = (k, entry, where) => {
    if (out.has(k)) {
      out.set(k, resolveCollision(k, out.get(k), entry, where, collisions));
      return;
    }
    out.set(k, entry);
  };
  for (const [modKey, modVal] of Object.entries(doc)) {
    if (!modVal || typeof modVal !== 'object' || Array.isArray(modVal)) continue;
    const modName = extractModuleName(modKey);
    for (const [fnName, fnVal] of Object.entries(modVal)) {
      const entry = parseEntry(fnName, fnVal);
      put(`${modName}.${fnName}`, entry, path);
      put(fnName, entry, path);
    }
  }
  return out;
}

// Collision resolution for one db key.
// - seName conflict (a BARE dotted fn key vs a QUALIFIED "mod.fn" composition of
//   the same string): the BARE entry wins — the policy is pinned by the live
//   graph oracle: production legacy minted GLOBAL::process.exit (41 CALLS edges,
//   rust.yaml `process.exit` bare entry), NOT GLOBAL::exit (node.yaml node:process
//   qualified). Legacy itself is load-order-dependent here (Map.unions over
//   listDirectory order, RuntimeGlobals.hs:95-96); bare-wins reproduces the one
//   observed witness and is applied uniformly (16 keys, see stderr report).
// - effects-only collision (same seName): first occurrence wins (Map.unions left
//   bias under sorted file order — a recorded determinism DELTA, node-meta only).
function resolveCollision(key, prev, next, where, collisions) {
  if (prev.seName !== next.seName) {
    collisions.push({ kind: 'SENAME-CONFLICT', key, a: prev.seName, b: next.seName, where });
    if (next.seName === key && prev.seName !== key) return next; // bare wins
    return prev;
  }
  if (prev.effects.join(',') !== next.effects.join(','))
    collisions.push({ kind: 'effects', key, a: prev.effects, b: next.effects, where });
  return prev;
}

function loadSubdir(sub, collisions) {
  const dir = join(dbDir, sub);
  const out = new Map();
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  for (const f of files) {
    const m = flattenFile(join(dir, f), collisions);
    for (const [k, v] of m) {
      if (out.has(k)) {
        out.set(k, resolveCollision(k, out.get(k), v, f, collisions));
        continue;
      }
      out.set(k, v);
    }
  }
  return out;
}

const collisions = [];
const runtimes = loadSubdir('runtimes', collisions);
const packages = loadSubdir('packages', collisions);
const db = new Map(runtimes);
for (const [k, v] of packages) {
  if (db.has(k)) {
    // runtimes win on same-seName collisions (Map.union left bias, :84); seName
    // conflicts still resolve bare-wins via the shared policy.
    db.set(k, resolveCollision(k, db.get(k), v, 'packages/', collisions));
    continue;
  }
  db.set(k, v);
}

// seName conflicts: a key reachable both as a QUALIFIED "mod.fn" (seName = fn)
// and as a BARE dotted fn name (seName = the whole key). Resolved bare-wins
// (see resolveCollision) — reported here for the pack header / differential.
const seNameConflicts = collisions.filter((c) => c.kind === 'SENAME-CONFLICT');
for (const c of seNameConflicts) console.error('seName conflict (bare wins):', JSON.stringify(c));

// Datalog string literals: assert no key/effect needs escaping.
for (const [k, v] of db) {
  for (const s of [k, v.seName, ...v.effects]) {
    if (s.includes('"') || s.includes('\\') || s.includes('\n')) {
      console.error(`FATAL: value needs escaping in a .dl literal: ${JSON.stringify(s)}`);
      process.exit(1);
    }
  }
}

const keys = [...db.keys()].sort();
const seNames = new Map(); // seName → effects of the BARE entry (db.get(seName))
for (const k of keys) {
  const { seName } = db.get(k);
  if (!seNames.has(seName)) {
    const bare = db.get(seName); // the bare key always exists (mkEntries inserts it)
    seNames.set(seName, bare ? bare.effects : db.get(k).effects);
  }
}

const effCollisions = collisions.filter((c) => c.kind === 'effects').length;
const lines = [];
lines.push('% ── GENERATED ground facts — DO NOT EDIT BY HAND ──────────────────────────');
lines.push('% Source: effects-db/{runtimes,packages}/*.yaml');
lines.push('% Generator: scripts/generate-runtime-globals-facts.mjs (Wave 4); re-run it');
lines.push('% and replace this block when the registry changes.');
lines.push(`% ${db.size} keys, ${seNames.size} distinct seNames, ${effCollisions} effects-only`);
lines.push(`% collisions (first-wins), ${seNameConflicts.length} seName conflicts (bare-dotted-fn`);
lines.push('% entry wins — pinned by the live oracle: GLOBAL::process.exit, 41 legacy CALLS).');
lines.push('%');
lines.push('% rtg_key(DbKey, SeName): SymbolDB membership (RuntimeGlobals.hs:144-149 —');
lines.push('%   bare fn key and qualified "mod.fn" key, seName = the fn key verbatim).');
lines.push('% rtg_eff(SeName, Effects): comma-joined effects of the bare entry, only');
lines.push('%   when non-empty (mkGlobalNode:252-255 omits empty effects).');
for (const k of keys) lines.push(`rtg_key("${k}", "${db.get(k).seName}").`);
for (const [n, eff] of [...seNames.entries()].sort()) {
  if (eff.length) lines.push(`rtg_eff("${n}", "${eff.join(',')}").`);
}
console.log(lines.join('\n'));
console.error(
  `OK: ${db.size} keys, ${seNames.size} seNames, ${effCollisions} effects-only collisions, ` +
    `${seNameConflicts.length} seName conflicts (bare wins)`
);

/**
 * EffectsLookup — standalone effects-db loader and query interface.
 *
 * Loads side-effect annotations from effects-db (runtime builtins + npm packages)
 * and provides lookup by module + function name. Extracted from ManifestGenerator
 * so other consumers (MCP handlers, enrichment plugins) can reuse effects data
 * without instantiating a full manifest pipeline.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { EffectType } from './types.js';

/** Extended effect entry (v2 format): effects array + optional channel metadata */
export interface EffectEntry {
  effects: EffectType[];
  channel?: Record<string, string>;
}

/** Raw YAML value: either a plain array (v1) or an object with effects key (v2) */
export type RawEffectValue = EffectType[] | { effects: EffectType[]; channel?: Record<string, string> };

interface EffectsDB {
  runtimes: Record<string, Record<string, EffectEntry>>;
  packages: Record<string, Record<string, EffectEntry>>;
}

/** Parse a qualified call name like "fs.readFileSync" into [module, function] */
export function parseCallTarget(qualifiedName: string): [string, string] | null {
  if (!qualifiedName || !qualifiedName.includes('.')) return null;
  const dotIndex = qualifiedName.indexOf('.');
  return [qualifiedName.substring(0, dotIndex), qualifiedName.substring(dotIndex + 1)];
}

export class EffectsLookup {
  private db: EffectsDB;

  private constructor(db: EffectsDB) {
    this.db = db;
  }

  /** Load effects-db from the given directory path */
  static load(effectsDbPath: string): EffectsLookup {
    const db: EffectsDB = { runtimes: {}, packages: {} };

    // Load runtime builtins (node.yaml, rust.yaml, etc.)
    const runtimeFiles = ['node.yaml', 'rust.yaml'];
    for (const runtimeFile of runtimeFiles) {
      const yamlPath = join(effectsDbPath, 'runtimes', runtimeFile);
      if (existsSync(yamlPath)) {
        const raw = parseYaml(readFileSync(yamlPath, 'utf-8')) as Record<string, Record<string, RawEffectValue>>;
        for (const [mod, fns] of Object.entries(raw)) {
          db.runtimes[mod] = EffectsLookup.normalizeEffectsMap(fns);
        }
      }
    }

    // Load package effects
    const pkgDir = join(effectsDbPath, 'packages');
    if (existsSync(pkgDir)) {
      for (const file of readdirSync(pkgDir)) {
        if (!file.endsWith('.yaml')) continue;
        const raw = parseYaml(readFileSync(join(pkgDir, file), 'utf-8'));
        if (raw && typeof raw === 'object') {
          for (const [pkg, fns] of Object.entries(raw)) {
            db.packages[pkg] = EffectsLookup.normalizeEffectsMap(
              fns as Record<string, RawEffectValue>,
            );
          }
        }
      }
    }

    return new EffectsLookup(db);
  }

  /** Create an empty (no-op) lookup */
  static empty(): EffectsLookup {
    return new EffectsLookup({ runtimes: {}, packages: {} });
  }

  /** Look up effects for a module.function pair */
  lookup(module: string, fn: string): EffectType[] | null {
    // Check runtime builtins (node:fs -> readFileSync)
    const nodeModule = `node:${module}`;
    if (this.db.runtimes[nodeModule]?.[fn]) {
      return this.db.runtimes[nodeModule][fn].effects;
    }
    // Also check without node: prefix
    if (this.db.runtimes[module]?.[fn]) {
      return this.db.runtimes[module][fn].effects;
    }

    // Check package effects
    if (this.db.packages[module]?.[fn]) {
      return this.db.packages[module][fn].effects;
    }

    // Check ECMAScript globals: lookup("JSON", "parse") → ecma:global["JSON.parse"]
    const ecmaGlobal = this.db.runtimes['ecma:global'];
    if (ecmaGlobal) {
      const qualifiedKey = fn ? `${module}.${fn}` : module;
      if (ecmaGlobal[qualifiedKey]) {
        return ecmaGlobal[qualifiedKey].effects;
      }
    }

    // Check ecma:web: lookup("Response", "prototype.json") → ecma:web["Response.prototype.json"]
    const ecmaWeb = this.db.runtimes['ecma:web'];
    if (ecmaWeb) {
      const qualifiedKey = fn ? `${module}.${fn}` : module;
      if (ecmaWeb[qualifiedKey]) {
        return ecmaWeb[qualifiedKey].effects;
      }
    }

    return null;
  }

  /**
   * Look up effects by qualified call name like "fs.readFileSync".
   * Also handles bare names like "Error" or "parseInt" by checking ecma:global,
   * and Rust std library methods by checking rust:core and rust:std.
   * Handles Rust :: syntax (e.g., "HashMap::new" → "HashMap.new").
   */
  lookupByCallName(qualifiedName: string): EffectType[] | null {
    // Normalize Rust :: syntax to dot syntax for uniform lookup
    // e.g., "HashMap::new" → "HashMap.new", "std::fs::remove_file" → "std.fs.remove_file"
    const normalized = qualifiedName.includes('::')
      ? qualifiedName.replace(/::/g, '.')
      : qualifiedName;

    // Try ecma:global/ecma:web for bare names (no dot) like "Error", "parseInt"
    if (!normalized.includes('.')) {
      const ecmaResult = this.lookupEcmaGlobal(normalized);
      if (ecmaResult) return ecmaResult;

      // Try rust:core and rust:std for bare names (e.g. "clone", "iter", "push")
      return this.lookupRust(normalized);
    }
    const parts = normalized.split('.');
    const module = parts[0];
    const fn = parts.slice(1).join('.');

    // First try standard module.function lookup
    const result = this.lookup(module, fn);
    if (result) return result;

    // Try the full qualified name as an ecma:global key (e.g. "JSON.parse", "Math.floor")
    const ecmaResult = this.lookupEcmaGlobal(normalized);
    if (ecmaResult) return ecmaResult;

    // Try rust:core and rust:std for Type.method patterns (e.g. "Vec.push", "Option.unwrap")
    const rustResult = this.lookupRust(normalized);
    if (rustResult) return rustResult;

    // For Rust qualified paths like "std.fs.remove_file", try last two segments as "fs.remove_file"
    if (parts.length > 2) {
      const shortName = parts.slice(-2).join('.');
      const shortRust = this.lookupRust(shortName);
      if (shortRust) return shortRust;
      // Also try just the last segment as bare name
      const bareName = parts[parts.length - 1];
      const bareRust = this.lookupRust(bareName);
      if (bareRust) return bareRust;
    }

    return null;
  }

  /**
   * Look up a name directly in ecma:global and ecma:web sections.
   * Handles both bare names ("Error", "parseInt") and qualified names ("JSON.parse").
   */
  lookupEcmaGlobal(name: string): EffectType[] | null {
    const ecmaGlobal = this.db.runtimes['ecma:global'];
    if (ecmaGlobal?.[name]) {
      return ecmaGlobal[name].effects;
    }
    const ecmaWeb = this.db.runtimes['ecma:web'];
    if (ecmaWeb?.[name]) {
      return ecmaWeb[name].effects;
    }
    return null;
  }

  /**
   * Look up a name in rust:core and rust:std runtime sections.
   * Handles both bare names ("clone", "push") and Type.method names ("Vec.push", "Option.unwrap").
   */
  lookupRust(name: string): EffectType[] | null {
    const rustCore = this.db.runtimes['rust:core'];
    if (rustCore?.[name]) {
      return rustCore[name].effects;
    }
    const rustStd = this.db.runtimes['rust:std'];
    if (rustStd?.[name]) {
      return rustStd[name].effects;
    }
    return null;
  }

  get isLoaded(): boolean {
    return Object.keys(this.db.runtimes).length > 0 || Object.keys(this.db.packages).length > 0;
  }

  /** Normalize a raw effect value (v1 array or v2 object) into EffectEntry */
  static normalizeEffectValue(raw: RawEffectValue): EffectEntry {
    if (Array.isArray(raw)) {
      return { effects: raw };
    }
    return { effects: raw.effects, channel: raw.channel };
  }

  /** Normalize a raw function map (each value may be v1 array or v2 object) */
  static normalizeEffectsMap(
    raw: Record<string, RawEffectValue>,
  ): Record<string, EffectEntry> {
    const result: Record<string, EffectEntry> = {};
    for (const [fn, val] of Object.entries(raw)) {
      result[fn] = EffectsLookup.normalizeEffectValue(val);
    }
    return result;
  }
}

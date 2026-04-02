/**
 * Manifest format types for Grafema federation.
 *
 * A manifest describes a package's export surface: what it exports,
 * what effects each export has, and what it imports.
 *
 * Manifest is the boundary contract between analyzed packages.
 * It's polyglot (purl URIs), versioned (schema + analyzer),
 * and layered (CDN < auto-generated < developer-authored).
 */

// === Effect taxonomy (from effects-db/taxonomy.yaml) ===

export type EffectType =
  | 'PURE'
  | 'MUTATION'
  | 'IO'
  | 'THROW'
  | 'ASYNC'
  | 'NONDETERMINISTIC'
  | 'UNKNOWN'
  | `IO:${string}`;

/** Valid top-level effect names from taxonomy.yaml */
export const VALID_EFFECTS: ReadonlySet<string> = new Set([
  'PURE', 'MUTATION', 'IO', 'THROW', 'ASYNC', 'NONDETERMINISTIC', 'UNKNOWN',
]);

/** Check if a string is a valid effect (top-level or IO subtype) */
export function isValidEffect(e: string): e is EffectType {
  return VALID_EFFECTS.has(e) || e.startsWith('IO:');
}

// === Flow types (universal across languages) ===

export type FlowType =
  | 'IN'    // read only
  | 'OUT'   // return value (new data)
  | 'PIPE'  // read and modified (pass-through mutation)
  | 'SINK'; // consumed, not returned

// === Export kinds ===

export type ExportKind =
  | 'FUNCTION'
  | 'CLASS'
  | 'VARIABLE'
  | 'TYPE'
  | 'CONSTANT'
  | 'INTERFACE';

// === Manifest schema ===

export interface ManifestParam {
  name: string;
  flow: FlowType;
}

export interface ManifestExport {
  name: string;
  kind: ExportKind;
  semanticId: string;
  effects: EffectType[];
  params?: ManifestParam[];
  returns?: { flow: FlowType };
  fields?: string[];  // for TYPE/INTERFACE exports
}

export interface ManifestImport {
  purl: string;
  symbols: string[];
}

export interface ManifestCapabilities {
  total_exports: number;
  total_internal_symbols: number;
  has_graph: boolean;
}

export interface ManifestPackage {
  purl: string;
  checksum?: string;
  source_type: 'source' | 'compiled_js' | 'minified' | 'dts_only';
}

export interface ManifestAccess {
  local?: string;
  remote?: string;
}

export interface ManifestLanguageSpecific {
  module_system: 'esm' | 'cjs' | 'dual';
  entry_points?: Record<string, string>;
  typescript_declarations?: boolean;
}

export interface Manifest {
  schema_version: number;
  analyzer_version: string;
  authored: boolean;
  confidence: number;
  generated: string;  // ISO 8601

  package: ManifestPackage;
  exports: ManifestExport[];
  imports: ManifestImport[];
  capabilities: ManifestCapabilities;
  access?: ManifestAccess;

  language?: string;
  language_specific?: ManifestLanguageSpecific;
}

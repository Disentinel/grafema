/**
 * JSON Schema renderer for `grafema export --as json-schema` (REG-1116
 * Phase 2).
 *
 * Emits one JSON Schema document (Draft 2020-12) per FEATURE, derived from
 * the SpecedContract attached via HAS_SPECED_CONTRACT. All FEATURE categories
 * are supported — the schema is structural (inputs/properties/required) and
 * carries category-specific metadata under the `x-grafema` extension key.
 *
 * Output shapes:
 *   - 1 feature  → the schema document directly (single-feature mode).
 *   - N features → JSON object keyed by FEATURE id, value is each schema.
 *
 * Per-feature mapping:
 *   $schema              -> Draft 2020-12 URI
 *   $id                  -> grafema://feature/<feature.id>
 *   title                -> feature.name
 *   type                 -> "object"
 *   properties[name]     -> { type, description?, default? } from
 *                            contract.inputs[]
 *   required             -> input names with `optional === false`
 *   x-grafema            -> { category, source, outputs[], errors[] } —
 *                            preserves contract info JSON Schema can't model.
 *
 * If a feature has no recovered contract, a stub schema is emitted with
 * `x-grafema.note: 'no recovered contract'`. This keeps the document
 * structurally valid even when extractors couldn't recover a spec.
 *
 * JSON Schema versioning is intentionally out of scope for v1 — see
 * `_ai/research/shape-and-contract-inference.md` §A.6.
 */
import type { Renderer, FeatureExportSnapshot } from './types.js';
import type {
  SpecedContractData,
  SpecedContractInput,
} from '../enrichers/specedContractEnricher.js';

const SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

interface PropertySchema {
  type: string;
  description?: string;
  default?: unknown;
}

interface XGrafemaExtension {
  category: string;
  source?: string;
  outputs?: SpecedContractData['outputs'];
  errors?: SpecedContractData['errors'];
  note?: string;
}

interface FeatureSchema {
  $schema: string;
  $id: string;
  title: string;
  type: 'object';
  properties: Record<string, PropertySchema>;
  required: string[];
  'x-grafema': XGrafemaExtension;
}

export const jsonSchemaRenderer: Renderer = {
  format: 'json-schema',
  supports(_category: string): boolean {
    return true;
  },
  render(snapshots: FeatureExportSnapshot[]): string {
    if (snapshots.length === 0) {
      return JSON.stringify({}, null, 2) + '\n';
    }
    if (snapshots.length === 1) {
      return JSON.stringify(buildFeatureSchema(snapshots[0]), null, 2) + '\n';
    }
    const out: Record<string, FeatureSchema> = {};
    for (const f of snapshots) {
      out[f.id] = buildFeatureSchema(f);
    }
    return JSON.stringify(out, null, 2) + '\n';
  },
};

function buildFeatureSchema(feature: FeatureExportSnapshot): FeatureSchema {
  // First contract wins — most extractors emit at most one. If none, emit a
  // stub schema with an explanatory note in x-grafema.
  const contract = feature.contracts[0];

  const properties: Record<string, PropertySchema> = {};
  const required: string[] = [];

  if (contract) {
    for (const inp of contract.inputs) {
      properties[inp.name] = buildPropertySchema(inp);
      if (inp.optional === false) required.push(inp.name);
    }
  }

  const xGrafema: XGrafemaExtension = { category: feature.category };
  if (contract) {
    xGrafema.source = contract.source;
    xGrafema.outputs = contract.outputs;
    xGrafema.errors = contract.errors;
  } else {
    xGrafema.note = 'no recovered contract';
  }

  return {
    $schema: SCHEMA_DRAFT,
    $id: `grafema://feature/${feature.id}`,
    title: feature.name,
    type: 'object',
    properties,
    required,
    'x-grafema': xGrafema,
  };
}

function buildPropertySchema(input: SpecedContractInput): PropertySchema {
  const schema: PropertySchema = { type: input.type ?? 'string' };
  if (input.description) schema.description = input.description;
  if (input.default !== undefined) schema.default = input.default;
  return schema;
}

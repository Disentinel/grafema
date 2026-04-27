/**
 * OpenAPI 3.1 renderer for `grafema export --as openapi-3.1` (REG-1116).
 *
 * Only `http:route` features are supported — other categories don't fit the
 * OpenAPI model. The orchestrator validates the feature/format pairing
 * before invoking the renderer (see `Renderer.supports`).
 *
 * Mapping (per `httpRouteExtractor.ts`):
 *   contracts[].outputs[0].description = "<METHOD> /path"   (canonical)
 *   contracts[].inputs                  = path parameters extracted by
 *                                         httpRouteExtractor.parsePathParams
 *
 * Body / query / header inputs are NOT extracted by httpRouteExtractor in v1
 * — see comment there. Once that ships, this renderer will need to bucket
 * inputs by location and emit `parameters[in=query|header]` and
 * `requestBody`.
 *
 * Output is YAML (a small bespoke emitter — keep zero new dependencies).
 */
import type { Renderer, FeatureExportSnapshot } from './types.js';
import type {
  SpecedContractData,
  SpecedContractInput,
} from '../enrichers/specedContractEnricher.js';

interface OperationContext {
  method: string;
  path: string;
  contract: SpecedContractData;
  feature: FeatureExportSnapshot;
}

const HTTP_METHODS = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all', 'trace',
]);

export const openapiRenderer: Renderer = {
  format: 'openapi-3.1',
  supports(category: string): boolean {
    return category === 'http:route';
  },
  render(snapshots: FeatureExportSnapshot[]): string {
    const operations: OperationContext[] = [];
    for (const f of snapshots) {
      if (f.category !== 'http:route') continue;
      for (const c of f.contracts) {
        if (c.source !== 'http-route') continue;
        // v2: prefer the top-level `name` (e.g. "GET /users/:id"). v1 sources
        // continue to set outputs[0].description with the same text — fall
        // back so existing fixtures still parse.
        const summary = c.name ?? c.outputs[0]?.description;
        if (!summary) continue;
        const parsed = parseRouteSummary(summary);
        if (!parsed) continue;
        operations.push({ method: parsed.method, path: parsed.path, contract: c, feature: f });
      }
    }

    return emitYaml(operations);
  },
};

/**
 * Parse a route summary line like "GET /users/:id" into method + path.
 * Accepts both the v1 outputs[0].description form and v2 contract.name form.
 * Returns null when malformed.
 */
function parseRouteSummary(summary: string): { method: string; path: string } | null {
  const trimmed = summary.trim();
  const sp = trimmed.indexOf(' ');
  if (sp <= 0) return null;
  const method = trimmed.substring(0, sp).toLowerCase();
  if (!HTTP_METHODS.has(method)) return null;
  const path = trimmed.substring(sp + 1).trim();
  if (path.length === 0) return null;
  return { method, path };
}

/**
 * Convert Express-style path params to OpenAPI bracket form.
 *
 *   /users/:id          → /users/{id}
 *   /users/:id?         → /users/{id}      (optionality lives in the
 *                                            parameter object, not the path)
 *   /files/*            → /files/{wildcard}
 */
function toOpenapiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)\??/g, '{$1}').replace(/\*([A-Za-z0-9_]*)/g, (_, name) => {
    return `{${name || 'wildcard'}}`;
  });
}

function emitYaml(operations: OperationContext[]): string {
  const lines: string[] = [];
  lines.push('openapi: 3.1.0');
  lines.push('info:');
  lines.push('  title: Grafema-exported API');
  lines.push('  version: 0.1.0');
  if (operations.length === 0) {
    lines.push('paths: {}');
    return lines.join('\n') + '\n';
  }

  // Group operations by openapi-path → method.
  const byPath = new Map<string, OperationContext[]>();
  for (const op of operations) {
    const openapiPath = toOpenapiPath(op.path);
    let bucket = byPath.get(openapiPath);
    if (!bucket) {
      bucket = [];
      byPath.set(openapiPath, bucket);
    }
    bucket.push(op);
  }

  // Deterministic key order: paths asc, then methods asc.
  const sortedPaths = Array.from(byPath.keys()).sort();

  lines.push('paths:');
  for (const p of sortedPaths) {
    lines.push(`  ${yamlKey(p)}:`);
    const ops = byPath.get(p)!;
    ops.sort((a, b) => a.method.localeCompare(b.method));
    for (const op of ops) {
      lines.push(`    ${op.method}:`);
      const summary = `${op.method.toUpperCase()} ${op.path}`;
      lines.push(`      summary: ${yamlString(summary)}`);
      lines.push(`      operationId: ${yamlString(op.feature.name)}`);
      const params = op.contract.inputs;
      if (params.length > 0) {
        lines.push('      parameters:');
        for (const p of params) {
          emitParameter(lines, p);
        }
      }
      lines.push('      responses:');
      lines.push("        '200':");
      lines.push('          description: Successful response');
    }
  }

  return lines.join('\n') + '\n';
}

function emitParameter(lines: string[], input: SpecedContractInput): void {
  lines.push(`        - name: ${yamlString(input.name)}`);
  lines.push('          in: path');
  // Path parameters are required in OpenAPI even when "optional" in the
  // route. Match OpenAPI's invariant and surface the optionality via
  // `description` instead.
  lines.push('          required: true');
  const schemaType = input.type === 'string[]' ? 'array' : (input.type ?? 'string');
  // v2 schema fields we forward into the parameter schema. None of them are
  // mandatory; emit only those present so the resulting YAML stays compact
  // and stable.
  const extras: string[] = [];
  if (typeof input.format === 'string') extras.push(`format: ${yamlString(input.format)}`);
  if (typeof input.minimum === 'number') extras.push(`minimum: ${input.minimum}`);
  if (typeof input.maximum === 'number') extras.push(`maximum: ${input.maximum}`);
  if (typeof input.minLength === 'number') extras.push(`minLength: ${input.minLength}`);
  if (typeof input.maxLength === 'number') extras.push(`maxLength: ${input.maxLength}`);
  if (typeof input.pattern === 'string') extras.push(`pattern: ${yamlString(input.pattern)}`);
  const enumVals = Array.isArray(input.enum) ? input.enum : null;

  if (schemaType === 'array') {
    lines.push('          schema:');
    lines.push('            type: array');
    lines.push('            items:');
    lines.push('              type: string');
    for (const e of extras) lines.push(`            ${e}`);
    if (enumVals) {
      lines.push('            enum:');
      for (const v of enumVals) lines.push(`              - ${yamlString(String(v))}`);
    }
  } else if (extras.length === 0 && !enumVals) {
    lines.push(`          schema: { type: ${schemaType} }`);
  } else {
    lines.push('          schema:');
    lines.push(`            type: ${schemaType}`);
    for (const e of extras) lines.push(`            ${e}`);
    if (enumVals) {
      lines.push('            enum:');
      for (const v of enumVals) lines.push(`              - ${yamlString(String(v))}`);
    }
  }
  if (input.description) {
    lines.push(`          description: ${yamlString(input.description)}`);
  }
}

/**
 * Quote a YAML string when it contains characters that would change parsing
 * (`:`, `#`, `{`, `}`, …). Otherwise leave it bare for readability.
 */
function yamlString(s: string): string {
  if (s.length === 0) return "''";
  if (/[:#{}\[\],&*?|<>=!%@`\n]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/** Same as yamlString but always quotes when key starts with non-alphanumeric. */
function yamlKey(s: string): string {
  if (/^[A-Za-z0-9_/-]+$/.test(s) && !s.includes(': ')) return s;
  return JSON.stringify(s);
}

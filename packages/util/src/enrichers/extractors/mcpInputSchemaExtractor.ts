/**
 * mcpInputSchemaExtractor (REG-1113) — extracts SpecedContractData for
 * `mcp:tool` FEATURE nodes by reading the JSON Schema declared at each tool's
 * `inputSchema` property in `packages/mcp/src/definitions/*-tools.ts`.
 *
 * The handler-signature scrape (contractEnricher.ts) for these features yields
 * one anonymous `args` parameter — useless. The real spec lives in inputSchema.
 *
 * Approach: this extractor parses the definition file independently of
 * mcpToolDefinitionEnricher (which only captures the tool's name/description
 * via a regex over top-level fields). Pulling the inputSchema reliably
 * requires balanced-brace extraction, so we keep that logic here rather than
 * thread a parsed-schema field through the sibling enricher.
 *
 * v1 limitations (callers should expect):
 *   - Output schemas are not available — MCP tool results are dynamic
 *     ToolResult content[]; SpecedContractData.outputs is `[]`.
 *   - Error schemas are not declared in MCP definitions; `errors` is `[]`.
 *   - Nested object properties are flattened to type `'object'`; we do not
 *     recurse into sub-properties for v1.
 *   - Tools created by libraryCallbackEnricher (the four high-level
 *     setRequestHandler features) lack `metadata.definition_file` and return
 *     null — there is no recoverable per-tool inputSchema for them.
 *
 * Future work (track as REG-* follow-up):
 *   - Output extraction: walk the matching handler FUNCTION body for
 *     return-type literals to derive `outputs[]`.
 *   - Error extraction: pattern-match `throw new XxxError(...)` inside the
 *     handler body for `errors[]`.
 *   - Nested schema: recurse into `properties.X.properties` once
 *     SpecedContractInput supports nested shape (currently flat).
 */

import { existsSync, readFileSync } from 'node:fs';

import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireNode } from '@grafema/types';

import type {
  SpecedContractData,
  SpecedContractExtractor,
  SpecedContractInput,
} from '../specedContractEnricher.js';

/** Shape of a single inputSchema property entry as written in *-tools.ts. */
interface RawProperty {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: unknown;
  properties?: Record<string, unknown>;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** Shape of a JSON-Schema-like inputSchema object. */
interface RawInputSchema {
  type?: string;
  properties?: Record<string, RawProperty>;
  required?: string[];
}

export const mcpInputSchemaExtractor: SpecedContractExtractor = {
  category: 'mcp:tool',
  source: 'mcp-inputSchema',
  async extract(_client: RFDBClient, feature: WireNode): Promise<SpecedContractData | null> {
    const meta = parseMetadata(feature);
    const definitionFile = typeof meta.definition_file === 'string' ? meta.definition_file : null;
    const toolName = feature.name;
    if (!definitionFile || !toolName) {
      // libraryCallbackEnricher-produced mcp:tool nodes have no
      // definition_file — they aggregate at the setRequestHandler level and
      // do not correspond to a single tool entry.
      return null;
    }

    if (!existsSync(definitionFile)) return null;

    let source: string;
    try {
      source = readFileSync(definitionFile, 'utf8');
    } catch {
      return null;
    }

    const schema = extractInputSchemaForTool(source, toolName);
    if (!schema) return null;

    const description = extractToolDescription(source, toolName);
    return mapSchemaToContract(schema, description);
  },
};

/**
 * Read the top-level `description: '...'` literal of a tool entry. Returns
 * null when the field is missing or not a simple string literal. Only single,
 * double, and template literals (without interpolations) are supported — that
 * matches how the MCP definition files are written today.
 */
export function extractToolDescription(source: string, toolName: string): string | undefined {
  const nameRe = new RegExp(
    `^ {4}name: ['"\`]${escapeRegex(toolName)}['"\`],?\\s*$`,
    'm',
  );
  const nameMatch = nameRe.exec(source);
  if (!nameMatch) return undefined;
  // Search a small window after the name match for description: '...'
  const window = source.substring(nameMatch.index, nameMatch.index + 50_000);
  // Description literal at 4-space indent. Capture content between matched quotes.
  const descRe = /^ {4}description: (['"`])([\s\S]*?)\1,?\s*$/m;
  const descMatch = descRe.exec(window);
  if (!descMatch) return undefined;
  return descMatch[2];
}

/** ---------------------------------------------------------------------------
 *  Source extraction
 *  ------------------------------------------------------------------------ */

/**
 * Locate the inputSchema JSON-Schema literal for `toolName` inside the source
 * of a *-tools.ts file. Returns null when the tool isn't found or when the
 * inputSchema block can't be evaluated.
 */
export function extractInputSchemaForTool(
  source: string,
  toolName: string,
): RawInputSchema | null {
  const block = extractInputSchemaBlock(source, toolName);
  if (block === null) return null;
  return evalLiteralBlock(block);
}

/**
 * Find the substring corresponding to the inputSchema object literal for the
 * given tool. Uses a balanced-brace scan starting from `inputSchema:` after
 * the `name: '<toolName>'` line. Returns the literal including the outer
 * braces, or null if no inputSchema follows the tool name.
 */
function extractInputSchemaBlock(source: string, toolName: string): string | null {
  // Match `name: 'toolName'` at exactly 4-space indent (top-level tool field).
  const nameRe = new RegExp(
    `^ {4}name: ['"\`]${escapeRegex(toolName)}['"\`],?\\s*$`,
    'm',
  );
  const nameMatch = nameRe.exec(source);
  if (!nameMatch) return null;

  // Look ahead a generous window for `inputSchema:` at exactly 4-space indent.
  const window = source.substring(nameMatch.index, nameMatch.index + 200_000);
  const schemaMatch = /^ {4}inputSchema: \{/m.exec(window);
  if (!schemaMatch) return null;

  // Position of the opening brace of the inputSchema object literal.
  // Search forward from the `inputSchema:` keyword until we hit `{`.
  const openBraceIdx = window.indexOf('{', schemaMatch.index);
  if (openBraceIdx < 0) return null;

  const endIdx = scanBalancedBrace(window, openBraceIdx);
  if (endIdx < 0) return null;
  return window.substring(openBraceIdx, endIdx + 1);
}

/**
 * From `start` (which must point at `{`), return the index of the matching
 * closing `}`. Tracks string and template-literal context so braces inside
 * string content do not affect the depth count. Returns -1 if unbalanced.
 */
function scanBalancedBrace(s: string, start: number): number {
  if (s[start] !== '{') return -1;
  let depth = 0;
  let i = start;
  // 'tpl' = inside a template literal ; 'tpl-expr' = inside ${...} of a
  // template literal. Each tpl-expr tracks its own brace depth (separate from
  // the outer object-literal depth), because the `}` that ends `${...}` does
  // not close any object brace.
  type Mode = 'code' | 'str-single' | 'str-double' | 'tpl' | 'tpl-expr';
  let mode: Mode = 'code';

  // Stack of frames recording how to restore previous mode/depth when leaving
  // a nested context (template literal or template-literal expression).
  interface Frame { mode: Mode; depth: number; }
  const stack: Frame[] = [];

  while (i < s.length) {
    const ch = s[i];
    const nx = s[i + 1];

    if (mode === 'str-single') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") mode = 'code';
      i++; continue;
    }
    if (mode === 'str-double') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') mode = 'code';
      i++; continue;
    }
    if (mode === 'tpl') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') {
        // End of template literal — restore previous frame (or code).
        const f = stack.pop();
        mode = f ? f.mode : 'code';
        // depth doesn't change; tpl never alters depth.
        i++; continue;
      }
      if (ch === '$' && nx === '{') {
        // Enter ${...}: stash current mode and reset a local depth counter.
        stack.push({ mode: 'tpl', depth });
        mode = 'tpl-expr';
        depth = 0;
        i += 2;
        continue;
      }
      i++; continue;
    }
    if (mode === 'tpl-expr') {
      // Inside ${...}; behaves like code but the matching `}` (depth 0)
      // returns to tpl mode rather than closing an object.
      if (ch === "'") { mode = 'str-single'; i++; continue; }
      if (ch === '"') { mode = 'str-double'; i++; continue; }
      if (ch === '`') {
        stack.push({ mode: 'tpl-expr', depth });
        mode = 'tpl';
        i++; continue;
      }
      if (ch === '{') { depth++; i++; continue; }
      if (ch === '}') {
        if (depth === 0) {
          const f = stack.pop();
          mode = f ? f.mode : 'code';
          depth = f ? f.depth : depth;
          i++; continue;
        }
        depth--;
        i++; continue;
      }
      if (ch === '/' && nx === '/') { i = skipLineComment(s, i); continue; }
      if (ch === '/' && nx === '*') { i = skipBlockComment(s, i); continue; }
      i++; continue;
    }
    // mode === 'code'
    if (ch === "'") { mode = 'str-single'; i++; continue; }
    if (ch === '"') { mode = 'str-double'; i++; continue; }
    if (ch === '`') {
      stack.push({ mode: 'code', depth });
      mode = 'tpl';
      i++; continue;
    }
    if (ch === '/' && nx === '/') { i = skipLineComment(s, i); continue; }
    if (ch === '/' && nx === '*') { i = skipBlockComment(s, i); continue; }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      i++; continue;
    }
    i++;
  }
  return -1;
}

function skipLineComment(s: string, i: number): number {
  const nl = s.indexOf('\n', i);
  return nl < 0 ? s.length : nl + 1;
}

function skipBlockComment(s: string, i: number): number {
  const end = s.indexOf('*/', i + 2);
  return end < 0 ? s.length : end + 2;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ---------------------------------------------------------------------------
 *  Literal evaluation
 *  ------------------------------------------------------------------------ */

/**
 * Evaluate a JS object-literal string into a plain object. The literal may
 * contain template-literal interpolations like `${DEFAULT_LIMIT}`. We
 * normalize those by stripping the interpolation expressions to a placeholder
 * string token before handing the source to `Function`. This keeps the
 * extractor self-contained — we don't need to import the constants module.
 *
 * The literal may also contain TypeScript-only type assertions inside its
 * values (e.g. `type: 'object' as const`, `value as SomeType`,
 * `value satisfies Schema`). `new Function` parses pure JS, so we strip those
 * suffixes before evaluation. They never affect the runtime value.
 *
 * Returns null on any evaluation error.
 */
function evalLiteralBlock(block: string): RawInputSchema | null {
  const normalized = stripTypeAssertions(normalizeTemplateInterpolations(block));
  try {
    // The literal is a plain object — wrap in parens so the parser sees an
    // expression rather than a block. No closure variables are used.
    const value = new Function(`"use strict"; return (${normalized});`)() as unknown;
    if (value && typeof value === 'object') return value as RawInputSchema;
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove TypeScript type assertions and `satisfies` clauses from a JS
 * object-literal source. We strip outside of strings/templates/comments so we
 * don't mangle text inside `description` values that legitimately contains
 * the words " as " or " satisfies ".
 *
 * Recognized suffixes (each may appear after any value):
 *   - ` as <Type>` — `'object' as const`, `42 as number`, `x as Foo<Bar>`
 *   - ` satisfies <Type>` — `expr satisfies Schema`
 *
 * We consume the type expression by reading identifiers, generics (`<...>`),
 * dotted paths, array brackets, union/intersection operators, and string
 * literals (for things like `as 'foo' | 'bar'`). Stop at any token that
 * couldn't be part of a type: `,`, `)`, `]`, `}`, `;`, or end-of-input.
 */
function stripTypeAssertions(s: string): string {
  let out = '';
  let i = 0;
  type Mode = 'code' | 'str-single' | 'str-double' | 'tpl';
  let mode: Mode = 'code';

  while (i < s.length) {
    const ch = s[i];
    const nx = s[i + 1];

    if (mode === 'code') {
      if (ch === "'") { mode = 'str-single'; out += ch; i++; continue; }
      if (ch === '"') { mode = 'str-double'; out += ch; i++; continue; }
      if (ch === '`') { mode = 'tpl'; out += ch; i++; continue; }
      if (ch === '/' && nx === '/') {
        const end = skipLineComment(s, i);
        out += s.substring(i, end);
        i = end;
        continue;
      }
      if (ch === '/' && nx === '*') {
        const end = skipBlockComment(s, i);
        out += s.substring(i, end);
        i = end;
        continue;
      }
      // Detect ` as ` or ` satisfies ` keywords surrounded by whitespace.
      const matched = matchAssertionKeyword(s, i);
      if (matched) {
        const after = skipTypeExpression(s, matched);
        i = after;
        continue;
      }
      out += ch; i++; continue;
    }
    if (mode === 'str-single') {
      if (ch === '\\') { out += ch + (nx ?? ''); i += 2; continue; }
      if (ch === "'") { mode = 'code'; }
      out += ch; i++; continue;
    }
    if (mode === 'str-double') {
      if (ch === '\\') { out += ch + (nx ?? ''); i += 2; continue; }
      if (ch === '"') { mode = 'code'; }
      out += ch; i++; continue;
    }
    // mode === 'tpl' — pass through verbatim; normalizeTemplateInterpolations
    // already replaced ${...} with <expr> placeholders.
    if (ch === '\\') { out += ch + (nx ?? ''); i += 2; continue; }
    if (ch === '`') { mode = 'code'; out += ch; i++; continue; }
    out += ch; i++; continue;
  }
  return out;
}

/**
 * If `s` starts (at index `i`) with whitespace + `as` or `satisfies` followed
 * by whitespace, return the index right after the keyword's trailing
 * whitespace. Otherwise return 0 (no match).
 */
function matchAssertionKeyword(s: string, i: number): number {
  // Require leading whitespace before the keyword to avoid matching inside
  // identifiers like `class` or `pass`.
  if (!/\s/.test(s[i] ?? '')) return 0;
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  const rest = s.substring(j);
  let kwLen = 0;
  if (rest.startsWith('as') && /\s/.test(rest[2] ?? '')) kwLen = 2;
  else if (rest.startsWith('satisfies') && /\s/.test(rest[9] ?? '')) kwLen = 9;
  else return 0;
  let k = j + kwLen;
  while (k < s.length && /\s/.test(s[k])) k++;
  return k;
}

/**
 * Starting at the beginning of a TypeScript type expression, return the index
 * just past the end of the expression. Supported: identifiers, dotted paths,
 * generics with nested `<>`, array brackets `[]`, union/intersection
 * separators, and string-literal types. Stops at JS expression terminators.
 */
function skipTypeExpression(s: string, from: number): number {
  let i = from;
  // Allow chained types: `Foo | Bar`, `A & B<C>`, `'x' | 'y'`.
  // We loop reading one type atom + optional generics + optional `[]` and
  // optional `| & .` continuation.
  while (i < s.length) {
    const ch = s[i];
    if (ch === ',' || ch === ')' || ch === ']' || ch === '}' || ch === ';') break;
    // String literal type
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\') { i += 2; continue; }
        i++;
      }
      if (i < s.length) i++; // consume closing quote
      continue;
    }
    // Generic / nested types
    if (ch === '<') {
      let depth = 1;
      i++;
      while (i < s.length && depth > 0) {
        if (s[i] === '<') depth++;
        else if (s[i] === '>') depth--;
        i++;
      }
      continue;
    }
    // Array brackets
    if (ch === '[') {
      let depth = 1;
      i++;
      while (i < s.length && depth > 0) {
        if (s[i] === '[') depth++;
        else if (s[i] === ']') depth--;
        i++;
      }
      continue;
    }
    // Identifier chars, dots, union/intersection, whitespace
    if (/[A-Za-z0-9_$.|&\s]/.test(ch)) { i++; continue; }
    break;
  }
  return i;
}

/**
 * Replace `${IDENT}` (or any expression) inside template literals with a
 * static placeholder. This is sufficient because we only consume `description`
 * strings — their exact text does not affect the extracted contract shape.
 *
 * We do this by walking the string with a state machine identical to
 * scanBalancedBrace. Anything inside a template literal that looks like
 * `${...}` is replaced with the literal text `<...>` (no JS evaluation).
 */
function normalizeTemplateInterpolations(s: string): string {
  let out = '';
  let i = 0;
  type Mode = 'code' | 'str-single' | 'str-double' | 'tpl';
  let mode: Mode = 'code';

  while (i < s.length) {
    const ch = s[i];
    const nx = s[i + 1];

    if (mode === 'code') {
      if (ch === "'") { mode = 'str-single'; out += ch; i++; continue; }
      if (ch === '"') { mode = 'str-double'; out += ch; i++; continue; }
      if (ch === '`') { mode = 'tpl'; out += ch; i++; continue; }
      out += ch; i++; continue;
    }
    if (mode === 'str-single') {
      if (ch === '\\') { out += ch + (nx ?? ''); i += 2; continue; }
      if (ch === "'") { mode = 'code'; }
      out += ch; i++; continue;
    }
    if (mode === 'str-double') {
      if (ch === '\\') { out += ch + (nx ?? ''); i += 2; continue; }
      if (ch === '"') { mode = 'code'; }
      out += ch; i++; continue;
    }
    // mode === 'tpl'
    if (ch === '\\') { out += ch + (nx ?? ''); i += 2; continue; }
    if (ch === '`') { mode = 'code'; out += ch; i++; continue; }
    if (ch === '$' && nx === '{') {
      // Skip the entire ${...} expression. We need to find the matching }
      // while honoring nested braces and strings inside the expression.
      const end = findInterpolationEnd(s, i + 2);
      if (end < 0) {
        // Malformed — bail by emitting the rest verbatim.
        out += s.substring(i);
        return out;
      }
      out += '<expr>';
      i = end + 1; // skip past the closing '}'
      continue;
    }
    out += ch; i++; continue;
  }
  return out;
}

/** Starting after `${`, return the index of the matching `}`. */
function findInterpolationEnd(s: string, from: number): number {
  let depth = 0;
  let i = from;
  type M = 'c' | 'sq' | 'dq' | 'tp';
  let mode: M = 'c';
  while (i < s.length) {
    const ch = s[i];
    if (mode === 'sq') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") mode = 'c';
      i++; continue;
    }
    if (mode === 'dq') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') mode = 'c';
      i++; continue;
    }
    if (mode === 'tp') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') mode = 'c';
      i++; continue;
    }
    if (ch === "'") { mode = 'sq'; i++; continue; }
    if (ch === '"') { mode = 'dq'; i++; continue; }
    if (ch === '`') { mode = 'tp'; i++; continue; }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') {
      if (depth === 0) return i;
      depth--;
      i++; continue;
    }
    i++;
  }
  return -1;
}

/** ---------------------------------------------------------------------------
 *  Schema → contract mapping
 *  ------------------------------------------------------------------------ */

/** JSON-Schema-allowed primitive types we propagate as-is. */
const KNOWN_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

function mapSchemaToContract(
  schema: RawInputSchema,
  toolDescription: string | undefined,
): SpecedContractData {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const inputs: SpecedContractInput[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    const typeStr = typeof prop.type === 'string' && KNOWN_TYPES.has(prop.type) ? prop.type : 'object';
    const input: SpecedContractInput = {
      name,
      type: typeStr,
      optional: !required.has(name),
    };
    if (typeof prop.description === 'string') input.description = prop.description;
    if (Object.prototype.hasOwnProperty.call(prop, 'default')) input.default = prop.default;
    if (Array.isArray(prop.enum)) input.enum = prop.enum;
    if (typeof prop.format === 'string') input.format = prop.format;
    if (typeof prop.minimum === 'number') input.minimum = prop.minimum;
    if (typeof prop.maximum === 'number') input.maximum = prop.maximum;
    if (typeof prop.minLength === 'number') input.minLength = prop.minLength;
    if (typeof prop.maxLength === 'number') input.maxLength = prop.maxLength;
    if (typeof prop.pattern === 'string') input.pattern = prop.pattern;
    inputs.push(input);
  }

  return {
    source: 'mcp-inputSchema',
    ...(toolDescription !== undefined ? { description: toolDescription } : {}),
    inputs,
    outputs: [],
    errors: [],
  };
}

function parseMetadata(node: WireNode): Record<string, unknown> {
  if (!node.metadata) return {};
  try {
    const value = JSON.parse(node.metadata) as unknown;
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return {};
}

/**
 * httpRouteExtractor (REG-1115) — SpecedContractExtractor for `http:route`
 * FEATURE nodes produced by `libraryCallbackEnricher` from the HTTP framework
 * effects-db YAML files (`express.yaml`, `fastify.yaml`, `koa-router.yaml`,
 * `koa-router-scoped.yaml`, `hono.yaml`).
 *
 * Strategy: locate the FEATURE's anchor CALL via `metadata.anchorCall`, read
 * the route-path literal at PASSES_ARGUMENT[index=0], and recover the HTTP
 * method name from `metadata.method` (set by libraryCallbackEnricher to the
 * fully-qualified YAML method name, e.g. `Application.get`).
 *
 * For each path parameter (`:id`, `:userId?`, `*wildcard`) found in the route
 * path, emit one SpecedContractInput. The single output entry is the canonical
 * `<METHOD> <path>` summary. Body / query / header inputs are NOT extracted in
 * v1 — the only reliable evidence is the handler's `req.body.X` reads, which
 * would require dataflow taint tracking (out of scope for this issue; future
 * work tracked separately).
 *
 * The extractor returns null when:
 *   - `metadata.anchorCall` is missing or unresolvable
 *   - `metadata.method` indicates a `.use(...)` call (mountpoint, not a route)
 *   - the path literal cannot be recovered from PASSES_ARGUMENT[index=0]
 *
 * Like sibling extractors, we read graph nodes via the supplied client; we do
 * not write nodes/edges here — that's the framework's job.
 */

import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireNode } from '@grafema/types';

import type {
  SpecedContractData,
  SpecedContractError,
  SpecedContractExtractor,
  SpecedContractInput,
  SpecedContractOutput,
} from '../specedContractEnricher.js';

/** Recognised HTTP methods. Anything else collapses to "ALL" in the summary. */
const HTTP_METHODS = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all', 'on',
]);

/** Methods that indicate a mountpoint (not a route) — extractor returns null. */
const MOUNTPOINT_METHODS = new Set(['use', 'route', 'register']);

export const httpRouteExtractor: SpecedContractExtractor = {
  category: 'http:route',
  source: 'http-route',
  async extract(
    client: RFDBClient,
    feature: WireNode,
  ): Promise<SpecedContractData | null> {
    const meta = parseMeta(feature);
    const anchorCallId = typeof meta?.anchorCall === 'string' ? meta.anchorCall : null;
    if (!anchorCallId) return null;

    // The libraryCallbackEnricher records the YAML method name in
    // `metadata.method`, e.g. "Application.get". Strip the receiver prefix to
    // get the raw HTTP method.
    const fullMethod = typeof meta?.method === 'string' ? meta.method : '';
    const methodName = extractMethodName(fullMethod);
    if (MOUNTPOINT_METHODS.has(methodName.toLowerCase())) return null;

    const anchor = await client.getNode(anchorCallId);
    if (!anchor) return null;

    // Read the route path literal — the first PASSES_ARGUMENT to a literal.
    const path = await readLiteralArg(client, anchor.id, 0);
    if (path === null) return null;

    // For Hono's `app.on(['GET','POST'], '/path', handler)` pattern the path
    // literal lives at index 1; we don't model that yet (the YAML annotates
    // ROUTE_PATH at index 1, but libraryCallbackEnricher's anchor wouldn't
    // also flag the args[0] method-list literal). Keeping a single-shaped
    // index=0 path is fine for the four-framework v1 scope.

    const httpMethod = HTTP_METHODS.has(methodName.toLowerCase())
      ? methodName.toLowerCase()
      : 'all';

    const pathParams = parsePathParams(path);
    const inputs: SpecedContractInput[] = pathParams.map((p) => ({
      name: p.name,
      type: 'string',
      optional: p.optional,
      description: 'Path parameter from route',
    }));

    const outputs: SpecedContractOutput[] = [
      { description: `${httpMethod.toUpperCase()} ${path}` },
    ];

    // v1: errors[] is empty. Future work — extract via taint over `throw new
    // HttpError(...)` inside the handler body.
    const errors: SpecedContractError[] = [];

    return {
      source: 'http-route',
      inputs,
      outputs,
      errors,
    };
  },
};

/** ---------------------------------------------------------------------------
 *  Path-parameter parsing
 *  ------------------------------------------------------------------------ */

interface PathParam {
  name: string;
  optional: boolean;
}

/**
 * Parse Express-style path parameters out of a route path string.
 *
 * Supported forms (matching the de-facto subset shared by Express, Koa-router,
 * Fastify, and Hono with their default path-to-regexp engines):
 *   - `:name`      — required named parameter
 *   - `:name?`     — optional named parameter
 *   - `*`          — anonymous wildcard (named "wildcard")
 *   - `*name`      — named wildcard (Hono / Fastify style)
 *
 * Trailing punctuation (`/`, `.`, `-`) terminates the parameter name. We do
 * NOT attempt to support full path-to-regexp custom regex (`:n(\d+)`) — those
 * are uncommon in practice and out of scope for v1.
 */
export function parsePathParams(path: string): PathParam[] {
  const params: PathParam[] = [];
  if (!path) return params;

  const len = path.length;
  let i = 0;

  while (i < len) {
    const ch = path.charAt(i);

    if (ch === ':') {
      // :name or :name?
      let j = i + 1;
      while (j < len && isParamChar(path.charAt(j))) j++;
      const name = path.substring(i + 1, j);
      if (name.length > 0) {
        let optional = false;
        if (j < len && path.charAt(j) === '?') {
          optional = true;
          j++;
        }
        params.push({ name, optional });
      }
      i = j;
      continue;
    }

    if (ch === '*') {
      // `*` (anonymous) or `*name` (named wildcard)
      let j = i + 1;
      while (j < len && isParamChar(path.charAt(j))) j++;
      const name = j > i + 1 ? path.substring(i + 1, j) : 'wildcard';
      // Wildcards always match zero-or-more segments → optional.
      params.push({ name, optional: true });
      i = j;
      continue;
    }

    i++;
  }

  return params;
}

/** Identifier-ish char allowed inside a path parameter name. */
function isParamChar(ch: string): boolean {
  if (ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  // a-z A-Z 0-9 _
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f
  );
}

/** ---------------------------------------------------------------------------
 *  Argument reading
 *  ------------------------------------------------------------------------ */

/**
 * Read the literal value of the n-th positional argument of a CALL node.
 * Returns null when the argument doesn't exist, isn't a literal-shaped node,
 * or carries no readable value.
 */
async function readLiteralArg(
  client: RFDBClient,
  callId: string,
  index: number,
): Promise<string | null> {
  const edges = await client.getOutgoingEdges(callId, ['PASSES_ARGUMENT'] as never);
  for (const e of edges) {
    const idx = (e as Record<string, unknown>).index;
    const idxNum =
      typeof idx === 'number'
        ? idx
        : typeof idx === 'string' && idx.length > 0
          ? Number(idx)
          : NaN;
    if (idxNum !== index) continue;
    const argNode = await client.getNode(String(e.dst));
    if (!argNode) return null;
    return readLiteralValue(argNode);
  }
  return null;
}

/** Read the underlying string value of a literal-shaped node. */
function readLiteralValue(node: WireNode): string | null {
  const meta = parseMeta(node);
  if (meta && typeof meta.value === 'string' && meta.value.length > 0) {
    return stripQuotes(meta.value);
  }
  if (node.name && node.name.length > 0 && node.name !== '<call>') {
    return stripQuotes(node.name);
  }
  return null;
}

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s.charCodeAt(0);
  const last = s.charCodeAt(s.length - 1);
  // 0x27 ', 0x22 ", 0x60 `
  if ((first === 0x27 || first === 0x22 || first === 0x60) && first === last) {
    return s.slice(1, -1);
  }
  return s;
}

function parseMeta(node: WireNode): Record<string, unknown> | null {
  if (!node.metadata) return null;
  try {
    return JSON.parse(node.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Strip the receiver prefix from a YAML method name to get just the HTTP
 * method. The libraryCallbackEnricher records `methodFullName` like
 * `Application.get`, `Router.post`, `FastifyInstance.delete`, `Hono.put`.
 */
function extractMethodName(fullName: string): string {
  const dot = fullName.lastIndexOf('.');
  if (dot < 0) return fullName;
  return fullName.substring(dot + 1);
}

/**
 * libraryCallbackEnricher — generic resolver for library entry-point callbacks.
 *
 * Reads role annotations from effects-db (`args[].role = "ENTRY_POINT_CALLBACK"`)
 * and, for every CALL node in the graph whose receiver traces back to a matching
 * library import, creates a domain node (cli:command, mcp:tool, ...) with:
 *   - EXPOSES edge from the CALL site → domain node (mirrors Express's HTTP route convention)
 *   - HANDLES edge from the domain node → callback function
 *
 * Design lives in the YAML files: adding a new framework is normally a YAML
 * edit (new entry with `role: ENTRY_POINT_CALLBACK`) plus an entry in the
 * `LIBRARY_NODE_TYPE` map below. The latter encodes which domain-node type to
 * emit per library; in v2 this should move into the YAML itself (e.g. a
 * top-level `_meta.nodeType` field).
 */

import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireEdge, WireNode } from '@grafema/types';
import type { EffectEntry, EffectsLookup } from '../manifest/effects-lookup.js';

export interface EnrichResult {
  /** Number of domain nodes (cli:command, mcp:tool, ...) created. */
  domainNodesCreated: number;
  /** Number of HANDLES edges emitted. */
  handlesEdgesCreated: number;
  /** CALL nodes whose method matched but whose receiver could not be traced
   *  back to a known library import (kept for diagnostics). */
  unresolvedCalls: number;
}

/**
 * TODO(v2): encode `nodeType` in effects-db YAML directly (e.g. as a per-method
 * `nodeType: cli:command` key). For now we keep the mapping out-of-band so the
 * YAML stays focused on effect annotations.
 */
const LIBRARY_NODE_TYPE: Record<string, string> = {
  commander: 'cli:command',
  '@modelcontextprotocol/sdk': 'mcp:tool',
};

interface Rule {
  library: string;
  classOrType: string;
  methodFullName: string;     // e.g. "Command.action"
  methodName: string;         // e.g. "action"
  callbackArgIdx: number;
  /** Other annotated args on the same method, for picking up command names. */
  otherArgRoles: Map<number, string>;
  nodeType: string;
}

/** ---------------------------------------------------------------------------
 *  Public entry point
 *  ------------------------------------------------------------------------ */

export async function enrichLibraryCallbacks(
  client: RFDBClient,
  effectsLookup: EffectsLookup,
): Promise<EnrichResult> {
  const result: EnrichResult = {
    domainNodesCreated: 0,
    handlesEdgesCreated: 0,
    unresolvedCalls: 0,
  };

  const methodIndex = buildMethodIndex(effectsLookup);
  if (methodIndex.size === 0) return result;

  // Buffer nodes/edges for a single addNodes / addEdges round-trip at the end.
  // We deliberately avoid client.createBatch().commit() because the latter goes
  // through commitBatch with `changedFiles` populated from each node's `file`,
  // which deletes pre-existing nodes in those files. As a post-resolution
  // enricher we must only add, never replace.
  const newNodes: WireNode[] = [];
  const newEdges: WireEdge[] = [];
  const seen = new Set<string>();

  for (const [methodName, rules] of methodIndex) {
    const calls: WireNode[] = [];
    for await (const call of client.queryNodes({
      type: 'CALL',
      name: '.' + methodName,
      substringMatch: true,
    })) {
      // substring match catches any name containing `.method`; we still need
      // an exact suffix to avoid false positives (`.actionSomethingElse`).
      if (!call.name?.endsWith('.' + methodName)) continue;
      calls.push(call);
    }

    for (const call of calls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);

      const resolved = await resolveReceiverLibrary(client, call);
      if (!resolved) {
        result.unresolvedCalls++;
        continue;
      }

      // Match library name: exact match (e.g. `commander`) or subpath import
      // (e.g. `@modelcontextprotocol/sdk/server/index.js` matches rule
      // `@modelcontextprotocol/sdk`). The trailing `/` guards against
      // accidental prefix matches like `@foo/bar` matching `@foo/barzooka`.
      const matchingRule = rules.find(r =>
        resolved.library === r.library ||
        resolved.library.startsWith(r.library + '/'),
      );
      if (!matchingRule) {
        result.unresolvedCalls++;
        continue;
      }

      const callbackArgId = await findArgumentTarget(client, call.id, matchingRule.callbackArgIdx);
      if (!callbackArgId) {
        result.unresolvedCalls++;
        continue;
      }

      // Try to extract a human-readable name from the chain origin's
      // COMMAND_NAME (or equivalent) literal arg, falling back to a synthetic.
      const domainName = await extractDomainName(client, resolved.originCall, matchingRule);

      const domainNodeId = makeDomainNodeId(matchingRule.nodeType, call.file, domainName, call.id);
      newNodes.push({
        id: domainNodeId,
        nodeType: matchingRule.nodeType as never,
        name: domainName,
        file: call.file,
        exported: false,
        metadata: JSON.stringify({
          library: matchingRule.library,
          method: matchingRule.methodFullName,
          anchorCall: call.id,
        }),
      });
      newEdges.push({
        src: call.id,
        dst: domainNodeId,
        edgeType: 'EXPOSES' as never,
        metadata: JSON.stringify({}),
      });
      newEdges.push({
        src: domainNodeId,
        dst: callbackArgId,
        edgeType: 'HANDLES' as never,
        metadata: JSON.stringify({}),
      });

      result.domainNodesCreated++;
      result.handlesEdgesCreated++;
    }
  }

  if (newNodes.length > 0) {
    await client.addNodes(newNodes);
  }
  if (newEdges.length > 0) {
    await client.addEdges(newEdges);
  }
  return result;
}

/** ---------------------------------------------------------------------------
 *  Effects-db indexing
 *  ------------------------------------------------------------------------ */

function buildMethodIndex(effectsLookup: EffectsLookup): Map<string, Rule[]> {
  const index = new Map<string, Rule[]>();
  for (const { library, methodFullName, entry } of iterateEntries(effectsLookup)) {
    if (!entry.args || entry.args.length === 0) continue;

    const callbackArg = entry.args.find(a => a.role === 'ENTRY_POINT_CALLBACK');
    if (!callbackArg) continue;

    const nodeType = LIBRARY_NODE_TYPE[library];
    if (!nodeType) continue;

    const dot = methodFullName.lastIndexOf('.');
    const methodName = dot >= 0 ? methodFullName.substring(dot + 1) : methodFullName;
    const classOrType = dot >= 0 ? methodFullName.substring(0, dot) : '';

    const otherArgRoles = new Map<number, string>();
    for (const a of entry.args) {
      if (a.role && a.role !== 'ENTRY_POINT_CALLBACK') {
        otherArgRoles.set(a.index, a.role);
      }
    }

    const rule: Rule = {
      library,
      classOrType,
      methodFullName,
      methodName,
      callbackArgIdx: callbackArg.index,
      otherArgRoles,
      nodeType,
    };

    const list = index.get(methodName);
    if (list) list.push(rule);
    else index.set(methodName, [rule]);
  }
  return index;
}

/** ---------------------------------------------------------------------------
 *  Receiver tracing
 *  ------------------------------------------------------------------------ */

interface ResolvedReceiver {
  library: string;
  /** The chain-origin CALL (after walking RECEIVER_CALL backwards). */
  originCall: WireNode;
}

async function resolveReceiverLibrary(
  client: RFDBClient,
  call: WireNode,
): Promise<ResolvedReceiver | null> {
  // 1. Walk RECEIVER_CALL chain to the origin. Bound the walk to avoid loops.
  let current = call;
  for (let i = 0; i < 32; i++) {
    const recvEdges = await client.getOutgoingEdges(current.id, ['RECEIVER_CALL'] as never);
    if (recvEdges.length === 0) break;
    const inner = await client.getNode(String(recvEdges[0].dst));
    if (!inner) break;
    current = inner;
  }

  // 2. Determine the receiver name from the origin call's `name`.
  //    - "<obj>.method"    → can't continue; chained but we already walked.
  //    - "Identifier"      → look up IMPORT_BINDING by that name (e.g. `new Command(...)`).
  //    - "receiver.method" → look up IMPORT_BINDING for `receiver`.
  const originName = current.name ?? '';
  const isNewExpression = isWireNewExpression(current);

  let bindingName: string | null = null;
  if (isNewExpression) {
    // For NewExpression, JS analyzer sets CALL.name to the constructor's
    // identifier (e.g. "Command"). MemberExpression news ("new ns.Command()")
    // would produce "ns.Command" — handled by the dot-split branch below.
    bindingName = originName.includes('.') ? originName.split('.')[0] : originName;
  } else if (originName.includes('.')) {
    bindingName = originName.substring(0, originName.lastIndexOf('.'));
  } else {
    bindingName = originName;
  }
  // "<obj>" indicates an unresolved chain (the JS analyzer's placeholder).
  if (!bindingName || bindingName === '<obj>' || bindingName === '<call>') return null;

  const library = await findImportSourceForName(client, current.file, bindingName);
  if (!library) return null;

  return { library, originCall: current };
}

function isWireNewExpression(node: WireNode): boolean {
  if (!node.metadata) return false;
  try {
    const meta = JSON.parse(node.metadata);
    return meta?.kind === 'new';
  } catch {
    return false;
  }
}

async function findImportSourceForName(
  client: RFDBClient,
  file: string,
  name: string,
): Promise<string | null> {
  // Candidates: IMPORT_BINDING nodes in the same file whose name === bindingName.
  // Multiple matches are unlikely but possible (rare same-name shadowing); we
  // take the first that has a metadata.source.
  // RFDB v2 has fuzzyNameFallback enabled by default; without disabling, an
  // unresolved local `const server = new Server(...)` matches `Server` from
  // `http` (or any near-name binding) and the rule matcher then rejects the
  // bogus source. Force exact-name match.
  for await (const wn of client.queryNodes({
    type: 'IMPORT_BINDING',
    name,
    file,
    fuzzyNameFallback: false,
  })) {
    const meta = parseMeta(wn);
    const source = meta?.source;
    if (typeof source === 'string' && source.length > 0) return source;
  }
  return null;
}

/** ---------------------------------------------------------------------------
 *  Argument & name extraction
 *  ------------------------------------------------------------------------ */

async function findArgumentTarget(
  client: RFDBClient,
  callId: string,
  index: number,
): Promise<string | null> {
  const edges = await client.getOutgoingEdges(callId, ['PASSES_ARGUMENT'] as never);
  for (const e of edges) {
    // base-client spreads metadata onto the edge object, so `index` is at the top level.
    const idx = (e as Record<string, unknown>).index;
    const idxNum = typeof idx === 'number' ? idx : (typeof idx === 'string' ? Number(idx) : NaN);
    if (idxNum === index) return String(e.dst);
  }
  return null;
}

async function extractDomainName(
  client: RFDBClient,
  originCall: WireNode,
  rule: Rule,
): Promise<string> {
  // Prefer the COMMAND_NAME-style annotation on the origin call: this catches
  // commander's `new Command('analyze')` and `Command.command('analyze')`.
  // Server.setRequestHandler has TOOL_SCHEMA at idx 0, which we may also use
  // as a name source if it's a literal-like node.
  const candidates: number[] = [];
  for (const [idx, role] of rule.otherArgRoles) {
    if (role === 'COMMAND_NAME' || role === 'TOOL_SCHEMA') candidates.push(idx);
  }
  // Also probe arg 0 if the rule didn't annotate it — common case for commander.
  if (!candidates.includes(0)) candidates.push(0);

  for (const idx of candidates) {
    const argId = await findArgumentTarget(client, originCall.id, idx);
    if (!argId) continue;
    const argNode = await client.getNode(argId);
    if (!argNode) continue;
    const literal = readLiteralName(argNode);
    if (literal) return literal;
  }

  return `<unnamed-${rule.nodeType.replace(':', '-')}>`;
}

function readLiteralName(node: WireNode): string | null {
  // Literal: prefer `value`, fall back to `name`.
  const meta = parseMeta(node);
  if (meta) {
    if (typeof meta.value === 'string' && meta.value.length > 0) return meta.value;
  }
  if (node.name && node.name.length > 0 && node.name !== '<call>') return node.name;
  return null;
}

/** ---------------------------------------------------------------------------
 *  Helpers
 *  ------------------------------------------------------------------------ */

function parseMeta(node: WireNode): Record<string, unknown> | null {
  if (!node.metadata) return null;
  try {
    return JSON.parse(node.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function makeDomainNodeId(nodeType: string, file: string, name: string, callId: string): string {
  // Anchor on the CALL id to keep node IDs stable across runs even when names
  // collide across files.
  return `${file || '<unknown>'}::${nodeType}::${name}::${callId}`;
}

/** Iterate all (library, methodFullName, entry) triples in the loaded effects-db.
 *  EffectsLookup keeps `db` private, so we reach in via a typed cast — this is
 *  the single read-only escape hatch and is documented in effects-lookup.ts. */
function* iterateEntries(
  effectsLookup: EffectsLookup,
): Iterable<{ library: string; methodFullName: string; entry: EffectEntry }> {
  // Casting to a structural type rather than `any` keeps this audit-friendly.
  const inner = effectsLookup as unknown as {
    db: {
      runtimes: Record<string, Record<string, EffectEntry>>;
      packages: Record<string, Record<string, EffectEntry>>;
    };
  };
  if (!inner.db) return;
  for (const [library, fns] of Object.entries(inner.db.packages)) {
    for (const [methodFullName, entry] of Object.entries(fns)) {
      yield { library, methodFullName, entry };
    }
  }
  for (const [library, fns] of Object.entries(inner.db.runtimes)) {
    for (const [methodFullName, entry] of Object.entries(fns)) {
      yield { library, methodFullName, entry };
    }
  }
}

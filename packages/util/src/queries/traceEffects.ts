/**
 * Transitive side-effect tracing via call-graph DFS.
 *
 * Traverses a function's outgoing CALLS / CALLS_REMOTE edges, collecting
 * side effects from leaf nodes (external modules, globals) via EffectsLookup,
 * and from node metadata (async, throw). Effects propagate transitively —
 * if callee has IO, caller inherits IO.
 *
 * Shared by MCP handler and CLI trace-effects command.
 *
 * @module queries/traceEffects
 */

import type { DataflowBackend, DataflowNode } from './traceDataflow.js';
import type { EffectsLookup } from '../manifest/effects-lookup.js';
import { parseCallTarget } from '../manifest/effects-lookup.js';
import type { EffectType } from '../manifest/types.js';
import { isValidEffect } from '../manifest/types.js';
import { findCallsInFunction } from './findCallsInFunction.js';

// ── Public types ──────────────────────────────────────────────

export interface TraceEffectsResult {
  node: { id: string; name: string; file?: string; line?: number };
  /** Effects from the function itself (async, throw) */
  direct: EffectType[];
  /** ALL effects including callees (superset of direct) */
  transitive: EffectType[];
  boundary_crossings: BoundaryCrossing[];
  /** Where effects originate (external calls) */
  leaf_sources: LeafSource[];
  /** True if traversal was truncated by depth limit */
  max_depth_reached: boolean;
  /** Configured depth limit */
  max_depth: number;
  nodes_visited: number;
}

export interface BoundaryCrossing {
  from_file: string;
  to_file: string;
  /** Caller function name */
  caller: string;
  /** Callee function name */
  callee: string;
  /** Effects flowing across this boundary */
  effects: EffectType[];
}

export interface LeafSource {
  /** Human-readable name, e.g., "fs.readFileSync" */
  node: string;
  /** Semantic ID */
  id: string;
  effects: EffectType[];
  depth: number;
  file?: string;
}

export interface TraceEffectsOptions {
  maxDepth?: number;
}

// ── Constants ─────────────────────────────────────────────────

const CALL_EDGE_TYPES = ['CALLS', 'CALLS_REMOTE'];
const FUNCTION_TYPES = new Set(['FUNCTION', 'METHOD', 'CONSTRUCTOR', 'LAMBDA']);

// ── Helpers ───────────────────────────────────────────────────

/** Extract direct metadata effects from a graph node (async / throw). */
function extractDirectEffects(node: DataflowNode): Set<EffectType> {
  const effects = new Set<EffectType>();
  const meta = node as Record<string, unknown>;
  if (meta.async === true) effects.add('ASYNC');
  const cf = meta.controlFlow as Record<string, boolean> | undefined;
  if (cf?.hasThrow) effects.add('THROW');
  if (cf?.canReject) effects.add('THROW');
  return effects;
}

/**
 * Read a node's `effects` metadata in either shape: a JSON array (legacy
 * enricher / Haskell resolver) or a comma-joined string (derive
 * js_runtime_globals_nodes pack, whose meta() can only project strings).
 * Returns null when no effects metadata is present.
 */
function readMetaEffects(node: DataflowNode): string[] | null {
  const raw = (node as Record<string, unknown>).effects;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.length > 0) {
    return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  }
  return null;
}

/**
 * Resolve the receiver of a dotted member call (e.g. `axios.get`) to the
 * bare/scoped module specifier it was imported from.
 *
 * The analyzer emits a dotted CALL node `axios.get` (receiver folded into the
 * name, object=undefined) whose receiver is reachable via:
 *
 *   CALL -[DERIVES_FROM]-> PROPERTY_ACCESS {base:"axios"}
 *        -[READS_FROM kind:receiver]-> REFERENCE "axios"
 *        -[READS_FROM]-> IMPORT_BINDING "axios" {source:"axios", importedName:"default"}
 *
 * Returns the IMPORT_BINDING.source iff it is a NON-RELATIVE specifier (a bare
 * or scoped package, not "./..."). Returns null for relative imports, locals,
 * or genuine ecma-globals (JSON / Math) — whose receiver does not resolve to an
 * IMPORT_BINDING at all — so callers must NOT override the global's metadata.
 *
 * @param callId  ID of the originating CALL node (NOT the resolved target).
 */
async function resolveReceiverModule(
  backend: DataflowBackend,
  callId: string,
): Promise<string | null> {
  // CALL -[DERIVES_FROM]-> PROPERTY_ACCESS (the receiver member access)
  const derivesFrom = await backend.getOutgoingEdges(callId, ['DERIVES_FROM']);
  for (const dfEdge of derivesFrom) {
    const pa = await backend.getNode(dfEdge.dst);
    if (!pa || pa.type !== 'PROPERTY_ACCESS') continue;

    // PROPERTY_ACCESS -[READS_FROM]-> REFERENCE (the receiver identifier)
    const readsFrom = await backend.getOutgoingEdges(pa.id, ['READS_FROM']);
    for (const rfEdge of readsFrom) {
      const ref = await backend.getNode(rfEdge.dst);
      if (!ref) continue;

      // Direct hit: the READS_FROM target is itself the IMPORT_BINDING.
      const fromImport = importBindingSource(ref);
      if (fromImport) return fromImport;

      // One more hop: REFERENCE -[READS_FROM]-> IMPORT_BINDING.
      if (ref.type === 'REFERENCE') {
        const readsFrom2 = await backend.getOutgoingEdges(ref.id, ['READS_FROM']);
        for (const rf2Edge of readsFrom2) {
          const binding = await backend.getNode(rf2Edge.dst);
          const src = binding ? importBindingSource(binding) : null;
          if (src) return src;
        }
      }
    }
  }
  return null;
}

/**
 * Return the source specifier of a node iff it is an IMPORT_BINDING whose
 * source is a NON-RELATIVE module (bare `axios` / scoped `@scope/pkg`), else
 * null. Relative sources ("./util") are rejected — effects-db only annotates
 * external modules, and overriding for a local import would be wrong.
 */
function importBindingSource(node: DataflowNode): string | null {
  if (node.type !== 'IMPORT_BINDING') return null;
  const source = (node as Record<string, unknown>).source;
  if (typeof source !== 'string' || source.length === 0) return null;
  if (source.startsWith('.') || source.startsWith('/')) return null;
  return source;
}

// ── DFS state ─────────────────────────────────────────────────

interface DfsResult {
  effects: Set<EffectType>;
  leafSources: LeafSource[];
  boundaryCrossings: BoundaryCrossing[];
  maxDepthReached: boolean;
}

// ── Main entry ────────────────────────────────────────────────

/**
 * Trace side effects transitively through a function's call graph.
 *
 * Returns null if startNodeId is not found in the graph.
 */
export async function traceEffects(
  backend: DataflowBackend,
  startNodeId: string,
  effectsLookup: EffectsLookup,
  options?: TraceEffectsOptions,
): Promise<TraceEffectsResult | null> {
  const maxDepth = options?.maxDepth ?? 10;

  const startNode = await backend.getNode(startNodeId);
  if (!startNode) return null;

  const visited = new Set<string>();
  const dfs = await dfsCollectEffects(backend, startNode, effectsLookup, visited, 0, maxDepth);

  const directEffects = extractDirectEffects(startNode);

  // Build transitive set — filter out PURE (it's the absence of effects)
  const transitiveSet = new Set<EffectType>(dfs.effects);
  transitiveSet.delete('PURE');

  const transitive: EffectType[] = transitiveSet.size > 0
    ? [...transitiveSet].sort()
    : ['PURE'];

  const directFiltered = [...directEffects].filter(e => e !== 'PURE');
  const direct: EffectType[] = directFiltered.length > 0
    ? directFiltered.sort()
    : ['PURE'];

  return {
    node: {
      id: startNode.id,
      name: startNode.name ?? '<unknown>',
      file: startNode.file,
      line: startNode.line,
    },
    direct,
    transitive,
    boundary_crossings: dfs.boundaryCrossings,
    leaf_sources: dfs.leafSources,
    max_depth_reached: dfs.maxDepthReached,
    max_depth: maxDepth,
    nodes_visited: visited.size,
  };
}

// ── DFS traversal ─────────────────────────────────────────────

async function dfsCollectEffects(
  backend: DataflowBackend,
  node: DataflowNode,
  effectsLookup: EffectsLookup,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
): Promise<DfsResult> {
  visited.add(node.id);

  const effects = new Set<EffectType>();
  const leafSources: LeafSource[] = [];
  const boundaryCrossings: BoundaryCrossing[] = [];
  let maxDepthReached = false;

  // Collect node's own metadata effects
  for (const e of extractDirectEffects(node)) {
    effects.add(e);
  }

  // Track which target node IDs we've already processed (to avoid duplicates
  // between findCallsInFunction results and direct-edge fallback).
  const processedTargets = new Set<string>();

  // ── Strategy 1: Use findCallsInFunction to discover CALL/METHOD_CALL nodes ──
  // This handles the real graph layout where FUNCTION → CALL → (CALLS) → target.
  // Cast backend — DataflowBackend is a superset of GraphBackend.
  const graphBackend = backend as Parameters<typeof findCallsInFunction>[0];
  const callInfos = await findCallsInFunction(graphBackend, node.id, { transitive: false });

  for (const call of callInfos) {
    if (call.resolved && call.target) {
      const targetNode = await backend.getNode(call.target.id);
      if (!targetNode) continue;

      processedTargets.add(targetNode.id);
      const result = await processTarget(
        backend, node, targetNode, effectsLookup, visited,
        depth, maxDepth, effects, leafSources, boundaryCrossings,
        { callId: call.id, callName: call.name },
      );
      if (result.maxDepthReached) maxDepthReached = true;
    } else {
      // Unresolved call — try effects-db lookup by call name
      const qualifiedName = call.object
        ? `${call.object}.${call.name}`
        : call.name;
      const byName = effectsLookup.lookupByCallName(qualifiedName);
      if (byName) {
        const leafEffects = collectEffectsFromLookup(byName, effects);
        leafSources.push({
          node: qualifiedName || call.id,
          id: call.id,
          effects: leafEffects,
          depth,
          file: call.file,
        });
      } else {
        effects.add('UNKNOWN');
        leafSources.push({
          node: qualifiedName || call.id,
          id: call.id,
          effects: ['UNKNOWN'],
          depth,
          file: call.file,
        });
      }
    }
  }

  // ── Strategy 2: Direct CALLS/CALLS_REMOTE edges from the function node ──
  // Handles backends/graphs where CALLS edges go directly from FUNCTION to
  // FUNCTION/EXTERNAL_MODULE (legacy layout, test mocks, some graph shapes).
  const directCallEdges = await backend.getOutgoingEdges(node.id, CALL_EDGE_TYPES);

  for (const edge of directCallEdges) {
    if (processedTargets.has(edge.dst)) continue;

    const targetNode = await backend.getNode(edge.dst);
    if (!targetNode) continue;

    processedTargets.add(targetNode.id);
    const result = await processTarget(
      backend, node, targetNode, effectsLookup, visited,
      depth, maxDepth, effects, leafSources, boundaryCrossings,
    );
    if (result.maxDepthReached) maxDepthReached = true;
  }

  return { effects, leafSources, boundaryCrossings, maxDepthReached };
}

/**
 * Collect valid effects from a lookup result into the accumulator set.
 * Returns the array of effects to store on the leaf source.
 */
function collectEffectsFromLookup(
  knownEffects: EffectType[],
  accumulator: Set<EffectType>,
): EffectType[] {
  const leafEffects: EffectType[] = [];
  for (const e of knownEffects) {
    if (isValidEffect(e) && e !== 'PURE') {
      accumulator.add(e);
      leafEffects.push(e);
    }
  }
  if (leafEffects.length === 0) leafEffects.push('PURE');
  return leafEffects;
}

/**
 * Process a single resolved call target. Handles all target node types:
 * - FUNCTION/METHOD/CONSTRUCTOR/LAMBDA → recurse DFS
 * - EXTERNAL_MODULE/GLOBAL_DEFINITION → effects-db lookup
 * - IMPORT_BINDING → resolve via source field + effects-db or follow IMPORTS_FROM
 * - Other → UNKNOWN
 */
async function processTarget(
  backend: DataflowBackend,
  callerNode: DataflowNode,
  targetNode: DataflowNode,
  effectsLookup: EffectsLookup,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
  effects: Set<EffectType>,
  leafSources: LeafSource[],
  boundaryCrossings: BoundaryCrossing[],
  /**
   * Context about the originating CALL node, present only when the target was
   * discovered via findCallsInFunction (Strategy 1). Used to reconcile a
   * dotted member call (`axios.get`) against effects-db by its imported
   * receiver module when the resolved target is a PURE ecma-global stand-in.
   */
  callContext?: { callId: string; callName: string },
): Promise<{ maxDepthReached: boolean }> {
  let maxDepthReached = false;

  // ── FUNCTION / METHOD / CONSTRUCTOR / LAMBDA → recurse ──
  if (FUNCTION_TYPES.has(targetNode.type)) {
    // Record boundary crossing when caller and callee are in different files
    if (callerNode.file && targetNode.file && callerNode.file !== targetNode.file) {
      boundaryCrossings.push({
        from_file: callerNode.file,
        to_file: targetNode.file,
        caller: callerNode.name ?? '<unknown>',
        callee: targetNode.name ?? '<unknown>',
        effects: [], // populated after recursion below
      });
    }

    if (visited.has(targetNode.id)) return { maxDepthReached };

    if (depth >= maxDepth) {
      effects.add('UNKNOWN');
      return { maxDepthReached: true };
    }

    const childResult = await dfsCollectEffects(
      backend, targetNode, effectsLookup, visited, depth + 1, maxDepth,
    );
    for (const e of childResult.effects) effects.add(e);
    leafSources.push(...childResult.leafSources);
    boundaryCrossings.push(...childResult.boundaryCrossings);
    if (childResult.maxDepthReached) maxDepthReached = true;

    // Backfill boundary crossing effects
    const lastCrossing = boundaryCrossings.find(
      bc => bc.from_file === callerNode.file
        && bc.to_file === targetNode.file
        && bc.caller === (callerNode.name ?? '<unknown>')
        && bc.callee === (targetNode.name ?? '<unknown>')
        && bc.effects.length === 0,
    );
    if (lastCrossing) {
      const childEffectsFiltered = [...childResult.effects].filter(e => e !== 'PURE');
      lastCrossing.effects = childEffectsFiltered.length > 0 ? childEffectsFiltered : ['PURE'];
    }

    return { maxDepthReached };
  }

  // ── EXTERNAL_MODULE / GLOBAL_DEFINITION → metadata effects first, then effects-db ──
  if (targetNode.type === 'EXTERNAL_MODULE' || targetNode.type === 'GLOBAL_DEFINITION') {
    // ── Member-call reconciliation (default-imported external module) ──
    // A dotted CALL like `axios.get` whose receiver is a default/namespace
    // import gets resolved by the runtime-globals pack onto the ecma-global
    // `get` (GLOBAL_DEFINITION, effects=PURE) — the receiver is dropped. Before
    // accepting that PURE stand-in, recover the real module from the receiver
    // chain and consult effects-db. Guarded to ONLY override a PURE/empty/
    // UNKNOWN global AND only when the receiver resolves to a non-relative
    // imported module — so genuine ecma-globals (JSON.parse, Math.max) and the
    // named-import path are untouched.
    if (callContext) {
      const parsedCall = parseCallTarget(callContext.callName);
      const globalEffects = readMetaEffects(targetNode);
      const globalIsInert =
        globalEffects === null ||
        globalEffects.length === 0 ||
        globalEffects.every(e => e === 'PURE' || e === 'UNKNOWN');
      if (parsedCall && globalIsInert) {
        const [receiverToken, fn] = parsedCall;
        const source =
          (await resolveReceiverModule(backend, callContext.callId)) ?? null;
        if (source) {
          const known =
            effectsLookup.lookup(source, fn) ??
            effectsLookup.lookup(`node:${source}`, fn);
          if (known) {
            const leafEffects = collectEffectsFromLookup(known, effects);
            leafSources.push({
              node: `${source}.${fn}`,
              id: targetNode.id,
              effects: leafEffects,
              depth,
              file: targetNode.file,
            });
            return { maxDepthReached };
          }
        }
        // Receiver token did not resolve via the chain; do NOT fall back to the
        // bare token here — without a confirmed non-relative IMPORT_BINDING we
        // cannot distinguish `axios.get` from a local-object `foo.get`. The
        // global's own (inert) metadata is used below, preserving prior behavior.
        void receiverToken;
      }
    }

    // Try reading effects from node metadata. Two producers, two shapes:
    // - legacy GenericRuntimeGlobals enricher / Haskell resolver: JSON array (MetaList)
    // - derive js_runtime_globals_nodes pack (Wave 4, DELTA 1): @materialize_node
    //   meta() can only project string surfaces, so effects arrive comma-joined
    //   ("IO,THROW"). Fresh graphs have ONLY pack-minted nodes — accept both.
    const metaEffects = readMetaEffects(targetNode);
    if (Array.isArray(metaEffects) && metaEffects.length > 0) {
      const leafEffects: EffectType[] = [];
      for (const e of metaEffects) {
        const effectStr = String(e);
        if (isValidEffect(effectStr) && effectStr !== 'PURE') {
          effects.add(effectStr as EffectType);
          leafEffects.push(effectStr as EffectType);
        }
      }
      if (leafEffects.length === 0) leafEffects.push('PURE');
      leafSources.push({
        node: targetNode.name ?? targetNode.id,
        id: targetNode.id,
        effects: leafEffects,
        depth,
        file: targetNode.file,
      });
      return { maxDepthReached };
    }

    // Fall back to effectsLookup
    const parsed = parseCallTarget(targetNode.name ?? '');
    if (parsed) {
      const [mod, fn] = parsed;
      const knownEffects = effectsLookup.lookup(mod, fn);
      if (knownEffects) {
        const leafEffects = collectEffectsFromLookup(knownEffects, effects);
        leafSources.push({
          node: targetNode.name ?? targetNode.id,
          id: targetNode.id,
          effects: leafEffects,
          depth,
          file: targetNode.file,
        });
      } else {
        effects.add('UNKNOWN');
        leafSources.push({
          node: targetNode.name ?? targetNode.id,
          id: targetNode.id,
          effects: ['UNKNOWN'],
          depth,
          file: targetNode.file,
        });
      }
    } else {
      effects.add('UNKNOWN');
      leafSources.push({
        node: targetNode.name ?? targetNode.id,
        id: targetNode.id,
        effects: ['UNKNOWN'],
        depth,
        file: targetNode.file,
      });
    }
    return { maxDepthReached };
  }

  // ── IMPORT_BINDING → resolve via source + effects-db or follow IMPORTS_FROM ──
  if (targetNode.type === 'IMPORT_BINDING') {
    const meta = targetNode as Record<string, unknown>;
    const source = (meta.source as string) ?? '';
    const importedName = targetNode.name ?? '';

    // Non-relative import (e.g. 'fs', '@grafema/util', 'express')
    if (source && !source.startsWith('.')) {
      const knownEffects = effectsLookup.lookup(source, importedName)
        ?? effectsLookup.lookup(`node:${source}`, importedName);
      if (knownEffects) {
        const leafEffects = collectEffectsFromLookup(knownEffects, effects);
        leafSources.push({
          node: `${source}.${importedName}`,
          id: targetNode.id,
          effects: leafEffects,
          depth,
          file: targetNode.file,
        });
      } else {
        effects.add('UNKNOWN');
        leafSources.push({
          node: `${source}.${importedName}`,
          id: targetNode.id,
          effects: ['UNKNOWN'],
          depth,
          file: targetNode.file,
        });
      }
      return { maxDepthReached };
    }

    // Relative import — follow IMPORTS_FROM edge to find the target MODULE,
    // then look for a matching FUNCTION/METHOD in that module.
    const importsFromEdges = await backend.getOutgoingEdges(targetNode.id, ['IMPORTS_FROM']);
    if (importsFromEdges.length > 0) {
      const moduleNode = await backend.getNode(importsFromEdges[0].dst);
      if (moduleNode && importedName) {
        // Search for a function with the same name in the target module's file
        let foundTarget: DataflowNode | null = null;
        for await (const candidate of backend.queryNodes({
          type: 'FUNCTION',
          name: importedName,
          file: moduleNode.file,
        })) {
          foundTarget = candidate;
          break;
        }
        if (!foundTarget) {
          for await (const candidate of backend.queryNodes({
            type: 'METHOD',
            name: importedName,
            file: moduleNode.file,
          })) {
            foundTarget = candidate;
            break;
          }
        }

        if (foundTarget && !visited.has(foundTarget.id)) {
          if (depth >= maxDepth) {
            effects.add('UNKNOWN');
            return { maxDepthReached: true };
          }
          // Track boundary crossing for relative imports
          if (callerNode.file && foundTarget.file && callerNode.file !== foundTarget.file) {
            boundaryCrossings.push({
              from_file: callerNode.file,
              to_file: foundTarget.file,
              caller: callerNode.name ?? '<unknown>',
              callee: foundTarget.name ?? '<unknown>',
              effects: [],
            });
          }

          const childResult = await dfsCollectEffects(
            backend, foundTarget, effectsLookup, visited, depth + 1, maxDepth,
          );
          for (const e of childResult.effects) effects.add(e);
          leafSources.push(...childResult.leafSources);
          boundaryCrossings.push(...childResult.boundaryCrossings);
          if (childResult.maxDepthReached) maxDepthReached = true;

          // Backfill boundary crossing effects
          const lastCrossing = boundaryCrossings.find(
            bc => bc.from_file === callerNode.file
              && bc.to_file === foundTarget!.file
              && bc.caller === (callerNode.name ?? '<unknown>')
              && bc.callee === (foundTarget!.name ?? '<unknown>')
              && bc.effects.length === 0,
          );
          if (lastCrossing) {
            const childEffectsFiltered = [...childResult.effects].filter(e => e !== 'PURE');
            lastCrossing.effects = childEffectsFiltered.length > 0 ? childEffectsFiltered : ['PURE'];
          }

          return { maxDepthReached };
        }
      }
    }

    // Could not resolve relative import — mark UNKNOWN
    effects.add('UNKNOWN');
    leafSources.push({
      node: importedName || targetNode.id,
      id: targetNode.id,
      effects: ['UNKNOWN'],
      depth,
      file: targetNode.file,
    });
    return { maxDepthReached };
  }

  // ── Other node types → try name-based lookup, otherwise UNKNOWN ──
  const callName = targetNode.name ?? '';
  const byName = effectsLookup.lookupByCallName(callName);
  if (byName) {
    const leafEffects = collectEffectsFromLookup(byName, effects);
    leafSources.push({
      node: callName || targetNode.id,
      id: targetNode.id,
      effects: leafEffects,
      depth,
      file: targetNode.file,
    });
  } else {
    effects.add('UNKNOWN');
    leafSources.push({
      node: callName || targetNode.id,
      id: targetNode.id,
      effects: ['UNKNOWN'],
      depth,
      file: targetNode.file,
    });
  }

  return { maxDepthReached };
}

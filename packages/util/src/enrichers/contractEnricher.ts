/**
 * contractEnricher — L1 CONTRACT extraction.
 *
 * For every FEATURE-class node (cli:command, mcp:tool, vscode:command) created
 * by the L0 entry-point detection enrichers, walk the HANDLES edge to the
 * handler FUNCTION and extract a structured contract:
 *
 *   - inputs   — PARAMETERs reached via RECEIVES_ARGUMENT (positional, with
 *                optional flag derived from outgoing ASSIGNED_FROM).
 *   - outputs  — RETURNS edge targets (one entry per return statement).
 *   - errors   — THROWS edge targets (one entry per throw site).
 *
 * The result is a CONTRACT node + HAS_CONTRACT edge from the FEATURE. The
 * CONTRACT carries the inputs/outputs/errors arrays in its metadata, which
 * downstream auto-doc consumers can render.
 *
 * Like sibling enrichers, this uses direct addNodes/addEdges (not BatchHandle
 * .commit) — we only ever ADD, and BatchHandle.commit deletes pre-existing
 * nodes whose `file` field appears in changedFiles. See the skill
 * `rfdb-batchhandle-deletes-existing-nodes` for the full story.
 */

import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireEdge, WireNode } from '@grafema/types';

/** Single positional input to a feature handler. */
export interface ContractInput {
  /** Parameter name as it appears in source. */
  name: string;
  /** TypeScript type annotation, if recorded by the analyzer. */
  typeAnnotation?: string;
  /** True when the parameter has a default value (PARAMETER --ASSIGNED_FROM--> ...). */
  optional?: boolean;
  /** Positional order in the function signature (0-based). */
  index: number;
}

/** Single output (return statement target). */
export interface ContractOutput {
  /** Node type of the return target (FUNCTION/CALL/LITERAL/...). */
  targetType: string;
  /** Name of the return target, when available. */
  targetName?: string;
}

/** Single error (throw target). */
export interface ContractError {
  /** Node type of the throw target. */
  targetType: string;
  /** Name of the throw target — typically the error class for `throw new X(...)`. */
  targetName?: string;
}

export interface ContractEnrichResult {
  /** Number of CONTRACT nodes created. */
  contractsCreated: number;
  /** Total inputs across all created contracts. */
  inputsTotal: number;
  /** Total outputs across all created contracts. */
  outputsTotal: number;
  /** Total errors across all created contracts. */
  errorsTotal: number;
  /** Diagnostic: features whose HANDLES edge was missing or pointed at a
   *  non-existent target. */
  featuresWithoutEntry: number;
}

/** FEATURE-class node types we extract contracts for. */
const FEATURE_TYPES: readonly string[] = ['cli:command', 'mcp:tool', 'vscode:command'];

const ADD_BATCH_SIZE = 500;

/**
 * Enrich the graph with CONTRACT nodes for every FEATURE-class entry point.
 *
 * Idempotent: the CONTRACT node id is `${feature.id}::contract`, so re-running
 * the enricher overwrites the same row rather than producing duplicates. The
 * matching HAS_CONTRACT edge has the same (src, dst, edgeType) tuple, which
 * RFDB also dedupes.
 */
export async function enrichContracts(
  client: RFDBClient,
): Promise<ContractEnrichResult> {
  const result: ContractEnrichResult = {
    contractsCreated: 0,
    inputsTotal: 0,
    outputsTotal: 0,
    errorsTotal: 0,
    featuresWithoutEntry: 0,
  };

  const newNodes: WireNode[] = [];
  const newEdges: WireEdge[] = [];
  const seenContractIds = new Set<string>();

  for (const featureType of FEATURE_TYPES) {
    // Materialize the FEATURE list before doing any per-feature traversal:
    // the queryNodes generator reuses the same client connection that the
    // per-feature getOutgoingEdges/getNode calls also need.
    const features: WireNode[] = [];
    for await (const feature of client.queryNodes({ type: featureType })) {
      features.push(feature);
    }

    for (const feature of features) {
      const contractId = `${feature.id}::contract`;
      if (seenContractIds.has(contractId)) continue;
      seenContractIds.add(contractId);

      const handlesEdges = await client.getOutgoingEdges(feature.id, ['HANDLES'] as never);
      if (handlesEdges.length === 0) {
        result.featuresWithoutEntry++;
        continue;
      }

      const handlerId = String(handlesEdges[0].dst);
      const handler = await client.getNode(handlerId);
      if (!handler) {
        result.featuresWithoutEntry++;
        continue;
      }

      const inputs = await collectInputs(client, handlerId);
      const outputs = await collectOutputs(client, handlerId);
      const errors = await collectErrors(client, handlerId);

      newNodes.push({
        id: contractId,
        nodeType: 'CONTRACT' as never,
        name: feature.name,
        file: feature.file,
        exported: false,
        metadata: JSON.stringify({
          inputs,
          outputs,
          errors,
          featureId: feature.id,
          handlerId,
        }),
      });
      newEdges.push({
        src: feature.id,
        dst: contractId,
        edgeType: 'HAS_CONTRACT' as never,
        metadata: JSON.stringify({}),
      });

      result.contractsCreated++;
      result.inputsTotal += inputs.length;
      result.outputsTotal += outputs.length;
      result.errorsTotal += errors.length;

      // Flush in chunks to keep request payloads bounded on large graphs.
      if (newNodes.length >= ADD_BATCH_SIZE) {
        await client.addNodes(newNodes.splice(0, newNodes.length));
      }
      if (newEdges.length >= ADD_BATCH_SIZE) {
        await client.addEdges(newEdges.splice(0, newEdges.length));
      }
    }
  }

  if (newNodes.length > 0) await client.addNodes(newNodes);
  if (newEdges.length > 0) await client.addEdges(newEdges);

  return result;
}

/** ---------------------------------------------------------------------------
 *  Inputs / outputs / errors collection
 *  ------------------------------------------------------------------------ */

async function collectInputs(
  client: RFDBClient,
  fnId: string,
): Promise<ContractInput[]> {
  const edges = await client.getOutgoingEdges(fnId, ['RECEIVES_ARGUMENT'] as never);

  // Resolve PARAMETER nodes preserving traversal order. Edge metadata typically
  // does not carry a positional index for RECEIVES_ARGUMENT (the JS analyzer
  // emits empty metadata), so the canonical ordering is the order in which the
  // edges were emitted — i.e. the parameter declaration order. Fall back to
  // metadata.index when present (other analyzers may set it).
  const inputs: ContractInput[] = [];
  let fallbackIndex = 0;
  for (const edge of edges) {
    const paramId = String(edge.dst);
    const param = await client.getNode(paramId);
    if (!param) {
      fallbackIndex++;
      continue;
    }
    if (param.nodeType !== 'PARAMETER') {
      // Defensive: RECEIVES_ARGUMENT should only point at PARAMETER nodes,
      // but skip anything else without crashing.
      fallbackIndex++;
      continue;
    }

    const meta = parseMeta(param);
    const edgeIdx = readEdgeIndex(edge);
    const index = edgeIdx ?? fallbackIndex;
    fallbackIndex++;

    const typeAnnotation =
      typeof meta?.typeAnnotation === 'string' ? meta.typeAnnotation : undefined;

    // Optional iff the parameter has an outgoing ASSIGNED_FROM (default value).
    // The analyzer emits this only for AssignmentPattern params.
    const assignedFrom = await client.getOutgoingEdges(paramId, ['ASSIGNED_FROM'] as never);
    const optional = assignedFrom.length > 0 ? true : undefined;

    inputs.push({
      name: param.name ?? '',
      ...(typeAnnotation !== undefined ? { typeAnnotation } : {}),
      ...(optional !== undefined ? { optional } : {}),
      index,
    });
  }

  // Sort by index in case edges arrived out of order. Stable for equal indices.
  inputs.sort((a, b) => a.index - b.index);
  return inputs;
}

async function collectOutputs(
  client: RFDBClient,
  fnId: string,
): Promise<ContractOutput[]> {
  const edges = await client.getOutgoingEdges(fnId, ['RETURNS'] as never);
  const outputs: ContractOutput[] = [];
  for (const edge of edges) {
    const target = await client.getNode(String(edge.dst));
    if (!target) continue;
    outputs.push(makeRef(target));
  }
  return outputs;
}

async function collectErrors(
  client: RFDBClient,
  fnId: string,
): Promise<ContractError[]> {
  const edges = await client.getOutgoingEdges(fnId, ['THROWS'] as never);
  const errors: ContractError[] = [];
  for (const edge of edges) {
    const target = await client.getNode(String(edge.dst));
    if (!target) continue;
    errors.push(makeRef(target));
  }
  return errors;
}

/** ---------------------------------------------------------------------------
 *  Helpers
 *  ------------------------------------------------------------------------ */

function makeRef(node: WireNode): { targetType: string; targetName?: string } {
  const ref: { targetType: string; targetName?: string } = {
    targetType: String(node.nodeType),
  };
  if (node.name && node.name.length > 0) ref.targetName = node.name;
  return ref;
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
 * RFDB base-client spreads edge metadata fields onto the edge object, but some
 * code paths still nest them under `metadata`. Read both shapes.
 */
function readEdgeIndex(edge: WireEdge): number | undefined {
  const top = (edge as unknown as Record<string, unknown>).index;
  if (typeof top === 'number') return top;
  if (typeof top === 'string') {
    const n = Number(top);
    if (!Number.isNaN(n)) return n;
  }
  if (edge.metadata) {
    try {
      const parsed = JSON.parse(edge.metadata) as Record<string, unknown>;
      const idx = parsed.index;
      if (typeof idx === 'number') return idx;
      if (typeof idx === 'string') {
        const n = Number(idx);
        if (!Number.isNaN(n)) return n;
      }
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

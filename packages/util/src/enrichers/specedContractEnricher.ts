/**
 * specedContractEnricher — Speced contract framework (REG-1111).
 *
 * The shipped contractEnricher.ts extracts the JS handler-function signature
 * only — useful for raw IMPL contracts but useless for documenting the user-
 * facing surface. The *real* user-facing interface for cli:command / mcp:tool /
 * vscode:command / package:export / http:route lives in declarative library
 * calls (commander spec strings, MCP `inputSchema`, package.json#contributes,
 * route registrations). Those are the **speced** contracts.
 *
 * This module is the per-FEATURE-category orchestrator. Per-category
 * extractors (commander, MCP inputSchema, vscode contributes, http) are
 * implemented in follow-up issues REG-1112/1113/1114/1115. This file only
 * provides the framework: iterate FEATUREs, dispatch to a registered
 * SpecedContractExtractor, and write SPECED_CONTRACT nodes + HAS_SPECED_CONTRACT
 * edges.
 *
 * Like sibling enrichers, this uses direct addNodes/addEdges (not BatchHandle
 * .commit) — see skill `rfdb-batchhandle-deletes-existing-nodes` for why.
 *
 * See also:
 *   - _ai/research/feature-taxonomy.md (entity model and edges)
 *   - _ai/research/shape-and-contract-inference.md (three-class taxonomy;
 *     this issue covers the "Speced" class only)
 */

import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireEdge, WireNode } from '@grafema/types';

/** A single user-facing input field (CLI flag, MCP arg, HTTP body field, …). */
export interface SpecedContractInput {
  name: string;
  type?: string;
  optional?: boolean;
  default?: unknown;
  description?: string;
  /** True for variadic positionals like commander '<files...>'. */
  variadic?: boolean;
  /** Enumerated allowed values when known (e.g., MCP inputSchema enum). */
  enum?: unknown[];
  /** JSON Schema format hint ('email', 'date-time', etc.) when present. */
  format?: string;
  /** Per-axis validation constraints. */
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Where in source the input was declared. */
  sourceLocation?: { file: string; line: number };
}

/** A single output declared by the FEATURE's spec. */
export interface SpecedContractOutput {
  name?: string;
  type?: string;
  description?: string;
  /** HTTP status code when applicable (http:route renderer). */
  statusCode?: number;
  /** Output kind tag — 'menu' | 'keybinding' | 'http' | 'cli' | etc. Free-form for v2. */
  kind?: string;
}

/** A single error declared by the FEATURE's spec. */
export interface SpecedContractError {
  type: string;
  description?: string;
  statusCode?: number;
}

/** Source of the speced contract — which library/file/spec it came from. */
export type SpecedContractSource =
  | 'commander'
  | 'mcp-inputSchema'
  | 'vscode-contributes'
  | 'function-signature'
  | 'http-route';

export interface SpecedContractData {
  source: SpecedContractSource;
  /** Top-level identifier parsed from the spec (e.g., 'build' from 'build <input>'). Optional. */
  name?: string;
  /** One-line human description of the FEATURE. Optional. */
  description?: string;
  inputs: SpecedContractInput[];
  outputs: SpecedContractOutput[];
  errors: SpecedContractError[];
}

/**
 * A per-category extractor implements this. Returns null if the FEATURE
 * doesn't have a recoverable spec contract (extractor can't find the
 * source-of-truth).
 */
export interface SpecedContractExtractor {
  /** Which FEATURE node type this extractor handles. */
  category: string;
  /** Source label put on the resulting SpecedContract. */
  source: SpecedContractSource;
  /** Extract the speced contract for one FEATURE. Return null to skip. */
  extract(client: RFDBClient, feature: WireNode): Promise<SpecedContractData | null>;
}

export interface SpecedContractEnrichResult {
  contractsCreated: number;
  inputsTotal: number;
  outputsTotal: number;
  errorsTotal: number;
  /** Diagnostic: FEATURE category had no registered extractor. */
  featuresWithoutExtractor: number;
  /** Diagnostic: extractor returned null (couldn't recover spec). */
  featuresWithoutSpec: number;
  /** Per-category breakdown of contractsCreated. */
  byCategory: Record<string, number>;
}

/**
 * FEATURE-class node types for which speced contracts are extracted.
 * Each category is dispatched to the extractor registered with the matching
 * `category` field.
 */
const FEATURE_TYPES: readonly string[] = [
  'cli:command',
  'mcp:tool',
  'vscode:command',
  'package:export',
  'http:route',
];

const ADD_BATCH_SIZE = 500;

/**
 * Run all registered extractors over the graph.
 *
 * Idempotent: SPECED_CONTRACT id is `${feature.id}::specedContract`,
 * re-running overwrites. The matching HAS_SPECED_CONTRACT edge has the same
 * (src, dst, edgeType) tuple, which RFDB also dedupes.
 *
 * Uses direct addNodes/addEdges (per skill `rfdb-batchhandle-deletes-existing-nodes`),
 * NOT BatchHandle.commit().
 */
export async function enrichSpecedContracts(
  client: RFDBClient,
  extractors: SpecedContractExtractor[],
): Promise<SpecedContractEnrichResult> {
  const result: SpecedContractEnrichResult = {
    contractsCreated: 0,
    inputsTotal: 0,
    outputsTotal: 0,
    errorsTotal: 0,
    featuresWithoutExtractor: 0,
    featuresWithoutSpec: 0,
    byCategory: {},
  };

  // Build a lookup for O(1) category dispatch. If two extractors register the
  // same category, the first one wins — caller is responsible for ordering.
  const extractorByCategory = new Map<string, SpecedContractExtractor>();
  for (const ex of extractors) {
    if (!extractorByCategory.has(ex.category)) {
      extractorByCategory.set(ex.category, ex);
    }
  }

  const newNodes: WireNode[] = [];
  const newEdges: WireEdge[] = [];
  const seenContractIds = new Set<string>();

  for (const featureType of FEATURE_TYPES) {
    // Materialize the FEATURE list before per-feature traversal: the
    // queryNodes generator reuses the same client connection that
    // extractor calls also need.
    const features: WireNode[] = [];
    for await (const feature of client.queryNodes({ type: featureType })) {
      features.push(feature);
    }

    const extractor = extractorByCategory.get(featureType);

    for (const feature of features) {
      const contractId = `${feature.id}::specedContract`;
      if (seenContractIds.has(contractId)) continue;
      seenContractIds.add(contractId);

      if (!extractor) {
        result.featuresWithoutExtractor++;
        continue;
      }

      const data = await extractor.extract(client, feature);
      if (data === null) {
        result.featuresWithoutSpec++;
        continue;
      }

      newNodes.push({
        id: contractId,
        nodeType: 'SPECED_CONTRACT' as never,
        name: feature.name,
        file: feature.file,
        exported: false,
        metadata: JSON.stringify(data),
      });
      newEdges.push({
        src: feature.id,
        dst: contractId,
        edgeType: 'HAS_SPECED_CONTRACT' as never,
        metadata: JSON.stringify({ source: data.source }),
      });

      result.contractsCreated++;
      result.inputsTotal += data.inputs.length;
      result.outputsTotal += data.outputs.length;
      result.errorsTotal += data.errors.length;
      result.byCategory[featureType] = (result.byCategory[featureType] ?? 0) + 1;

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

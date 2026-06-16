/**
 * Pure (stateless) codec + helper functions for the RFDB server backend.
 *
 * Extracted from RFDBServerBackend.ts (REG-490): wire conversion, input
 * validation, record parsing, socket-path resolution, PID polling and Datalog
 * binding normalization. These are deliberately free of `this`/connection
 * state so they can be unit-tested in isolation and shared by the connection,
 * data and query layers without coupling.
 *
 * Behaviour is byte-for-byte identical to the original inline implementations.
 */

import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'timers/promises';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

import type { WireNode, WireEdge, EdgeRecord, BaseNodeRecord, AnyBrandedNode } from '@grafema/types';
import type { NodeType, EdgeType } from '@grafema/types';
import { brandNodeInternal } from '../../core/brandNodeInternal.js';
import type { RFDBServerBackendOptions, InputNode, InputEdge } from './rfdbTypes.js';

/**
 * Resolve the Unix socket path for a backend from its options.
 *
 * Default: next to the database in the .grafema folder, so each project gets
 * its own socket and concurrent MCP instances don't collide. Unix socket paths
 * have a hard length limit (SUN_LEN: 104 on macOS, 108 on Linux); if the
 * project path is too deep we fall back to /tmp with a hash of the dir.
 */
export function resolveSocketPath(options: RFDBServerBackendOptions): string {
  if (options.socketPath) {
    return options.socketPath;
  }
  if (options.dbPath) {
    const localSocket = join(dirname(options.dbPath), 'rfdb.sock');
    const SUN_LEN = process.platform === 'darwin' ? 104 : 108;
    if (Buffer.byteLength(localSocket) < SUN_LEN) {
      return localSocket;
    }
    // Hash the project path to create a unique but short socket path
    const hash = createHash('md5').update(dirname(options.dbPath)).digest('hex').slice(0, 12);
    return join('/tmp', `grafema-${hash}.sock`);
  }
  return '/tmp/rfdb.sock'; // fallback, not recommended
}

/**
 * Poll until the process identified by pidPath has exited, or timeoutMs elapses.
 */
export async function waitForPidExit(pidPath: string, timeoutMs: number): Promise<void> {
  let pid: number;
  try {
    if (!existsSync(pidPath)) return;
    pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (isNaN(pid) || pid <= 0) return;
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // signal 0 = check if alive
    } catch {
      return; // ESRCH — process gone
    }
    await sleep(100);
  }
}

/**
 * Validate that every input node carries a required `id` and a type field.
 * Throws with an index-pinpointed message on the first offender.
 */
export function validateInputNodes(nodes: InputNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n.id) {
      throw new Error(
        `addNodes: node at index ${i} is missing required 'id' field. ` +
        `Got keys: [${Object.keys(n).join(', ')}]`
      );
    }
    if (!n.type && !n.nodeType && !n.node_type) {
      throw new Error(
        `addNodes: node '${n.id}' is missing type. ` +
        `Provide one of: type, nodeType, or node_type`
      );
    }
  }
}

/**
 * Convert a flexible InputNode into wire format.
 * v3 stores the original id as `semanticId`; v2 stashes it under metadata.originalId.
 */
export function toWireNode(node: InputNode, useV3: boolean): WireNode {
  const { id, type, nodeType, node_type, name, file, exported, ...rest } = node;
  const wire: WireNode = {
    id: String(id),
    nodeType: (nodeType || node_type || type || 'UNKNOWN') as NodeType,
    name: name || '',
    file: file || '',
    exported: exported || false,
    metadata: useV3
      ? JSON.stringify(rest)
      : JSON.stringify({ originalId: String(id), ...rest }),
  };
  if (useV3) {
    wire.semanticId = String(id);
  }
  return wire;
}

/** Map a batch of input nodes to wire format. */
export function toWireNodes(nodes: InputNode[], useV3: boolean): WireNode[] {
  return nodes.map(n => toWireNode(n, useV3));
}

/**
 * Validate that every input edge carries `src`, `dst` and an edge type.
 * Mirrors the common `source`/`target` mistake hints from the original.
 */
export function validateInputEdges(edges: InputEdge[]): void {
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    // Check for src/dst (required)
    if (!e.src) {
      // Common mistake: using 'source'/'target' instead of 'src'/'dst'
      const hint = (e as Record<string, unknown>).source
        ? ` Did you mean 'src'? Found 'source' = '${(e as Record<string, unknown>).source}'`
        : '';
      throw new Error(
        `addEdges: edge at index ${i} is missing required 'src' field.${hint} ` +
        `Got keys: [${Object.keys(e).join(', ')}]`
      );
    }
    if (!e.dst) {
      const hint = (e as Record<string, unknown>).target
        ? ` Did you mean 'dst'? Found 'target' = '${(e as Record<string, unknown>).target}'`
        : '';
      throw new Error(
        `addEdges: edge at index ${i} is missing required 'dst' field.${hint} ` +
        `Got keys: [${Object.keys(e).join(', ')}]`
      );
    }
    // Check for edge type
    if (!e.edgeType && !e.edge_type && !(e as Record<string, unknown>).etype && !e.type) {
      throw new Error(
        `addEdges: edge ${e.src} → ${e.dst} is missing edge type. ` +
        `Provide one of: edgeType, edge_type, etype, or type`
      );
    }
  }
}

/** Resolve the effective edge-type string from a flexible input edge. */
export function edgeTypeOf(edge: InputEdge): string | undefined {
  const etype = (edge as Record<string, unknown>).etype as string | undefined;
  const edgeType = edge.edgeType || edge.edge_type || etype || edge.type;
  return typeof edgeType === 'string' ? edgeType : undefined;
}

/**
 * Convert a flexible InputEdge into wire format.
 *
 * `batch` selects batchEdge() semantics: metadata is always flattened plainly
 * (no `_origSrc`/`_origDst` even on v2). For the regular addEdges() path
 * (`batch=false`), v2 stashes original src/dst into metadata so they survive a
 * non-semantic round-trip; v3 flattens plainly.
 */
export function toWireEdge(edge: InputEdge, useV3: boolean, batch: boolean): WireEdge {
  const { src, dst, type, edgeType, edge_type, etype, metadata, ...rest } = edge as InputEdge & {
    etype?: string; metadata?: unknown;
  };
  const metaObj = (typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : {});
  const flatMetadata = (batch || useV3)
    ? { ...rest, ...metaObj }
    : { _origSrc: String(src), _origDst: String(dst), ...rest, ...metaObj };
  return {
    src: String(src),
    dst: String(dst),
    edgeType: (edgeType || edge_type || etype || type || 'UNKNOWN') as EdgeType,
    metadata: JSON.stringify(flatMetadata),
  };
}

/** Map a batch of input edges to wire format (addEdges semantics). */
export function toWireEdges(edges: InputEdge[], useV3: boolean): WireEdge[] {
  return edges.map(e => toWireEdge(e, useV3, false));
}

/**
 * Parse a node from wire format to a (re-branded) JS node.
 *
 * Prefers metadata.semanticId (original v1 format preserved by RFDB server),
 * then v3 semanticId, then the v2 originalId metadata hack, then the raw id.
 * Standard fields are excluded from the metadata spread so they cannot
 * overwrite the wire values (REG-325).
 */
export function parseWireNode(wireNode: WireNode): AnyBrandedNode {
  const metadata: Record<string, unknown> = wireNode.metadata ? JSON.parse(wireNode.metadata) : {};

  // Parse nested JSON strings
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
      try {
        metadata[key] = JSON.parse(value);
      } catch {
        // Not JSON, keep as string
      }
    }
  }

  const humanId = (metadata.semanticId as string) || wireNode.semanticId || (metadata.originalId as string) || wireNode.id;

  // Exclude standard fields from metadata to prevent overwriting wireNode values
  // REG-325: Metadata spread was overwriting name with LITERAL node data
  const {
    id: _id,
    type: _type,
    name: _name,
    file: _file,
    exported: _exported,
    nodeType: _nodeType,
    originalId: _originalId,  // Already extracted above
    semanticId: _semanticId,  // Exclude from safeMetadata (used for humanId above)
    ...safeMetadata
  } = metadata;

  const parsed = {
    id: humanId,
    type: wireNode.nodeType,
    name: wireNode.name,
    file: wireNode.file,
    exported: wireNode.exported,
    ...safeMetadata,
  };

  // Re-brand nodes coming from database
  return brandNodeInternal(parsed as unknown as BaseNodeRecord);
}

/**
 * Parse an edge from wire format to an EdgeRecord.
 * v3 resolves src/dst to semantic IDs server-side; v2 falls back to the
 * `_origSrc`/`_origDst` metadata hack.
 */
export function parseWireEdge(wireEdge: WireEdge, protocolVersion: number): EdgeRecord {
  const meta: Record<string, unknown> = wireEdge.metadata ? JSON.parse(wireEdge.metadata) : {};
  const { _origSrc, _origDst, ...rest } = meta;
  const src = protocolVersion >= 3
    ? wireEdge.src
    : (_origSrc as string) || wireEdge.src;
  const dst = protocolVersion >= 3
    ? wireEdge.dst
    : (_origDst as string) || wireEdge.dst;
  return {
    src,
    dst,
    type: wireEdge.edgeType,
    metadata: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

/**
 * Normalize Datalog/guarantee binding rows from the wire shape
 * (`{ bindings: { X: "v" } }`) to the public array shape
 * (`{ bindings: [{ name: "X", value: "v" }] }`).
 */
export function toBindingRows(
  rows: Array<{ bindings: Record<string, string> }>
): Array<{ bindings: Array<{ name: string; value: string }> }> {
  return rows.map(r => ({
    bindings: Object.entries(r.bindings).map(([name, value]) => ({ name, value })),
  }));
}

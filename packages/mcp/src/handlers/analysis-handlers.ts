/**
 * MCP Analysis Handlers
 */

import { ensureAnalyzed } from '../analysis.js';
import { getAnalysisStatus, isAnalysisRunning } from '../state.js';
import {
  textResult,
  errorResult,
} from '../utils.js';
import type {
  ToolResult,
  AnalyzeProjectArgs,
  GetSchemaArgs,
} from '../types.js';
import type { ServerStats } from '@grafema/types';

// === ANALYSIS HANDLERS ===

export async function handleAnalyzeProject(args: AnalyzeProjectArgs): Promise<ToolResult> {
  const { service, force } = args;

  // Early check: return error for force=true if analysis is already running
  // This provides immediate feedback instead of waiting or causing corruption
  if (force && isAnalysisRunning()) {
    return errorResult(
      'Cannot force re-analysis: analysis is already in progress. ' +
        'Use get_analysis_status to check current status, or wait for completion.'
    );
  }

  // Note: setIsAnalyzed(false) is now handled inside ensureAnalyzed() within the lock
  // to prevent race conditions where multiple calls could both clear the database

  try {
    await ensureAnalyzed(service || null, force || false);
    const status = getAnalysisStatus();

    return textResult(
      `Analysis complete!\n` +
        `- Services discovered: ${status.servicesDiscovered}\n` +
        `- Services analyzed: ${status.servicesAnalyzed}\n` +
        `- Total time: ${status.timings.total || 'N/A'}s`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message);
  }
}

export async function handleGetAnalysisStatus(): Promise<ToolResult> {
  const status = getAnalysisStatus();

  return textResult(
    `Analysis Status:\n` +
      `- Running: ${status.running}\n` +
      `- Phase: ${status.phase || 'N/A'}\n` +
      `- Message: ${status.message || 'N/A'}\n` +
      `- Services discovered: ${status.servicesDiscovered}\n` +
      `- Services analyzed: ${status.servicesAnalyzed}\n` +
      (status.error ? `- Error: ${status.error}\n` : '')
  );
}

export async function handleGetStats(): Promise<ToolResult> {
  const db = await ensureAnalyzed();

  const nodeCount = await db.nodeCount();
  const edgeCount = await db.edgeCount();
  const nodesByType = await db.countNodesByType();
  const edgesByType = await db.countEdgesByType();

  let shardSection = '';
  if ('getServerStats' in db && typeof (db as Record<string, unknown>).getServerStats === 'function') {
    try {
      const stats = await (db as { getServerStats(): Promise<ServerStats> }).getServerStats();
      if (stats.shardDiagnostics?.length > 0) {
        shardSection = `\nShard Diagnostics (${stats.shardDiagnostics.length} shards):\n`;
        for (const s of stats.shardDiagnostics) {
          const parts = [
            `nodes=${s.nodeCount}`,
            `edges=${s.edgeCount}`,
            `wb=${s.writeBufferNodes}/${s.writeBufferEdges}`,
            s.compacted ? `compacted (L1: ${s.l1NodeRecords}n/${s.l1EdgeRecords}e)` : `L0: ${s.l0NodeSegmentCount}n/${s.l0EdgeSegmentCount}e segs`,
          ];
          if (s.tombstoneNodeCount > 0 || s.tombstoneEdgeCount > 0) {
            parts.push(`tombstones=${s.tombstoneNodeCount}n/${s.tombstoneEdgeCount}e`);
          }
          const indexes = [s.hasL1ByType && 'type', s.hasL1ByFile && 'file', s.hasL1ByName && 'name'].filter(Boolean);
          if (indexes.length > 0) {
            parts.push(`indexes=[${indexes.join(',')}]`);
          }
          shardSection += `  shard ${s.shardId}: ${parts.join(', ')}\n`;
        }
        shardSection += `\nServer: uptime=${stats.uptimeSecs}s, queries=${stats.queryCount}, memory=${stats.memoryPercent.toFixed(1)}%`;
      }
    } catch {
      // Server may not support getStats yet — skip diagnostics
    }
  }

  const actionHint =
    nodeCount > 0
      ? `\n\nGraph is ready — use find_nodes, find_calls, trace_dataflow to query it.`
      : `\n\nGraph is empty — call analyze_project to build the graph first.`;

  return textResult(
    `Graph Statistics:\n\n` +
      `Total nodes: ${nodeCount.toLocaleString()}\n` +
      `Total edges: ${edgeCount.toLocaleString()}\n\n` +
      `Nodes by type:\n${JSON.stringify(nodesByType, null, 2)}\n\n` +
      `Edges by type:\n${JSON.stringify(edgesByType, null, 2)}` +
      shardSection +
      actionHint
  );
}

export async function handleGetSchema(args: GetSchemaArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { type = 'all' } = args;

  const nodesByType = await db.countNodesByType();
  const edgesByType = await db.countEdgesByType();

  let output = '';

  if (type === 'nodes' || type === 'all') {
    output += `Node Types (${Object.keys(nodesByType).length}):\n`;
    for (const [t, count] of Object.entries(nodesByType)) {
      output += `  - ${t}: ${count}\n`;
    }
  }

  if (type === 'edges' || type === 'all') {
    output += `\nEdge Types (${Object.keys(edgesByType).length}):\n`;
    for (const [t, count] of Object.entries(edgesByType)) {
      output += `  - ${t}: ${count}\n`;
    }
  }

  return textResult(output);
}

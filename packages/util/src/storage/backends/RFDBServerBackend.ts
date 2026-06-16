/**
 * RFDBServerBackend - Graph backend using RFDB server via Unix socket
 *
 * Replaces ReginaFlowBackend's direct NAPI binding with socket-based
 * communication to a shared RFDB server. This allows multiple processes
 * (MCP server, analysis workers) to share the same graph database.
 *
 * Socket path defaults to `{dbPath}/../rfdb.sock` (e.g., .grafema/rfdb.sock),
 * ensuring each project has its own socket and avoiding conflicts when
 * multiple MCP instances run simultaneously.
 *
 * Usage:
 *   const backend = new RFDBServerBackend({
 *     dbPath: '/project/.grafema/graph.rfdb'  // socket will be /project/.grafema/rfdb.sock
 *   });
 *   await backend.connect();
 *   await backend.addNodes([...]);
 *   await backend.flush();
 *
 * Structure (REG-490): this file is the public class plus the statistics /
 * Datalog / Cypher query layer. The connection lifecycle lives in
 * RFDBConnectionBase and node/edge data operations in RFDBDataBackend, which
 * this class extends — so the full method surface remains on RFDBServerBackend.
 */

import type {
  DatalogExplainResult, FactWitness, GapWitness,
  SimEdge, SimNode, ServerStats, CypherResult,
} from '@grafema/types';

import { RFDBDataBackend } from './RFDBDataBackend.js';
import { toBindingRows } from './rfdbCodec.js';
import type { BackendStats } from './rfdbTypes.js';

// Re-export the public types so existing deep imports keep resolving from here.
export type {
  RFDBServerBackendOptions, InputNode, InputEdge, NodeQuery, BackendStats,
} from './rfdbTypes.js';

export class RFDBServerBackend extends RFDBDataBackend {
  private _cachedNodeCounts: Record<string, number> | undefined;
  private _cachedEdgeCounts: Record<string, number> | undefined;

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get node count
   */
  async nodeCount(): Promise<number> {
    if (!this.client) throw new Error('Not connected');
    return this.client.nodeCount();
  }

  /**
   * Get edge count
   */
  async edgeCount(): Promise<number> {
    if (!this.client) throw new Error('Not connected');
    return this.client.edgeCount();
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<BackendStats> {
    if (!this.client) throw new Error('Not connected');
    const nodeCount = await this.client.nodeCount();
    const edgeCount = await this.client.edgeCount();
    const nodeCounts = await this.client.countNodesByType();
    const edgeCounts = await this.client.countEdgesByType();

    return {
      nodeCount,
      edgeCount,
      nodesByType: nodeCounts,
      edgesByType: edgeCounts,
    };
  }

  /**
   * Get full server stats including shard diagnostics.
   * Uses the GetStats wire command which returns all metrics in one call.
   */
  async getServerStats(): Promise<ServerStats> {
    if (!this.client) throw new Error('Not connected');
    return this.client.getStats();
  }

  /**
   * Count nodes by type (sync, returns cached value)
   */
  async countNodesByType(_types: string[] | null = null): Promise<Record<string, number>> {
    if (!this.client) throw new Error('Not connected');
    return this.client.countNodesByType();
  }

  /**
   * Count edges by type
   */
  async countEdgesByType(_edgeTypes: string[] | null = null): Promise<Record<string, number>> {
    if (!this.client) throw new Error('Not connected');
    return this.client.countEdgesByType();
  }

  /**
   * Refresh cached counts (call after analysis)
   */
  async refreshCounts(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    this._cachedNodeCounts = await this.client.countNodesByType();
    this._cachedEdgeCounts = await this.client.countEdgesByType();
  }

  // ===========================================================================
  // Datalog Queries
  // ===========================================================================

  /**
   * Check a guarantee (Datalog rule) and return violations.
   * @param explain Pass literal `true` to get explain data.
   */
  async checkGuarantee(ruleSource: string): Promise<Array<{ bindings: Array<{ name: string; value: string }> }>>;
  async checkGuarantee(ruleSource: string, explain: true): Promise<DatalogExplainResult>;
  async checkGuarantee(ruleSource: string, explain?: boolean): Promise<Array<{ bindings: Array<{ name: string; value: string }> }> | DatalogExplainResult> {
    if (!this.client) throw new Error('Not connected');
    if (explain) {
      return await this.client.checkGuarantee(ruleSource, true);
    }
    const violations = await this.client.checkGuarantee(ruleSource);
    // Convert bindings from {X: "value"} to [{name: "X", value: "value"}]
    return toBindingRows(violations);
  }

  /**
   * Load Datalog rules
   */
  async datalogLoadRules(source: string): Promise<number> {
    if (!this.client) throw new Error('Not connected');
    return await this.client.datalogLoadRules(source);
  }

  /**
   * Clear Datalog rules
   */
  async datalogClearRules(): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.datalogClearRules();
  }

  /**
   * Run a Datalog query.
   * @param explain Pass literal `true` to get explain data.
   */
  async datalogQuery(query: string): Promise<Array<{ bindings: Array<{ name: string; value: string }> }>>;
  async datalogQuery(query: string, explain: true): Promise<DatalogExplainResult>;
  async datalogQuery(query: string, explain?: boolean): Promise<Array<{ bindings: Array<{ name: string; value: string }> }> | DatalogExplainResult> {
    if (!this.client) throw new Error('Not connected');
    if (explain) {
      return await this.client.datalogQuery(query, true);
    }
    const results = await this.client.datalogQuery(query);
    // Convert bindings from {X: "value"} to [{name: "X", value: "value"}]
    return toBindingRows(results);
  }

  /**
   * Execute unified Datalog query or program.
   * Auto-detects whether input is rules or direct query.
   * @param explain Pass literal `true` to get explain data.
   */
  async executeDatalog(source: string): Promise<Array<{ bindings: Array<{ name: string; value: string }> }>>;
  async executeDatalog(source: string, explain: true): Promise<DatalogExplainResult>;
  async executeDatalog(source: string, explain?: boolean): Promise<Array<{ bindings: Array<{ name: string; value: string }> }> | DatalogExplainResult> {
    if (!this.client) throw new Error('Not connected');
    if (explain) {
      return await this.client.executeDatalog(source, true);
    }
    const results = await this.client.executeDatalog(source);
    return toBindingRows(results);
  }

  /**
   * why()/explain_fact: explain ONE supporting derivation of `predicate(key)` under a v2 program
   * (empty `source` ⇒ the bundled depends.dl). Resolves to `null` when the fact is not derivable.
   * derive-engine-only — rejects when RFDB_DERIVE_ENGINE is off.
   */
  async explainDatalogFact(source: string, predicate: string, key: string[]): Promise<FactWitness | null> {
    if (!this.client) throw new Error('Not connected');
    return await this.client.explainDatalogFact(source, predicate, key);
  }

  /**
   * what-if/sim: predict the NEW `predicate` facts a hypothetical overlay of nodes+edges would
   * create under a v2 program (empty `source` ⇒ the bundled depends.dl), WITHOUT committing.
   * Resolves to the predicted-new ground tuples (sim ∖ base). v2-only.
   */
  async simDatalog(source: string, predicate: string, nodes: SimNode[], edges: SimEdge[]): Promise<string[][]> {
    if (!this.client) throw new Error('Not connected');
    return await this.client.simDatalog(source, predicate, nodes, edges);
  }

  /**
   * why-not/explain_gap: explain why `predicate(key)` is NOT derived — the satisfied premise
   * prefix + the first unsatisfiable premise. Resolves to `null` when there is no gap. v2-only.
   */
  async explainDatalogGap(source: string, predicate: string, key: string[]): Promise<GapWitness | null> {
    if (!this.client) throw new Error('Not connected');
    return await this.client.explainDatalogGap(source, predicate, key);
  }

  /**
   * Run a Cypher query.
   */
  async cypherQuery(query: string): Promise<CypherResult> {
    if (!this.client) throw new Error('Not connected');
    return await this.client.cypherQuery(query);
  }

  // ===========================================================================
  // Graph property (for compatibility)
  // ===========================================================================

  get graph(): this {
    return this;
  }
}

export default RFDBServerBackend;

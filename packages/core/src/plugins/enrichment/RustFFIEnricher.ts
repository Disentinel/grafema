/**
 * RustFFIEnricher - links JavaScript CALL nodes to Rust NAPI functions
 * Creates FFI_CALLS edges between JS calls and their Rust implementations
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

/**
 * Rust NAPI function/method node
 */
interface RustNapiNode extends BaseNodeRecord {
  napi?: boolean;
  napiJsName?: string;
  implType?: string;
}

/**
 * JavaScript call node
 */
interface JSCallNode extends BaseNodeRecord {
  object?: string;
  method?: string;
}

export class RustFFIEnricher extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'RustFFIEnricher',
      phase: 'ENRICHMENT',
      priority: 45,  // After MethodCallResolver (50)
      creates: {
        nodes: [],
        edges: ['FFI_CALLS']
      },
      dependencies: ['RustAnalyzer', 'MethodCallResolver']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;

    // 1. Build index of NAPI-exported Rust functions/methods
    const napiIndex = await this.buildNapiIndex(graph);

    if (napiIndex.size === 0) {
      console.log('[RustFFIEnricher] No NAPI exports found, skipping');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true, reason: 'No NAPI exports' });
    }

    console.log(`[RustFFIEnricher] Indexed ${napiIndex.size} NAPI exports`);

    // 2. Find JS CALL nodes that target Rust
    const jsCalls = await this.findRustCallingJsCalls(graph);
    console.log(`[RustFFIEnricher] Found ${jsCalls.length} candidate JS calls`);

    // 3. Match and create FFI_CALLS edges
    let edgesCreated = 0;
    const unmatched: string[] = [];

    for (const call of jsCalls) {
      const rustTarget = this.matchJsCallToRust(call, napiIndex);

      if (rustTarget) {
        await graph.addEdge({
          src: call.id,
          dst: rustTarget.id,
          type: 'FFI_CALLS'
        });
        edgesCreated++;
      } else {
        const callName = `${call.object || ''}.${call.method || call.name}`;
        if (callName && !unmatched.includes(callName)) {
          unmatched.push(callName);
        }
      }
    }

    if (unmatched.length > 0 && unmatched.length <= 20) {
      console.log(`[RustFFIEnricher] Unmatched calls:`, unmatched.slice(0, 10));
    }

    console.log(`[RustFFIEnricher] Created ${edgesCreated} FFI_CALLS edges`);
    return createSuccessResult({ nodes: 0, edges: edgesCreated }, { unmatched: unmatched.length });
  }

  private async buildNapiIndex(graph: PluginContext['graph']): Promise<Map<string, RustNapiNode>> {
    const index = new Map<string, RustNapiNode>();

    // Index RUST_FUNCTION with napi=true
    for await (const node of graph.queryNodes({ nodeType: 'RUST_FUNCTION' })) {
      const rustNode = node as RustNapiNode;
      if (rustNode.napi) {
        const jsName = rustNode.napiJsName || this.rustNameToJs(rustNode.name as string);
        index.set(jsName, rustNode);
        // Also store with Rust name for direct matches
        index.set(rustNode.name as string, rustNode);
      }
    }

    // Index RUST_METHOD with napi=true
    for await (const node of graph.queryNodes({ nodeType: 'RUST_METHOD' })) {
      const rustNode = node as RustNapiNode;
      if (rustNode.napi) {
        const jsName = rustNode.napiJsName || this.rustNameToJs(rustNode.name as string);
        // Methods are called as object.method() in JS
        // Use implType to determine the class name
        if (rustNode.implType) {
          // GraphEngine.addNodes -> maps to GraphEngine::add_nodes
          index.set(`${rustNode.implType}.${jsName}`, rustNode);
          // Also store just method name for loose matching
          index.set(jsName, rustNode);
        }
      }
    }

    return index;
  }

  private async findRustCallingJsCalls(graph: PluginContext['graph']): Promise<JSCallNode[]> {
    const candidates: JSCallNode[] = [];
    const seen = new Set<string>();

    for await (const call of graph.queryNodes({ nodeType: 'CALL' })) {
      const callNode = call as JSCallNode;

      // Skip duplicates
      if (seen.has(callNode.id)) continue;
      seen.add(callNode.id);

      // Look for calls on objects that are likely Rust bindings:
      // - engine.addNodes(), graph.bfs()
      // - Direct function calls: computeNodeIdJs()
      // - Method calls on GraphEngine instances

      if (callNode.object === 'engine' ||
          callNode.object === 'graph' ||
          callNode.object === 'this.engine' ||
          callNode.object === 'this.graph' ||
          callNode.object === 'nativeBinding' ||
          (callNode.name && (callNode.name as string).startsWith('compute'))) {
        candidates.push(callNode);
        continue;
      }

      // Check if method name matches known NAPI pattern
      if (callNode.method) {
        const snakeName = this.jsNameToRust(callNode.method);
        // Common NAPI patterns: add_*, get_*, set_*, query_*, etc.
        if (snakeName && /^(add|get|set|query|compute|find|run|create|delete|update|list|check|flush|load|save|bfs|dfs)_/.test(snakeName)) {
          candidates.push(callNode);
        }
      }
    }

    return candidates;
  }

  private matchJsCallToRust(call: JSCallNode, napiIndex: Map<string, RustNapiNode>): RustNapiNode | null {
    // Try multiple matching strategies

    // 1. Direct method match: object.method -> Class.method
    if (call.method) {
      // Try exact match with class name (GraphEngine.method)
      for (const [key, node] of napiIndex) {
        if (key.endsWith(`.${call.method}`)) {
          return node;
        }
      }

      // Try just method name
      if (napiIndex.has(call.method)) {
        return napiIndex.get(call.method)!;
      }

      // Try snake_case version
      const snakeName = this.jsNameToRust(call.method);
      if (snakeName && napiIndex.has(snakeName)) {
        return napiIndex.get(snakeName)!;
      }
    }

    // 2. Direct function call match
    if (call.name) {
      const callName = call.name as string;
      if (napiIndex.has(callName)) {
        return napiIndex.get(callName)!;
      }

      // Try snake_case version
      const snakeName = this.jsNameToRust(callName);
      if (snakeName && napiIndex.has(snakeName)) {
        return napiIndex.get(snakeName)!;
      }
    }

    return null;
  }

  /**
   * Convert Rust snake_case to JavaScript camelCase
   * add_nodes -> addNodes
   * compute_node_id_js -> computeNodeIdJs
   */
  private rustNameToJs(rustName: string): string {
    return rustName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }

  /**
   * Convert JavaScript camelCase to Rust snake_case
   * addNodes -> add_nodes
   */
  private jsNameToRust(jsName: string): string | null {
    if (!jsName) return null;
    return jsName.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
  }
}

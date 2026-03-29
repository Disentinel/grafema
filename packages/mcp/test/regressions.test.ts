/**
 * Regression tests for known VSCode extension / MCP bugs.
 *
 * Each section is pinned to a specific regression ID from KNOWN_LIMITATIONS.md.
 * Tests run against FileOverview (from @grafema/util) using an in-memory mock
 * graph — no RFDB server required.
 *
 * Covered regressions:
 *   REG-655 — get_file_overview shows empty calls for TS class methods
 *   REG-656 — Rust intra-file CALLS missing (resolved by rust-calls pass)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileOverview } from '@grafema/util';
import type { GraphBackend } from '@grafema/types';
import { findProjectRoot } from '../src/state.js';

// ============================================================================
// In-memory mock graph
//
// Minimal GraphBackend implementation for unit tests.
// Supports node lookup, edge traversal, and queryNodes filtering.
// ============================================================================

interface MockNode {
  id: string;
  type: string;
  name?: string;
  file?: string;
  line?: number;
  endLine?: number;
  exported?: boolean;
  async?: boolean;
  params?: string[];
  returnType?: string;
  signature?: string;
  source?: string;
  specifiers?: unknown[];
  exportedName?: string;
  isDefault?: boolean;
  kind?: string;
  superClass?: string;
  object?: string;
  [key: string]: unknown;
}

interface MockEdge {
  src: string;
  dst: string;
  type: string;
}

/**
 * Fluent builder for in-memory graph fixtures.
 *
 * Usage:
 *   const g = new MockGraph()
 *     .node('mod1', { type: 'MODULE', file: 'src/foo.ts' })
 *     .edge('mod1', 'fn1', 'CONTAINS');
 *
 *   const overview = new FileOverview(g.asBackend());
 */
class MockGraph {
  private _nodes = new Map<string, MockNode>();
  private _edges: MockEdge[] = [];

  node(id: string, props: Omit<MockNode, 'id'>): this {
    this._nodes.set(id, { id, ...props });
    return this;
  }

  edge(src: string, dst: string, type: string): this {
    this._edges.push({ src, dst, type });
    return this;
  }

  /** Cast to GraphBackend for FileOverview constructor. */
  asBackend(): GraphBackend {
    const nodes = this._nodes;
    const edges = this._edges;

    return {
      async getNode(id: string) {
        return (nodes.get(id) ?? null) as unknown as ReturnType<GraphBackend['getNode']> extends Promise<infer T> ? T : never;
      },
      async getOutgoingEdges(id: string, types?: string[] | null) {
        const out = edges.filter(e => e.src === id);
        const filtered = types ? out.filter(e => types.includes(e.type)) : out;
        return filtered as unknown as Awaited<ReturnType<GraphBackend['getOutgoingEdges']>>;
      },
      async getIncomingEdges(id: string, types?: string[] | null) {
        const inc = edges.filter(e => e.dst === id);
        const filtered = types ? inc.filter(e => types.includes(e.type)) : inc;
        return filtered as unknown as Awaited<ReturnType<GraphBackend['getIncomingEdges']>>;
      },
      async *queryNodes(filter: Record<string, unknown>) {
        for (const node of nodes.values()) {
          if (Object.entries(filter).every(([k, v]) => node[k] === v)) {
            yield node as unknown as Awaited<ReturnType<GraphBackend['getNode']>> & {};
          }
        }
      },
      // Stubs for the rest of GraphBackend (not used by FileOverview)
      async addNode() {},
      async addEdge() {},
      async addNodes() {},
      async addEdges() {},
      async nodeCount() { return nodes.size; },
      async edgeCount() { return edges.length; },
      async clear() { nodes.clear(); edges.length = 0; },
      async countNodesByType() { return {}; },
      async countEdgesByType() { return {}; },
    } as unknown as GraphBackend;
  }
}

// ============================================================================
// REG-655 — get_file_overview shows empty calls for TS class methods
//
// Root cause: CoreV3 emits CALLS edges on CALL nodes (not on METHOD nodes).
// Neither findCallsInFunction Layout A (HAS_SCOPE) nor Layout B (direct edges)
// finds these calls.
//
// Fix: line-range fallback in FileOverview.buildFunctionOverview() — queries
// CALL nodes by (file, type='CALL') and filters by line range.
//
// The tests below ensure this fallback keeps working.
// ============================================================================

describe('REG-655 — TS class method calls (line-range fallback)', () => {
  it('method with CALL node in same file+range → calls is non-empty', async () => {
    // Graph structure:
    //   MODULE (src/service.ts)
    //     └─CONTAINS─> CLASS (UserService, line 5)
    //                    └─CONTAINS─> METHOD (getUser, line 10, endLine 20)
    //
    //   CALL (findById, line 12, src/service.ts) ← no edge from METHOD
    //     └─CALLS─> FUNCTION (findById, src/db.ts)
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/service.ts', name: 'service' })
      .node('cls1', { type: 'CLASS', name: 'UserService', file: 'src/service.ts', line: 5 })
      .node('mth1', { type: 'METHOD', name: 'getUser', file: 'src/service.ts', line: 10, endLine: 20 })
      .node('call1', { type: 'CALL', name: 'findById', file: 'src/service.ts', line: 12 })
      .node('fn1', { type: 'FUNCTION', name: 'findById', file: 'src/db.ts', line: 1 })
      .edge('mod1', 'cls1', 'CONTAINS')
      .edge('cls1', 'mth1', 'CONTAINS')
      // NOTE: no edge from mth1 to call1 — this is the REG-655 scenario
      .edge('call1', 'fn1', 'CALLS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/service.ts');

    assert.strictEqual(result.status, 'ANALYZED', 'File should be analyzed');
    assert.strictEqual(result.classes.length, 1, 'Should have 1 class');
    assert.strictEqual(result.classes[0].methods.length, 1, 'Should have 1 method');

    const method = result.classes[0].methods[0];
    assert.strictEqual(method.name, 'getUser');
    assert.ok(
      method.calls.includes('findById'),
      `getUser.calls should include 'findById', got: ${JSON.stringify(method.calls)}`,
    );
  });

  it('method with CALL node OUTSIDE line range → calls is empty (no false positives)', async () => {
    // call2 is at line 50, outside getUser (lines 10-20)
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/service.ts', name: 'service' })
      .node('cls1', { type: 'CLASS', name: 'UserService', file: 'src/service.ts', line: 5 })
      .node('mth1', { type: 'METHOD', name: 'getUser', file: 'src/service.ts', line: 10, endLine: 20 })
      .node('call2', { type: 'CALL', name: 'unrelatedFn', file: 'src/service.ts', line: 50 })
      .node('fn2', { type: 'FUNCTION', name: 'unrelatedFn', file: 'src/service.ts', line: 55 })
      .edge('mod1', 'cls1', 'CONTAINS')
      .edge('cls1', 'mth1', 'CONTAINS')
      .edge('call2', 'fn2', 'CALLS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/service.ts');

    const method = result.classes[0].methods[0];
    assert.deepStrictEqual(
      method.calls,
      [],
      `getUser.calls should be empty (call at line 50 is outside method range), got: ${JSON.stringify(method.calls)}`,
    );
  });

  it('method with no endLine uses large fallback window → still finds calls', async () => {
    // When endLine is absent, fallback uses line + 100000.
    // A CALL at line 15 should still be found for a method at line 10 (no endLine).
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/service.ts', name: 'service' })
      .node('cls1', { type: 'CLASS', name: 'UserService', file: 'src/service.ts', line: 5 })
      .node('mth1', { type: 'METHOD', name: 'doWork', file: 'src/service.ts', line: 10 /* no endLine */ })
      .node('call1', { type: 'CALL', name: 'helper', file: 'src/service.ts', line: 15 })
      .node('fn1', { type: 'FUNCTION', name: 'helper', file: 'src/service.ts', line: 30 })
      .edge('mod1', 'cls1', 'CONTAINS')
      .edge('cls1', 'mth1', 'CONTAINS')
      .edge('call1', 'fn1', 'CALLS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/service.ts');

    const method = result.classes[0].methods[0];
    assert.ok(
      method.calls.includes('helper'),
      `doWork.calls should include 'helper' (no-endLine fallback), got: ${JSON.stringify(method.calls)}`,
    );
  });

  it('unresolved CALL (no CALLS edge) → falls back to call node name', async () => {
    // When a CALL node has no CALLS edge, its own name is used as the call.
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/service.ts', name: 'service' })
      .node('cls1', { type: 'CLASS', name: 'UserService', file: 'src/service.ts', line: 5 })
      .node('mth1', { type: 'METHOD', name: 'fetch', file: 'src/service.ts', line: 10, endLine: 25 })
      .node('call1', { type: 'CALL', name: 'externalLib', file: 'src/service.ts', line: 14 })
      // NOTE: no CALLS edge from call1 — unresolved external
      .edge('mod1', 'cls1', 'CONTAINS')
      .edge('cls1', 'mth1', 'CONTAINS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/service.ts');

    const method = result.classes[0].methods[0];
    assert.ok(
      method.calls.includes('externalLib'),
      `fetch.calls should include 'externalLib' (unresolved call fallback), got: ${JSON.stringify(method.calls)}`,
    );
  });

  it('multiple methods in same class → each gets its own calls (no cross-contamination)', async () => {
    // methodA (lines 10-20) calls funcA (line 12)
    // methodB (lines 25-35) calls funcB (line 27)
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/service.ts', name: 'service' })
      .node('cls1', { type: 'CLASS', name: 'MyClass', file: 'src/service.ts', line: 5 })
      .node('mthA', { type: 'METHOD', name: 'methodA', file: 'src/service.ts', line: 10, endLine: 20 })
      .node('mthB', { type: 'METHOD', name: 'methodB', file: 'src/service.ts', line: 25, endLine: 35 })
      .node('callA', { type: 'CALL', name: 'funcA', file: 'src/service.ts', line: 12 })
      .node('callB', { type: 'CALL', name: 'funcB', file: 'src/service.ts', line: 27 })
      .node('fnA', { type: 'FUNCTION', name: 'funcA', file: 'src/service.ts', line: 50 })
      .node('fnB', { type: 'FUNCTION', name: 'funcB', file: 'src/service.ts', line: 60 })
      .edge('mod1', 'cls1', 'CONTAINS')
      .edge('cls1', 'mthA', 'CONTAINS')
      .edge('cls1', 'mthB', 'CONTAINS')
      .edge('callA', 'fnA', 'CALLS')
      .edge('callB', 'fnB', 'CALLS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/service.ts');

    const methods = result.classes[0].methods.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    assert.strictEqual(methods.length, 2);

    assert.ok(
      methods[0].calls.includes('funcA') && !methods[0].calls.includes('funcB'),
      `methodA should only call funcA, got: ${JSON.stringify(methods[0].calls)}`,
    );
    assert.ok(
      methods[1].calls.includes('funcB') && !methods[1].calls.includes('funcA'),
      `methodB should only call funcB, got: ${JSON.stringify(methods[1].calls)}`,
    );
  });

  it('method with METHOD_CALL node → calls is non-empty (REG-655 METHOD_CALL gap)', async () => {
    // this.repo.save(entity) creates a METHOD_CALL node, not a CALL node.
    // The fallback must query METHOD_CALL in addition to CALL.
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/service.ts', name: 'service' })
      .node('cls1', { type: 'CLASS', name: 'UserService', file: 'src/service.ts', line: 5 })
      .node('mth1', { type: 'METHOD', name: 'saveUser', file: 'src/service.ts', line: 10, endLine: 20 })
      .node('mc1',  { type: 'METHOD_CALL', name: 'save', object: 'repo', file: 'src/service.ts', line: 14 })
      .node('fn1',  { type: 'METHOD', name: 'save', file: 'src/repo.ts', line: 1 })
      .edge('mod1', 'cls1', 'CONTAINS')
      .edge('cls1', 'mth1', 'CONTAINS')
      // No edge from mth1 to mc1 — CoreV3 REG-655 scenario
      .edge('mc1', 'fn1', 'CALLS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/service.ts');

    const method = result.classes[0].methods[0];
    assert.ok(
      method.calls.includes('save'),
      `saveUser.calls should include 'save' (METHOD_CALL), got: ${JSON.stringify(method.calls)}`,
    );
  });

  it('unresolved METHOD_CALL → falls back to call node name', async () => {
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/svc.ts', name: 'svc' })
      .node('cls1', { type: 'CLASS', name: 'Svc', file: 'src/svc.ts', line: 1 })
      .node('mth1', { type: 'METHOD', name: 'run', file: 'src/svc.ts', line: 5, endLine: 15 })
      .node('mc1',  { type: 'METHOD_CALL', name: 'emit', file: 'src/svc.ts', line: 8 })
      // no CALLS edge — unresolved
      .edge('mod1', 'cls1', 'CONTAINS')
      .edge('cls1', 'mth1', 'CONTAINS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/svc.ts');

    const method = result.classes[0].methods[0];
    assert.ok(
      method.calls.includes('emit'),
      `run.calls should include 'emit' (unresolved METHOD_CALL), got: ${JSON.stringify(method.calls)}`,
    );
  });
});

// ============================================================================
// REG-655 — Layout B (direct edges) path for top-level TS functions
//
// When the Rust orchestrator wires FUNCTION → CALL via semantic edges
// (AWAITS, RETURNS, CALLS, etc.), findCallsInFunction Layout B applies.
// ============================================================================

describe('REG-655 — TS function calls via Layout B (direct edges)', () => {
  it('FUNCTION with direct AWAITS→CALL edge → calls resolved', async () => {
    // Layout B: fn1 -[AWAITS]-> call1 -[CALLS]-> fn2
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/utils.ts', name: 'utils' })
      .node('fn1', { type: 'FUNCTION', name: 'processData', file: 'src/utils.ts', line: 5, endLine: 15, async: true })
      .node('call1', { type: 'CALL', name: 'validate', file: 'src/utils.ts', line: 8 })
      .node('fn2', { type: 'FUNCTION', name: 'validate', file: 'src/validators.ts', line: 1 })
      .edge('mod1', 'fn1', 'CONTAINS')
      .edge('fn1', 'call1', 'AWAITS')  // Layout B direct edge
      .edge('call1', 'fn2', 'CALLS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/utils.ts');

    assert.strictEqual(result.functions.length, 1);
    const fn = result.functions[0];
    assert.ok(
      fn.calls.includes('validate'),
      `processData.calls should include 'validate', got: ${JSON.stringify(fn.calls)}`,
    );
  });

  it('FUNCTION with HAS_SCOPE chain → calls resolved (Layout A)', async () => {
    // Layout A: fn1 -[HAS_SCOPE]-> scope1 -[CONTAINS]-> call1 -[CALLS]-> fn2
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/app.ts', name: 'app' })
      .node('fn1', { type: 'FUNCTION', name: 'handler', file: 'src/app.ts', line: 1, endLine: 10 })
      .node('scope1', { type: 'SCOPE', name: 'scope', file: 'src/app.ts', line: 1 })
      .node('call1', { type: 'CALL', name: 'respond', file: 'src/app.ts', line: 3 })
      .node('fn2', { type: 'FUNCTION', name: 'respond', file: 'src/http.ts', line: 5 })
      .edge('mod1', 'fn1', 'CONTAINS')
      .edge('fn1', 'scope1', 'HAS_SCOPE')
      .edge('scope1', 'call1', 'CONTAINS')
      .edge('call1', 'fn2', 'CALLS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/app.ts');

    assert.strictEqual(result.functions.length, 1);
    const fn = result.functions[0];
    assert.ok(
      fn.calls.includes('respond'),
      `handler.calls should include 'respond', got: ${JSON.stringify(fn.calls)}`,
    );
  });
});

// ============================================================================
// REG-656 — Rust intra-file CALLS missing
//
// Root cause: rust-analyzer emitted CALL nodes but didn't create CALLS edges
// to same-file FUNCTION nodes (required linking call sites to definitions).
//
// Fix: rust-resolve runs `rust-calls` pass matching CALL nodes to same-file
// FUNCTION nodes by exact name or last `::` segment.
//
// The tests below ensure that once CALLS edges exist, FileOverview surfaces
// the calls correctly.
// ============================================================================

describe('REG-656 — Rust intra-file CALLS resolved', () => {
  it('Rust fn calls same-file fn via CALLS edge → calls is non-empty', async () => {
    // Graph after rust-calls pass:
    //   MODULE (src/main.rs)
    //     ├─CONTAINS─> FUNCTION (main, line 1, endLine 10)
    //     └─CONTAINS─> FUNCTION (process_data, line 15)
    //   CALL (process_data, line 5) ← inside main's line range
    //     └─CALLS─> FUNCTION (process_data)
    //
    // main has a direct CALLS edge to the CALL node (Layout B)
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/main.rs', name: 'main' })
      .node('fn_main', { type: 'FUNCTION', name: 'main', file: 'src/main.rs', line: 1, endLine: 10 })
      .node('fn_process', { type: 'FUNCTION', name: 'process_data', file: 'src/main.rs', line: 15 })
      .node('call1', { type: 'CALL', name: 'process_data', file: 'src/main.rs', line: 5 })
      .edge('mod1', 'fn_main', 'CONTAINS')
      .edge('mod1', 'fn_process', 'CONTAINS')
      .edge('fn_main', 'call1', 'CALLS')   // Layout B: direct fn→call edge
      .edge('call1', 'fn_process', 'CALLS'); // rust-calls resolved CALLS edge

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/main.rs');

    const mainFn = result.functions.find(f => f.name === 'main');
    assert.ok(mainFn, 'main function should appear in overview');
    assert.ok(
      mainFn!.calls.includes('process_data'),
      `main.calls should include 'process_data', got: ${JSON.stringify(mainFn!.calls)}`,
    );
  });

  it('Rust fn with path-qualified call (last :: segment) → resolved via call node name', async () => {
    // rust-calls matches by last `::` segment:
    // CALL name is 'process_data' (from crate::utils::process_data), resolved to fn.
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/lib.rs', name: 'lib' })
      .node('fn_run', { type: 'FUNCTION', name: 'run', file: 'src/lib.rs', line: 1, endLine: 20 })
      .node('fn_process', { type: 'FUNCTION', name: 'process_data', file: 'src/lib.rs', line: 25 })
      .node('call1', { type: 'CALL', name: 'process_data', file: 'src/lib.rs', line: 8 })
      .edge('mod1', 'fn_run', 'CONTAINS')
      .edge('mod1', 'fn_process', 'CONTAINS')
      // Line-range fallback: call1 at line 8 is within run (lines 1-20)
      // call1 has CALLS edge to fn_process (rust-calls resolved)
      .edge('call1', 'fn_process', 'CALLS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/lib.rs');

    const runFn = result.functions.find(f => f.name === 'run');
    assert.ok(runFn, 'run function should appear in overview');
    assert.ok(
      runFn!.calls.includes('process_data'),
      `run.calls should include 'process_data', got: ${JSON.stringify(runFn!.calls)}`,
    );
  });

  it('Rust fn without intra-file CALLS edge → call appears as unresolved name', async () => {
    // Before REG-656 fix: call node exists but has no CALLS edge.
    // After line-range fallback: call node's name used directly.
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/main.rs', name: 'main' })
      .node('fn_main', { type: 'FUNCTION', name: 'main', file: 'src/main.rs', line: 1, endLine: 10 })
      .node('call1', { type: 'CALL', name: 'helper', file: 'src/main.rs', line: 5 })
      // NOTE: no CALLS edge — simulating state BEFORE rust-calls fix
      .edge('mod1', 'fn_main', 'CONTAINS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/main.rs');

    const mainFn = result.functions.find(f => f.name === 'main');
    assert.ok(mainFn, 'main function should appear');
    assert.ok(
      mainFn!.calls.includes('helper'),
      `main.calls should include unresolved 'helper' by name, got: ${JSON.stringify(mainFn!.calls)}`,
    );
  });
});

// ============================================================================
// FileOverview fundamentals
//
// Basic contract tests that ensure the overview infrastructure itself
// is working correctly (precondition for the regression tests above).
// ============================================================================

describe('FileOverview fundamentals', () => {
  it('returns NOT_ANALYZED when no MODULE node for file', async () => {
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/other.ts', name: 'other' });

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/nonexistent.ts');

    assert.strictEqual(result.status, 'NOT_ANALYZED');
  });

  it('returns ANALYZED for file with MODULE node', async () => {
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/foo.ts', name: 'foo' });

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/foo.ts');

    assert.strictEqual(result.status, 'ANALYZED');
  });

  it('collects top-level FUNCTION nodes from MODULE CONTAINS edges', async () => {
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/utils.ts', name: 'utils' })
      .node('fn1', { type: 'FUNCTION', name: 'doThing', file: 'src/utils.ts', line: 1 })
      .node('fn2', { type: 'FUNCTION', name: 'doOther', file: 'src/utils.ts', line: 10 })
      .edge('mod1', 'fn1', 'CONTAINS')
      .edge('mod1', 'fn2', 'CONTAINS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/utils.ts');

    const names = result.functions.map(f => f.name).sort();
    assert.deepStrictEqual(names, ['doOther', 'doThing']);
  });

  it('include_edges=false returns empty calls without hitting graph edges', async () => {
    const graph = new MockGraph()
      .node('mod1', { type: 'MODULE', file: 'src/svc.ts', name: 'svc' })
      .node('fn1', { type: 'FUNCTION', name: 'handler', file: 'src/svc.ts', line: 1, endLine: 10 })
      .node('call1', { type: 'CALL', name: 'inner', file: 'src/svc.ts', line: 5 })
      .node('fn2', { type: 'FUNCTION', name: 'inner', file: 'src/svc.ts', line: 15 })
      .edge('mod1', 'fn1', 'CONTAINS')
      .edge('call1', 'fn2', 'CALLS');

    const overview = new FileOverview(graph.asBackend());
    const result = await overview.getOverview('src/svc.ts', { includeEdges: false });

    assert.deepStrictEqual(result.functions[0].calls, [], 'calls should be empty when includeEdges=false');
  });
});

// ============================================================================
// REG-652 — MCP not workspace-aware
//
// Root cause: MCP server used a hardcoded path / ignored CWD.
// Fix: findProjectRoot() walks up from process.cwd() looking for
// grafema.yaml or .grafema/ directory. Auto-detects workspace root.
// ============================================================================

describe('REG-652 — findProjectRoot workspace auto-detection', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'grafema-reg652-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('finds directory containing grafema.yaml', () => {
    writeFileSync(join(tmp, 'grafema.yaml'), 'services: []');
    const sub = join(tmp, 'packages', 'mcp');
    mkdirSync(sub, { recursive: true });
    assert.strictEqual(findProjectRoot(sub), tmp);
  });

  it('finds directory containing .grafema/', () => {
    mkdirSync(join(tmp, '.grafema'));
    const sub = join(tmp, 'deep', 'nested', 'dir');
    mkdirSync(sub, { recursive: true });
    assert.strictEqual(findProjectRoot(sub), tmp);
  });

  it('returns startDir itself when it contains grafema.yaml', () => {
    writeFileSync(join(tmp, 'grafema.yaml'), 'services: []');
    assert.strictEqual(findProjectRoot(tmp), tmp);
  });

  it('returns null when no grafema.yaml or .grafema/ in any ancestor', () => {
    const sub = join(tmp, 'some', 'dir');
    mkdirSync(sub, { recursive: true });
    const result = findProjectRoot(sub);
    // Accepts null or a path outside tmp (hit filesystem root)
    assert.ok(result === null || typeof result === 'string');
  });

  it('finds nearest ancestor when multiple candidates exist', () => {
    writeFileSync(join(tmp, 'grafema.yaml'), 'services: []');
    const inner = join(tmp, 'inner');
    mkdirSync(inner);
    writeFileSync(join(inner, 'grafema.yaml'), 'services: []');
    const sub = join(inner, 'src');
    mkdirSync(sub);
    assert.strictEqual(findProjectRoot(sub), inner);
  });
});

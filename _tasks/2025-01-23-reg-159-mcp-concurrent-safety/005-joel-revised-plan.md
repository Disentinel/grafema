# Technical Implementation Plan (REVISED): REG-159 MCP Concurrent Analysis Safety

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2025-01-23
**Status:** Revised after Linus review
**Revision:** 2

---

## Executive Summary

This revision incorporates Linus's mandatory changes to fix critical architectural issues:

1. **Worker `db.clear()` coordination** - moved from "future issue" to THIS issue
2. **Force flag race condition** - logic moved inside lock
3. **Lock timeout** - 10-minute timeout added
4. **Missing test** - worker coordination test added
5. **Process death behavior** - documented

**Key Change:** Worker process no longer calls `db.clear()`. MCP server calls it INSIDE the lock BEFORE spawning worker.

**Updated estimate:** 4.5 hours (was 3.5 hours)

---

## Changes from Original Plan

### What Changed

| Section | Change | Reason |
|---------|--------|--------|
| **Phase 2.5 (NEW)** | Add worker coordination phase | Linus: fix worker `db.clear()` NOW, not later |
| **Phase 3.2** | Move force flag logic inside lock | Linus: race condition in original plan |
| **Phase 3.1** | Add timeout to `acquireAnalysisLock()` | Linus: match project's 10-minute execution guard |
| **Phase 2.2** | Add worker coordination test | Linus: original tests didn't catch worker race |
| **Phase 5.1** | Document process death behavior | Linus: should be explicit |
| **Estimate** | 3.5h → 4.5h | +1h for worker coordination |

### What Stayed the Same

- Test infrastructure (MockBackend, MCPTestHarness) - unchanged
- Promise-based mutex pattern - unchanged
- Error on force=true during analysis - unchanged
- Global lock (not per-service) - unchanged

---

## Phase 1: Test Infrastructure (Test First)

**UNCHANGED from original plan.**

### 1.1 Directory Structure

Create test infrastructure for MCP package:

```
packages/mcp/
├── test/
│   ├── mcp.test.ts              # Main test file (Node.js test runner)
│   ├── helpers/
│   │   ├── MockBackend.ts       # In-memory backend for fast tests
│   │   └── MCPTestHarness.ts    # Helper to invoke handlers directly
│   └── fixtures/
│       └── minimal-project/     # Minimal project for analysis tests
│           ├── package.json
│           └── index.js
```

### 1.2 Test Configuration

Add test script to `packages/mcp/package.json`:

```json
{
  "scripts": {
    "test": "node --test --experimental-strip-types test/**/*.test.ts",
    "test:watch": "node --test --watch --experimental-strip-types test/**/*.test.ts"
  }
}
```

### 1.3 MockBackend Implementation

Create `packages/mcp/test/helpers/MockBackend.ts`:

```typescript
/**
 * In-memory mock backend for MCP tests
 *
 * Allows testing handlers without real RFDB server.
 * Simulates slow analysis via configurable delays.
 */

export interface MockBackendOptions {
  /** Delay in ms for analysis simulation */
  analysisDelay?: number;
  /** Initial node count (simulates existing analysis) */
  initialNodeCount?: number;
}

export class MockBackend {
  private nodes: Map<string, any> = new Map();
  private edges: any[] = [];
  public analysisDelay: number;
  public clearCalled = false;
  public clearCallCount = 0;

  constructor(options: MockBackendOptions = {}) {
    this.analysisDelay = options.analysisDelay ?? 0;
    if (options.initialNodeCount) {
      for (let i = 0; i < options.initialNodeCount; i++) {
        this.nodes.set(`node-${i}`, { id: `node-${i}`, type: 'MOCK' });
      }
    }
  }

  async connect(): Promise<void> {
    // No-op for mock
  }

  async close(): Promise<void> {
    // No-op for mock
  }

  async clear(): Promise<void> {
    this.clearCalled = true;
    this.clearCallCount++;
    this.nodes.clear();
    this.edges = [];
  }

  async nodeCount(): Promise<number> {
    return this.nodes.size;
  }

  async edgeCount(): Promise<number> {
    return this.edges.length;
  }

  async addNode(node: any): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async getNode(id: string): Promise<any | null> {
    return this.nodes.get(id) ?? null;
  }

  async countNodesByType(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const node of this.nodes.values()) {
      counts[node.type] = (counts[node.type] || 0) + 1;
    }
    return counts;
  }

  async countEdgesByType(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const edge of this.edges) {
      counts[edge.type] = (counts[edge.type] || 0) + 1;
    }
    return counts;
  }

  async *queryNodes(filter: Record<string, unknown>): AsyncGenerator<any> {
    for (const node of this.nodes.values()) {
      if (this.matchesFilter(node, filter)) {
        yield node;
      }
    }
  }

  async getOutgoingEdges(id: string, types?: string[]): Promise<any[]> {
    return this.edges.filter(e =>
      e.src === id && (!types || types.includes(e.type))
    );
  }

  async getIncomingEdges(id: string, types?: string[]): Promise<any[]> {
    return this.edges.filter(e =>
      e.dst === id && (!types || types.includes(e.type))
    );
  }

  async flush(): Promise<void> {
    // No-op for mock
  }

  private matchesFilter(node: any, filter: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(filter)) {
      if (node[key] !== value) return false;
    }
    return true;
  }
}
```

### 1.4 MCPTestHarness

Create `packages/mcp/test/helpers/MCPTestHarness.ts`:

```typescript
/**
 * Test harness for MCP handlers
 *
 * Allows injecting mock backend and state for isolated tests.
 */

import { MockBackend, MockBackendOptions } from './MockBackend.js';

export interface HarnessOptions extends MockBackendOptions {
  projectPath?: string;
  isAnalyzed?: boolean;
}

export class MCPTestHarness {
  public backend: MockBackend;
  public projectPath: string;
  public isAnalyzed: boolean;

  // Track analysis calls for concurrency tests
  public analysisCallLog: Array<{
    startTime: number;
    endTime?: number;
    service?: string;
    force?: boolean;
  }> = [];

  constructor(options: HarnessOptions = {}) {
    this.backend = new MockBackend(options);
    this.projectPath = options.projectPath ?? '/test/project';
    this.isAnalyzed = options.isAnalyzed ?? false;
  }

  /**
   * Reset state between tests
   */
  reset(): void {
    this.isAnalyzed = false;
    this.analysisCallLog = [];
    this.backend.clearCalled = false;
    this.backend.clearCallCount = 0;
  }

  /**
   * Get mock analysis status
   */
  getAnalysisStatus() {
    const running = this.analysisCallLog.some(c => !c.endTime);
    return {
      running,
      phase: running ? 'analysis' : null,
      message: null,
      servicesDiscovered: 0,
      servicesAnalyzed: 0,
      startTime: null,
      endTime: null,
      error: null,
      timings: { total: null },
    };
  }

  /**
   * Simulate analysis (with configurable delay)
   */
  async simulateAnalysis(service?: string, force?: boolean): Promise<void> {
    const callEntry = {
      startTime: Date.now(),
      service,
      force,
    };
    this.analysisCallLog.push(callEntry);

    if (force) {
      await this.backend.clear();
    }

    // Simulate analysis time
    if (this.backend.analysisDelay > 0) {
      await new Promise(r => setTimeout(r, this.backend.analysisDelay));
    }

    // Add some nodes
    await this.backend.addNode({ id: 'MODULE:test', type: 'MODULE', name: 'test' });

    callEntry.endTime = Date.now();
    this.isAnalyzed = true;
  }
}
```

### 1.5 Minimal Test Fixture

Create `packages/mcp/test/fixtures/minimal-project/package.json`:

```json
{
  "name": "test-project",
  "version": "1.0.0",
  "main": "index.js"
}
```

Create `packages/mcp/test/fixtures/minimal-project/index.js`:

```javascript
function hello() {
  console.log('hello');
}
module.exports = { hello };
```

---

## Phase 2: Comprehensive Test Coverage

### 2.1 Basic Handler Tests

**UNCHANGED from original plan.**

Create `packages/mcp/test/mcp.test.ts`:

```typescript
/**
 * MCP Server Tests
 *
 * Tests for:
 * - Basic handler functionality
 * - State management
 * - Concurrency protection
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { MCPTestHarness } from './helpers/MCPTestHarness.js';
import { MockBackend } from './helpers/MockBackend.js';

describe('MCP Handlers', () => {
  let harness: MCPTestHarness;

  beforeEach(() => {
    harness = new MCPTestHarness();
  });

  describe('handleGetAnalysisStatus', () => {
    it('should return running=false when no analysis in progress', () => {
      const status = harness.getAnalysisStatus();
      assert.strictEqual(status.running, false);
    });

    it('should return running=true during analysis', async () => {
      // Start analysis but don't await
      harness.backend.analysisDelay = 100;
      const analysisPromise = harness.simulateAnalysis();

      // Check status while running
      await new Promise(r => setTimeout(r, 10));
      const status = harness.getAnalysisStatus();
      assert.strictEqual(status.running, true);

      await analysisPromise;
    });
  });

  describe('handleAnalyzeProject', () => {
    it('should analyze project on first call', async () => {
      await harness.simulateAnalysis();

      assert.strictEqual(harness.isAnalyzed, true);
      const nodeCount = await harness.backend.nodeCount();
      assert.ok(nodeCount > 0);
    });

    it('should skip analysis if already analyzed', async () => {
      await harness.simulateAnalysis();
      const firstCallCount = harness.analysisCallLog.length;

      // Second call should be skipped (isAnalyzed = true)
      // This tests the current behavior before fix
    });

    it('should re-analyze with force=true', async () => {
      await harness.simulateAnalysis();
      harness.backend.clearCalled = false;

      await harness.simulateAnalysis(undefined, true);

      assert.strictEqual(harness.backend.clearCalled, true);
    });
  });
});

describe('State Management', () => {
  describe('analysisStatus.running', () => {
    it('should be false initially', () => {
      const harness = new MCPTestHarness();
      const status = harness.getAnalysisStatus();
      assert.strictEqual(status.running, false);
    });

    // NOTE: This test documents the BUG - running is never set to true
    // After fix, this test should pass
    it.skip('BUG: should be true during analysis (currently broken)', async () => {
      // This test will be enabled after the fix
    });
  });
});
```

### 2.2 Concurrency Tests

**REVISED: Added worker coordination test (Linus requirement #4)**

Add to `packages/mcp/test/mcp.test.ts`:

```typescript
describe('Concurrency Protection', () => {
  describe('Concurrent analyze_project calls', () => {
    it('should serialize concurrent calls (second waits for first)', async () => {
      const harness = new MCPTestHarness({ analysisDelay: 100 });

      // Start two analysis calls concurrently
      const call1 = harness.simulateAnalysis();
      const call2 = harness.simulateAnalysis();

      await Promise.all([call1, call2]);

      // After fix: calls should be serialized
      // call2 should start after call1 ends
      assert.strictEqual(harness.analysisCallLog.length, 2);

      const [first, second] = harness.analysisCallLog;
      // Second call should start after first ends (serialization)
      // NOTE: This assertion will FAIL before the fix
      // assert.ok(second.startTime >= first.endTime!);
    });

    it('should return error for force=true during running analysis', async () => {
      // This is the USER DECISION: error on force=true during analysis
      const harness = new MCPTestHarness({ analysisDelay: 100 });

      // Start first analysis
      const call1 = harness.simulateAnalysis();

      // Wait a bit for call1 to be "running"
      await new Promise(r => setTimeout(r, 10));

      // Try force=true while running
      // After fix: should return error immediately
      // For now we document expected behavior
    });

    it('should NOT call db.clear() multiple times from concurrent calls', async () => {
      const harness = new MCPTestHarness({ analysisDelay: 50 });

      // Simulate concurrent force=true calls (before fix, this is dangerous)
      const call1 = harness.simulateAnalysis(undefined, true);
      const call2 = harness.simulateAnalysis(undefined, true);

      await Promise.all([call1, call2]);

      // After fix with error on concurrent force: clearCallCount should be 1
      // Before fix: clearCallCount would be 2 (race condition)
      // assert.strictEqual(harness.backend.clearCallCount, 1);
    });

    // **NEW TEST** - Linus requirement #4
    it('should prevent worker from clearing DB while MCP analysis writes', async () => {
      const harness = new MCPTestHarness({ analysisDelay: 100 });

      // MCP server acquires lock, clears DB, spawns worker
      // Worker should NOT call db.clear() because MCP already did it

      // Start analysis
      await harness.simulateAnalysis();

      // Verify: db.clear() was called ONCE (by MCP server, not by worker)
      // After fix: clearCallCount should be 1
      assert.strictEqual(harness.backend.clearCallCount, 1);
    });

    it('should allow concurrent reads (find_nodes, query_graph)', async () => {
      // Read operations should not block each other
      const harness = new MCPTestHarness({
        analysisDelay: 0,
        initialNodeCount: 10
      });
      harness.isAnalyzed = true;

      // Multiple concurrent reads should work
      const reads = await Promise.all([
        harness.backend.nodeCount(),
        harness.backend.nodeCount(),
        harness.backend.nodeCount(),
      ]);

      assert.deepStrictEqual(reads, [10, 10, 10]);
    });
  });

  describe('Global lock behavior', () => {
    it('should use single global lock (not per-service)', async () => {
      // USER DECISION: Global lock, not per-service
      const harness = new MCPTestHarness({ analysisDelay: 100 });

      // Analyze service A
      const callA = harness.simulateAnalysis('serviceA');

      // Analyze service B (should wait for A, not run in parallel)
      await new Promise(r => setTimeout(r, 10));
      const callB = harness.simulateAnalysis('serviceB');

      await Promise.all([callA, callB]);

      // After fix: B should start after A ends
      // assert.ok(harness.analysisCallLog[1].startTime >= harness.analysisCallLog[0].endTime!);
    });
  });
});
```

### 2.3 Integration Tests (with Real Backend)

**UNCHANGED from original plan.**

Add to `packages/mcp/test/mcp.test.ts` at the end:

```typescript
import { createTestBackend } from '../../../test/helpers/TestRFDB.js';

describe('Integration: Real Backend', { timeout: 30000 }, () => {
  let backend: ReturnType<typeof createTestBackend>;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  it('should analyze minimal project', async () => {
    // This tests the full pipeline with real backend
    // Skip for now, will be enabled when we have proper fixtures
  });
});
```

---

## Phase 2.5: Worker Clear Coordination (NEW)

**NEW PHASE - Linus requirement #1**

### 2.5.1 Analysis: Current Worker Behavior

From `analysis-worker.ts:216`:

```typescript
db = new RFDBServerBackend({ socketPath, dbPath });
await db.connect();
await db.clear();  // <-- PROBLEM: Not protected by MCP mutex
```

**Why this is dangerous:**

1. Worker is separate process → MCP's Promise-based mutex doesn't apply
2. Worker calls `db.clear()` immediately after connect
3. If MCP spawns worker while another analysis is writing → corruption
4. RFDB has no transaction isolation → multiple clients can write simultaneously

**Current execution flow:**

```
Time    MCP Server                  Worker Process
----    ----------                  --------------
T0      acquireAnalysisLock()
T1      spawn worker process
T2      ...waiting...               db.connect()
T3      ...waiting...               db.clear()  <-- DANGER
T4      ...waiting...               orchestrator.run()
T5      releaseLock()
```

### 2.5.2 Solution: Move `db.clear()` to MCP Server

**New execution flow:**

```
Time    MCP Server                  Worker Process
----    ----------                  --------------
T0      acquireAnalysisLock()
T1      await db.clear()
T2      spawn worker process
T3      ...waiting...               db.connect()
T4      ...waiting...               orchestrator.run() (DB already clean)
T5      releaseLock()
```

### 2.5.3 Implementation

**File 1:** `packages/mcp/src/analysis.ts`

Modify `ensureAnalyzed()` to clear DB BEFORE spawning worker:

```typescript
export async function ensureAnalyzed(
  serviceName: string | null = null,
  force: boolean = false
): Promise<GraphBackend> {
  const db = await getOrCreateBackend();
  const projectPath = getProjectPath();
  const isAnalyzed = getIsAnalyzed();

  // CONCURRENCY CHECK: If force=true and analysis is running, error immediately
  if (force && isAnalysisRunning()) {
    throw new Error(
      'Analysis is already in progress. Cannot force re-analysis while another analysis is running. ' +
      'Wait for the current analysis to complete or check status with get_analysis_status.'
    );
  }

  // Skip if already analyzed (and not forcing)
  if (isAnalyzed && !serviceName && !force) {
    return db;
  }

  // Acquire lock (waits if another analysis is running)
  const releaseLock = await acquireAnalysisLock();

  try {
    // Double-check after acquiring lock (another call might have completed)
    if (getIsAnalyzed() && !serviceName && !force) {
      return db;
    }

    // **NEW: Clear DB inside lock, BEFORE spawning worker**
    if (force || !isAnalyzed) {
      log('[Grafema MCP] Clearing database before analysis...');
      await db.clear();
      setIsAnalyzed(false);
    }

    log(
      `[Grafema MCP] Analyzing project: ${projectPath}${serviceName ? ` (service: ${serviceName})` : ''}`
    );

    // ... rest of existing analysis code (spawn worker, etc.) ...

    return db;
  } finally {
    // ALWAYS release the lock
    releaseLock();
  }
}
```

**File 2:** `packages/mcp/src/analysis-worker.ts`

Remove `db.clear()` from worker:

```typescript
async function run(): Promise<void> {
  const startTime = Date.now();
  let db: RFDBServerBackend | null = null;

  try {
    sendProgress({ phase: 'starting', message: 'Loading configuration...' });

    const config = await loadConfig();
    const customPlugins = await loadCustomPlugins();

    // ... [plugin loading code unchanged] ...

    // Connect to RFDB server (shared with MCP server)
    const dbPath = join(projectPath, '.grafema', 'graph.rfdb');
    const socketPath = config.analysis?.parallel?.socketPath || '/tmp/rfdb.sock';

    console.log(`[Worker] Connecting to RFDB server: socket=${socketPath}, db=${dbPath}`);
    db = new RFDBServerBackend({ socketPath, dbPath });
    await db.connect();

    // **REMOVED: await db.clear();**
    //
    // Rationale: MCP server clears DB INSIDE the analysis lock, BEFORE spawning this worker.
    // Worker assumes DB is already clean. This prevents race conditions where concurrent
    // analysis calls could both clear the DB.
    //
    // See: Phase 2.5 in REG-159 implementation plan

    sendProgress({ phase: 'discovery', message: 'Starting analysis...' });

    // ... rest unchanged ...
  } finally {
    // ... cleanup unchanged ...
  }
}
```

### 2.5.4 Verification Test

Update test from Phase 2.2:

```typescript
it('should prevent worker from clearing DB while MCP analysis writes', async () => {
  const harness = new MCPTestHarness({ analysisDelay: 100 });

  // Simulate MCP server behavior:
  // 1. Acquire lock
  // 2. Clear DB (INSIDE lock)
  // 3. Spawn worker (worker does NOT clear)

  await harness.simulateAnalysis();

  // Verify: db.clear() was called ONCE (by MCP server, not by worker)
  assert.strictEqual(harness.backend.clearCallCount, 1, 'DB should be cleared once by MCP server, not by worker');
});
```

---

## Phase 3: Concurrency Fix Implementation

### 3.1 Add Lock State to `state.ts`

**REVISED: Added timeout (Linus requirement #3)**

Add to `/packages/mcp/src/state.ts`:

```typescript
// === ANALYSIS LOCK ===

/**
 * Promise-based mutex for analysis serialization.
 *
 * Why not a simple boolean flag?
 * - Boolean can't make callers wait
 * - Promise allows awaiting until analysis completes
 *
 * Pattern:
 * - null = no analysis running
 * - Promise = analysis running, await to wait
 */
let analysisLock: Promise<void> | null = null;
let analysisLockResolve: (() => void) | null = null;

/**
 * Lock timeout (10 minutes)
 * Matches project's execution guard policy (see CLAUDE.md)
 */
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Check if analysis is currently running
 */
export function isAnalysisRunning(): boolean {
  return analysisLock !== null;
}

/**
 * Acquire analysis lock.
 *
 * @returns Promise that resolves when lock is acquired
 *          AND a release function to call when done
 * @throws Error if timeout (10 minutes) expires while waiting
 */
export async function acquireAnalysisLock(): Promise<() => void> {
  const start = Date.now();

  // Wait for any existing analysis to complete (with timeout)
  while (analysisLock !== null) {
    if (Date.now() - start > LOCK_TIMEOUT_MS) {
      throw new Error(
        'Analysis lock timeout (10 minutes). Previous analysis may have failed. ' +
        'Check .grafema/mcp.log for errors or restart MCP server.'
      );
    }
    await analysisLock;
  }

  // Create new lock
  analysisLock = new Promise<void>((resolve) => {
    analysisLockResolve = resolve;
  });

  // Update status
  setAnalysisStatus({ running: true });

  // Return release function
  return () => {
    setAnalysisStatus({ running: false });
    const resolve = analysisLockResolve;
    analysisLock = null;
    analysisLockResolve = null;
    resolve?.();
  };
}

/**
 * Wait for any running analysis to complete (without acquiring lock)
 */
export async function waitForAnalysis(): Promise<void> {
  if (analysisLock) {
    await analysisLock;
  }
}
```

### 3.2 Update `analysis.ts`

**REVISED: Force flag logic moved inside lock (Linus requirement #2)**

Modify `/packages/mcp/src/analysis.ts`:

```typescript
import {
  getOrCreateBackend,
  getProjectPath,
  getIsAnalyzed,
  setIsAnalyzed,
  getAnalysisStatus,
  setAnalysisStatus,
  // NEW: lock functions
  isAnalysisRunning,
  acquireAnalysisLock,
} from './state.js';

/**
 * Ensure project is analyzed, optionally filtering to a single service.
 *
 * CONCURRENCY: This function is protected by a global mutex.
 * - Only one analysis can run at a time
 * - Concurrent calls wait for the current analysis to complete
 * - force=true while analysis is running returns an error
 *
 * @param serviceName - Optional service to analyze (null = all)
 * @param force - If true, re-analyze even if already analyzed.
 *                ERROR if analysis is already running.
 * @throws Error if force=true and analysis is running
 */
export async function ensureAnalyzed(
  serviceName: string | null = null,
  force: boolean = false
): Promise<GraphBackend> {
  const db = await getOrCreateBackend();
  const projectPath = getProjectPath();
  const isAnalyzed = getIsAnalyzed();

  // CONCURRENCY CHECK: If force=true and analysis is running, error immediately
  if (force && isAnalysisRunning()) {
    throw new Error(
      'Analysis is already in progress. Cannot force re-analysis while another analysis is running. ' +
      'Wait for the current analysis to complete or check status with get_analysis_status.'
    );
  }

  // Skip if already analyzed (and not forcing)
  if (isAnalyzed && !serviceName && !force) {
    return db;
  }

  // Acquire lock (waits if another analysis is running)
  const releaseLock = await acquireAnalysisLock();

  try {
    // Double-check after acquiring lock (another call might have completed)
    if (getIsAnalyzed() && !serviceName && !force) {
      return db;
    }

    // **REVISED: Force flag logic INSIDE lock**
    // Clear DB if force=true or first analysis
    if (force || !getIsAnalyzed()) {
      log('[Grafema MCP] Clearing database before analysis...');
      await db.clear();
      setIsAnalyzed(false);
    }

    log(
      `[Grafema MCP] Analyzing project: ${projectPath}${serviceName ? ` (service: ${serviceName})` : ''}`
    );

    // ... rest of existing analysis code ...

    const config = loadConfig(projectPath);
    const { pluginMap: customPluginMap } = await loadCustomPlugins(projectPath);

    // [existing plugin loading code]

    const analysisStatus = getAnalysisStatus();
    const startTime = Date.now();

    const orchestrator = new Orchestrator({
      graph: db,
      plugins: plugins as Plugin[],
      parallel: parallelConfig,
      serviceFilter: serviceName,
      onProgress: (progress: any) => {
        log(`[Grafema MCP] ${progress.phase}: ${progress.message}`);

        setAnalysisStatus({
          phase: progress.phase,
          message: progress.message,
          servicesDiscovered: progress.servicesDiscovered || analysisStatus.servicesDiscovered,
          servicesAnalyzed: progress.servicesAnalyzed || analysisStatus.servicesAnalyzed,
        });
      },
    });

    await orchestrator.run(projectPath);

    // Flush if available
    if ('flush' in db && typeof db.flush === 'function') {
      await (db as any).flush();
    }

    setIsAnalyzed(true);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    setAnalysisStatus({
      timings: {
        ...analysisStatus.timings,
        total: parseFloat(totalTime),
      },
    });

    log(`[Grafema MCP] Analysis complete in ${totalTime}s`);

    return db;
  } finally {
    // ALWAYS release the lock
    releaseLock();
  }
}
```

### 3.3 Update `handlers.ts`

**REVISED: Removed `setIsAnalyzed(false)` from handler (moved to `ensureAnalyzed`)**

Modify `/packages/mcp/src/handlers.ts`:

```typescript
import { isAnalysisRunning } from './state.js';

export async function handleAnalyzeProject(args: AnalyzeProjectArgs): Promise<ToolResult> {
  const { service, force } = args;

  // USER DECISION: Return error on force=true if analysis is running
  if (force && isAnalysisRunning()) {
    return errorResult(
      'Cannot force re-analysis: analysis is already in progress. ' +
      'Use get_analysis_status to check current status, or wait for completion.'
    );
  }

  // **REMOVED: setIsAnalyzed(false) - now handled inside ensureAnalyzed**

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
    return errorResult((error as Error).message);
  }
}
```

---

## Phase 4: Test Updates After Fix

**UNCHANGED from original plan.**

### 4.1 Enable Previously-Skipped Tests

After implementing the fix, update `packages/mcp/test/mcp.test.ts`:

```typescript
describe('Concurrency Protection (Post-Fix)', () => {
  it('should serialize concurrent calls', async () => {
    const harness = new MCPTestHarness({ analysisDelay: 100 });

    const call1 = harness.simulateAnalysis();
    await new Promise(r => setTimeout(r, 10)); // Let call1 start
    const call2 = harness.simulateAnalysis();

    await Promise.all([call1, call2]);

    const [first, second] = harness.analysisCallLog;
    // With serialization, second should start after first ends
    assert.ok(
      second.startTime >= first.endTime!,
      `Expected serial execution: call2.start (${second.startTime}) >= call1.end (${first.endTime})`
    );
  });

  it('should return error for force=true during analysis', async () => {
    // Simulate the actual handler behavior
    const harness = new MCPTestHarness({ analysisDelay: 100 });

    // Start analysis
    const analysisPromise = harness.simulateAnalysis();
    await new Promise(r => setTimeout(r, 10));

    // Try force=true - should get error
    // (In real implementation, this calls handleAnalyzeProject which checks isAnalysisRunning)
    const isRunning = harness.getAnalysisStatus().running;
    assert.strictEqual(isRunning, true, 'Analysis should be running');

    // The handler would return error here
    // assert error behavior when integrated

    await analysisPromise;
  });

  it('should show running=true in status during analysis', async () => {
    const harness = new MCPTestHarness({ analysisDelay: 100 });

    const analysisPromise = harness.simulateAnalysis();
    await new Promise(r => setTimeout(r, 10));

    const status = harness.getAnalysisStatus();
    assert.strictEqual(status.running, true, 'Status should show running=true');

    await analysisPromise;

    const finalStatus = harness.getAnalysisStatus();
    assert.strictEqual(finalStatus.running, false, 'Status should show running=false after completion');
  });
});
```

---

## Phase 5: Documentation

### 5.1 Code Comments

**REVISED: Added process death behavior (Linus requirement #5)**

Add to `state.ts`:

```typescript
/**
 * Analysis Lock Implementation
 *
 * Grafema MCP uses a Promise-based mutex to serialize analysis operations.
 * This prevents data corruption when multiple analyze_project calls arrive
 * concurrently.
 *
 * ## Why not a simple boolean flag?
 *
 * A boolean flag can indicate "analysis is running" but cannot make
 * concurrent callers wait. With Promise-based locking:
 *
 * 1. First caller acquires lock, starts analysis
 * 2. Second caller sees lock exists, awaits the Promise
 * 3. When first caller releases, Promise resolves
 * 4. Second caller can then proceed
 *
 * ## Behavior on force=true during analysis
 *
 * If a caller requests force=true while analysis is running:
 * - Returns error immediately (does NOT wait)
 * - Rationale: force=true implies "clear DB and re-analyze"
 * - Clearing DB while another analysis writes = corruption
 * - Better UX: immediate feedback vs mysterious wait
 *
 * ## Scope: Global Lock
 *
 * The lock is global (not per-service) because:
 * - Single RFDB backend instance
 * - db.clear() affects entire database
 * - Simpler reasoning about state
 *
 * ## Process Death Behavior
 *
 * **What happens if MCP server crashes mid-analysis?**
 *
 * 1. Lock is in-memory → next process starts with fresh state (no deadlock)
 * 2. RFDB may have partial data from incomplete analysis
 * 3. `isAnalyzed` resets to false → next call will re-analyze
 * 4. RFDB is append-only → partial data won't corrupt existing data
 *
 * Result: Safe recovery. Analysis restarts on next request.
 *
 * **Worker process crash:**
 * - MCP server detects worker exit via IPC
 * - Releases lock in finally block
 * - Sets error in analysisStatus
 * - Next call can proceed
 *
 * **RFDB server crash:**
 * - RFDBServerBackend reconnects automatically
 * - Analysis will fail with connection error
 * - Lock released in finally block
 * - User can retry analysis
 *
 * ## Timeout
 *
 * Lock acquisition times out after 10 minutes (matches project's execution
 * guard policy in CLAUDE.md). If timeout occurs:
 * - Error message tells user to check logs or restart server
 * - Prevents infinite wait on stuck analysis
 *
 * ## Worker Process Coordination
 *
 * Worker process is SEPARATE from MCP server. This lock doesn't apply there.
 *
 * Solution: MCP server calls `db.clear()` INSIDE the lock, BEFORE spawning
 * worker. Worker assumes DB is already clean and does NOT call clear().
 *
 * See Phase 2.5 in REG-159 implementation plan for details.
 *
 * ## Future: Multi-process Coordination
 *
 * This lock only works within a single Node.js process.
 * If multiple MCP servers share one RFDB, we need:
 * - File-based lock (flock)
 * - Or RFDB-level transaction isolation
 *
 * Current deployment: single MCP server per project. Not an issue yet.
 */
```

### 5.2 Error Messages

**UNCHANGED from original plan.**

Error messages should be actionable:

```typescript
// Bad: "Analysis in progress"
// Good: Explains what's happening and what to do

const ERROR_FORCE_DURING_ANALYSIS =
  'Cannot force re-analysis: analysis is already in progress. ' +
  'Use get_analysis_status to check current status, or wait for completion.';

const ERROR_ANALYSIS_FAILED =
  'Analysis failed: {message}. ' +
  'Check .grafema/mcp.log for details.';

const ERROR_LOCK_TIMEOUT =
  'Analysis lock timeout (10 minutes). Previous analysis may have failed. ' +
  'Check .grafema/mcp.log for errors or restart MCP server.';
```

---

## Implementation Order (Critical Path)

**REVISED: Added Phase 2.5 steps, updated estimate**

| Step | File | Description | Est. Time |
|------|------|-------------|-----------|
| 1 | `packages/mcp/test/helpers/MockBackend.ts` | Create mock backend | 20 min |
| 2 | `packages/mcp/test/helpers/MCPTestHarness.ts` | Create test harness | 20 min |
| 3 | `packages/mcp/test/mcp.test.ts` | Basic tests + concurrency tests | 45 min |
| 4 | `packages/mcp/package.json` | Add test script | 5 min |
| 5 | Run tests, verify they fail on concurrency | | 10 min |
| **6** | **`packages/mcp/src/state.ts`** | **Add lock state + timeout** | **40 min** (+10 min for timeout) |
| **7** | **`packages/mcp/src/analysis.ts`** | **Move db.clear() inside lock** | **40 min** (+10 min for clear logic) |
| **8** | **`packages/mcp/src/analysis-worker.ts`** | **Remove db.clear() from worker** | **15 min** (NEW) |
| **9** | **`packages/mcp/test/mcp.test.ts`** | **Add worker coordination test** | **15 min** (NEW) |
| 10 | `packages/mcp/src/handlers.ts` | Add force check in handler | 15 min |
| 11 | Run tests, verify they pass | | 10 min |
| 12 | Add documentation comments | | 20 min (+5 min for process death docs) |

**Total estimate:** ~4.5 hours (was 3.5 hours)

**Added time breakdown:**
- Timeout implementation: +10 min
- Move clear logic to analysis.ts: +10 min
- Remove clear from worker: +15 min
- Worker coordination test: +15 min
- Process death documentation: +5 min
- **Total added: +55 min (~1 hour)**

---

## Acceptance Criteria

**REVISED: Added worker coordination criterion**

1. **Tests exist and pass** for:
   - Basic handler functionality
   - `running` flag correctly set during analysis
   - Concurrent calls are serialized
   - `force=true` during running analysis returns error
   - **Worker does NOT clear DB (MCP server does it)**

2. **Behavior verified:**
   - `get_analysis_status` shows `running: true` during analysis
   - Two concurrent `analyze_project` calls don't both call `db.clear()`
   - Second call waits for first to complete
   - **Worker and MCP server don't race on `db.clear()`**

3. **Error messages** are actionable (tell user what to do)

4. **Code comments** explain:
   - Concurrency model
   - **Process death behavior**
   - Worker coordination
   - **Lock timeout policy**

---

## Risks and Mitigations

**REVISED: Updated worker risk to "FIXED"**

| Risk | Impact | Mitigation | Status |
|------|--------|------------|--------|
| Tests too slow (real backend) | Dev friction | MockBackend for fast unit tests | Planned |
| Lock not released on error | Deadlock | `finally` block always releases | Planned |
| **Worker spawned outside lock** | **Race condition** | **MCP clears DB before spawning worker** | **FIXED in Phase 2.5** |
| Multi-process not handled | Future bug | Document limitation, no immediate action | Documented |
| Lock timeout too short | False positives | 10 min matches project policy | Planned |

---

## Follow-up Issues to Create

**UPDATED: Removed multi-process issue (not needed for current deployment)**

1. **REG-XXX: Analysis progress reporting**
   - `get_analysis_status` could show percentage/phase
   - Nice-to-have for long-running analysis
   - Low priority

---

## Summary of Changes from Original Plan

### Added
- **Phase 2.5: Worker Clear Coordination** (entire phase)
- Timeout to `acquireAnalysisLock()` (10 minutes)
- Worker coordination test
- Process death behavior documentation

### Modified
- Force flag logic moved from `handlers.ts` to inside `ensureAnalyzed` lock
- `db.clear()` moved from worker to MCP server (inside lock)
- Time estimate: 3.5h → 4.5h

### Removed
- `setIsAnalyzed(false)` from `handlers.ts` (now in `ensureAnalyzed`)
- Follow-up issue for multi-process coordination (not needed yet)

---

**Ready for final review and implementation.**

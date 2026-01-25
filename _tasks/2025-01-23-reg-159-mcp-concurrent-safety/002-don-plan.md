# Don Melton - Technical Analysis: REG-159

## Current Implementation Analysis

### The Call Flow

1. **`handleAnalyzeProject`** (handlers.ts:423-443)
   - Checks `force` flag to optionally reset `isAnalyzed`
   - Calls `ensureAnalyzed(service)`
   - Returns status on completion

2. **`ensureAnalyzed`** (analysis.ts:21-112)
   - Gets backend via `getOrCreateBackend()` (creates singleton if needed)
   - Checks `getIsAnalyzed()` - if true AND no serviceName, returns early
   - If analysis needed:
     - Loads config and plugins
     - Creates `Orchestrator` with `onProgress` callback
     - Calls `orchestrator.run(projectPath)` (the long operation)
     - Calls `db.flush()` if available
     - Sets `isAnalyzed = true` via `setIsAnalyzed(true)`
   - Returns backend

3. **State Management** (state.ts)
   - Global module-level variables: `projectPath`, `backend`, `isAnalyzed`
   - `analysisStatus` object has `running: boolean` but it's **NEVER SET TO TRUE**
   - Simple getters/setters with no synchronization

4. **Worker Process** (analysis-worker.ts)
   - Separate process that runs analysis
   - Calls `db.clear()` at line 216 - clears entire database
   - Also connects to same RFDB server via socket

### The Shared Resource Problem

The `RFDBServerBackend` (core/storage/backends/RFDBServerBackend.ts):
- Uses Unix socket communication to shared RFDB server
- Multiple processes CAN connect simultaneously (MCP server + workers)
- `clear()` and `flush()` are global operations affecting all clients

## Concurrency Risk Assessment

### Critical Risks

**Risk 1: Double Analysis Start (SEVERITY: HIGH)**
```
Time    Agent A                     Agent B
----    -------                     -------
T0      handleAnalyzeProject()
T1      getIsAnalyzed() -> false    handleAnalyzeProject()
T2      start analysis...           getIsAnalyzed() -> false (still!)
T3      ...running...               start analysis (SECOND!)
T4      ...running...               ...running...
```

Two concurrent analyses running on same database. The `isAnalyzed` flag is only set to `true` AFTER `orchestrator.run()` completes - there's no "in progress" guard.

**Risk 2: Database Clear Race (SEVERITY: CRITICAL)**
```
Time    Analysis A                  Analysis B
----    ----------                  ----------
T0      db.clear()
T1      addNodes([1,2,3])           db.clear()  <-- CLEARS A's nodes!
T2      addNodes([4,5,6])           addNodes([a,b,c])
```

The worker process calls `db.clear()` at startup. If two analyses start, the second's clear wipes the first's progress.

**Risk 3: Partial State on Error (SEVERITY: MEDIUM)**
```
Time    Event
----    -----
T0      Analysis starts, isAnalyzed = false
T1      orchestrator.run() throws error
T2      catch block returns error
T3      isAnalyzed still false, but db has partial data
```

The database may contain partial data, but `isAnalyzed` remains false, so next call will try again.

**Risk 4: Force Flag Race (SEVERITY: HIGH)**
```
Time    Agent A                     Agent B
----    -------                     -------
T0      analyze(force=true)
T1      setIsAnalyzed(false)        getAnalysisStatus()
T2      start analysis...           sees "not analyzed"
T3      ...running...               analyze() - starts second!
```

### Not a Risk (Clarification)

The `running` field in `AnalysisStatus` exists but is never used. The status struct has:
```typescript
analysisStatus: AnalysisStatus = {
  running: false,  // <-- NEVER SET TO TRUE ANYWHERE
  phase: null,
  ...
}
```

This appears to be intended for concurrency control but was never implemented.

## Recommended Behavior

### Decision: Option A - Serial with Lock (with timeout)

**Rationale:**

1. **AI agents WILL retry** - If we return an error, Claude Code (or any agent) will immediately retry, creating the same race condition. Agents don't understand "wait and check status."

2. **Analysis is idempotent in effect** - Running analysis twice produces the same graph (assuming no code changes). The second call should simply wait, not fail.

3. **Database integrity is paramount** - The graph database is the product's core value. Corrupted/partial data is unacceptable.

4. **This matches user expectation** - When a user/agent says "analyze," they expect it to complete, not fail because something is already running.

**Implementation:**
- Use a Promise-based lock (mutex pattern)
- First caller holds lock, runs analysis
- Second caller awaits same Promise (deduplication)
- Add timeout to prevent infinite waits
- The lock is at the `ensureAnalyzed` level, not handler level

**Why NOT Option B (reject)?**
- Agents will retry immediately
- Creates poor UX - "why did my command fail?"
- Requires agents to poll status (complex, error-prone)

**Why NOT Option C (both run)?**
- Database corruption
- Resource waste
- Non-deterministic results

## High-Level Plan

### Phase 1: Add Test Infrastructure

The MCP package has **ZERO tests**. This is a problem. We need:

1. **Create test directory**: `packages/mcp/test/`
2. **Basic handler tests**: Test that handlers call expected functions
3. **Concurrency test**: Simulate concurrent `handleAnalyzeProject` calls
4. **Lock behavior tests**: Verify second call waits for first

### Phase 2: Implement Analysis Lock

1. **Add lock state to state.ts**:
   ```typescript
   let analysisLock: Promise<GraphBackend> | null = null;
   ```

2. **Modify ensureAnalyzed in analysis.ts**:
   ```typescript
   export async function ensureAnalyzed(...): Promise<GraphBackend> {
     // Check if analysis already running
     const existingLock = getAnalysisLock();
     if (existingLock) {
       log('[Grafema MCP] Analysis already in progress, waiting...');
       return existingLock;
     }

     if (isAnalyzed && !serviceName) {
       return db;
     }

     // Create lock before starting
     const analysisPromise = runAnalysis(...);
     setAnalysisLock(analysisPromise);

     try {
       const result = await analysisPromise;
       return result;
     } finally {
       setAnalysisLock(null);
     }
   }
   ```

3. **Actually use the `running` flag**:
   ```typescript
   setAnalysisStatus({ running: true });
   // ... analysis ...
   setAnalysisStatus({ running: false });
   ```

### Phase 3: Worker Process Coordination

The worker process (analysis-worker.ts) has its own `db.clear()`. Options:

1. **Remove worker clear**: Only MCP server should clear
2. **Add worker lock file**: `/tmp/grafema-analyzing.lock`
3. **Socket-based coordination**: Worker checks with server before clearing

Recommendation: **Option 1** - centralize clear in MCP server. The worker should assume the database is ready.

### Phase 4: Error Recovery

1. **Partial analysis cleanup**: On error, clear the database
2. **Status reset on error**: `setAnalysisStatus({ running: false, error: message })`
3. **Consider retry logic**: If lock exists but process died, detect and recover

## Key Files to Modify

1. `/packages/mcp/src/state.ts` - Add lock state
2. `/packages/mcp/src/analysis.ts` - Implement lock pattern
3. `/packages/mcp/src/analysis-worker.ts` - Remove or guard `db.clear()`
4. `/packages/mcp/test/` - New test infrastructure (to be created)

## Key Questions/Concerns

### For Discussion with User

1. **Test Infrastructure Gap**: The MCP package has zero tests. Should we:
   - Add minimal tests for this fix only?
   - Create comprehensive test suite first?
   - Track as separate Linear issue?

2. **Worker Process Architecture**: The worker does `db.clear()`. Is this intentional? Should analysis ALWAYS clear first, or should it be incremental?

3. **Force Flag Semantics**: Currently `force=true` just sets `isAnalyzed=false`. Should it:
   - Wait if analysis running, then rerun?
   - Cancel running analysis?
   - Queue for after current completes?

4. **Timeout Value**: What's reasonable? Analysis can take minutes on large codebases. Suggest 10 minutes max (matching project's execution guard rule).

5. **Service Filter Interaction**: `ensureAnalyzed(serviceName)` runs analysis even if `isAnalyzed=true`. Should this also be locked? Or is per-service analysis independent?

### Technical Concern

The Promise-based lock pattern in Node.js single-threaded model is safe, but we need to be careful about:
- Lock cleanup on process crash
- Lock state after `await` points (JS event loop can interleave)
- Memory leaks if lock Promise is never resolved

The implementation must be bulletproof - this is a correctness issue, not a performance optimization.

---

## Summary

The issue is real and critical. There is NO synchronization currently - the `running` flag exists but is never used. The fix is straightforward (Promise-based lock) but needs tests first to ensure we don't break anything. The worker process `db.clear()` is also a concern that needs clarification.

This aligns with project vision: **database integrity is paramount**. The graph must be reliable for AI agents to trust it.

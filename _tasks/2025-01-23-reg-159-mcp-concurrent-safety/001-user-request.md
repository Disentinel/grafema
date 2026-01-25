# User Request: REG-159

## Linear Issue

**Title:** Test MCP analyze_project handler for concurrent safety

## Context

MCP's `handleAnalyzeProject` (`packages/mcp/src/handlers.ts:423-443`):
- Calls `ensureAnalyzed(service || null)` (`packages/mcp/src/analysis.ts:21`)
- State in `state.ts`: `isAnalyzed`, `analysisStatus`, `backend`
- Worker spawns child process (`analysis-worker.ts`)

### Potential issues

1. **Race condition:** Two concurrent calls before first completes → both start analysis
2. **State sync:** `setIsAnalyzed(true)` happens after `orchestrator.run()` completes
3. **Backend conflict:** Concurrent `db.clear()` or `db.connect()` calls

## Requirements

### Test concurrent calls
- Call `handleAnalyzeProject({})` twice simultaneously
- Verify both complete without error
- Verify database not corrupted
- Verify status object consistent

### Test with service filter
- Call with `service: "service1"` and `service: "service2"` concurrently
- Verify behavior documented

### Document expected behavior
- **Option A:** One waits for other (serial)
- **Option B:** Second rejected (error)
- **Option C:** Both run independently (with warnings)

Need decision: Which behavior is correct?

## Technical Notes
- New test file: `packages/mcp/test/handlers.test.ts`
- Use `Promise.all()` to simulate concurrent calls
- May need to mock Orchestrator or use minimal test project
- `state.ts` has no synchronization primitives currently

## Files to Modify
- Create: `packages/mcp/test/handlers.test.ts`
- Possibly: `state.ts` (if adding lock)
- Document: concurrency expectations in code comments

## Acceptance Criteria
- [ ] Test file created
- [ ] Test calls handler twice concurrently
- [ ] Both calls complete (no hung promises)
- [ ] Database state consistent
- [ ] Expected behavior documented
- [ ] If fix needed, lock mechanism implemented

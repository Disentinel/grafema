# Linus Torvalds - Plan Review for `grafema doctor`

## VERDICT: APPROVED

This is solid work. Don's design is clean and well-scoped. Joel's implementation plan is thorough and reuses existing infrastructure properly. Let's build it.

---

## What's Good

### 1. Clear Separation of Concerns
The distinction between `doctor` (setup), `check` (code quality), and `stats` (graph info) is exactly right. Doctor stays in its lane - diagnosing why Grafema isn't working, not telling users how to write code.

### 2. No Over-Engineering
The check hierarchy makes sense:
- Fail-fast on prerequisites (can't do anything without `.grafema/`)
- Progressive checks that depend on previous passing
- `skip` status for checks that can't run (server not running)

This is pragmatic. We're not trying to be clever, just methodical.

### 3. Proper Reuse
Joel identified all the right pieces to reuse:
- `GraphFreshnessChecker` for staleness
- `loadConfig()` for validation
- `RFDBClient.ping()` for server status
- `getStats()` for node/edge counts

No code duplication. No reimplementation of existing logic. Good.

### 4. Exit Code Strategy
```
0 = healthy
1 = critical (Grafema won't work)
2 = warnings (may have issues)
```

This is standard Unix convention. CI can detect problems. Agents can script around it. Perfect.

### 5. JSON Output for Agents
The JSON mode is essential for AI-first tooling. The structure is sensible:
```json
{
  "status": "warning",
  "checks": [...],
  "recommendations": [...]
}
```

Agents can parse this and take action. Aligns with project vision.

---

## Concerns

### 1. Connectivity Check Performance (MINOR)

Joel's implementation of `checkConnectivity` does:
1. `getAllNodes()` - loads all nodes into memory
2. `getAllEdges()` - loads all edges into memory
3. BFS traversal

On a massive graph (100K+ nodes), this could be slow or memory-intensive.

**Question:** Can we query RFDB for "nodes not reachable from SERVICE/MODULE" directly? Or do we need full graph in memory?

**Recommendation:** If this becomes a bottleneck, we can optimize later. For v0.1.x, this is fine. But add a comment:

```typescript
// TODO: Optimize for large graphs - query unreachable nodes directly from RFDB
```

Don't block implementation on this. Ship it. Measure later. Optimize if needed.

### 2. Plugin Validation Approach (TRIVIAL)

Joel proposes moving `BUILTIN_PLUGINS` to a shared location or creating `VALID_PLUGIN_NAMES` set.

**Recommendation:** Just use `VALID_PLUGIN_NAMES` set. Don't extract the entire `BUILTIN_PLUGINS` map - that creates coupling we don't need. The set of valid names is sufficient for validation.

This is a 5-line change. Not worth overthinking.

### 3. Test Coverage for Integration Test (MINOR)

The integration test skips if no analyzed project exists:
```typescript
if (!existsSync(join(grafemaRoot, '.grafema', 'graph.rfdb'))) {
  console.log('Skipping: no analyzed grafema project available');
  return;
}
```

**Concern:** CI might always skip this test if grafema repo isn't analyzed first.

**Recommendation:** Either:
- Make sure CI runs `grafema analyze` on the grafema repo before testing
- OR create a minimal test fixture with a tiny analyzed project

Not critical for initial PR. Can address in follow-up.

---

## What Could Go Wrong

### Scenario: Doctor Called on Huge Legacy Codebase

User runs `grafema doctor` on 500K node graph.
- `getAllNodes()` → 50MB+ in memory
- `getAllEdges()` → 100MB+ in memory
- BFS traversal → takes 30+ seconds

**Is this acceptable?**

YES. Here's why:
1. Doctor is a diagnostic tool, not a hot path
2. User expects some delay when checking large graphs
3. We can add `--skip-connectivity` flag later if needed
4. Output should show progress: "Checking connectivity (this may take a moment)..."

If we find this is a real problem, we'll fix it then. Don't prematurely optimize.

---

## Missing Pieces? NO.

I looked for what's NOT in scope. Good decisions:
- NOT adding `--watch` mode → overkill
- NOT validating every edge type → that's analysis
- NOT auto-fixing config → deferred to `--fix` flag (future)
- NOT checking external API versions → offline-first

This is exactly the right scope for v0.1.x.

---

## Alignment with Vision

Does this help AI agents? **YES.**

Before doctor:
```
AI: Why are there 0 modules?
User: ¯\_(ツ)_/¯
```

After doctor:
```
AI: Running grafema doctor...
Doctor: ✗ Database is empty (0 nodes) → Run: grafema analyze
AI: I'll run grafema analyze to fix this.
```

Actionable recommendations. Clear next steps. This is what AI-first means.

---

## Required Changes: NONE

This is good to go. Start implementing.

---

## Recommendations for Implementation

### For Kent Beck (Tests)
1. Write tests for each check function independently (unit)
2. Write integration test that covers full flow
3. Test failure scenarios:
   - Invalid YAML syntax
   - Missing entrypoints
   - Stale modules
   - Disconnected nodes > 20%
4. Test edge cases:
   - Server not running (skip checks)
   - Empty database
   - Deprecated config.json

### For Rob Pike (Implementation)
1. Follow Joel's commit order - it's sound
2. Match existing CLI style (check.ts, server.ts)
3. Keep checks simple and readable
4. Don't optimize connectivity check unless it's actually slow
5. Add progress indicator for slow checks (connectivity, freshness)

### For Final Review
I'll check:
1. Exit codes are correct (0/1/2)
2. JSON output matches spec
3. Recommendations are actionable (not vague "check config")
4. No duplication of existing logic
5. Tests actually test what they claim

---

## Final Notes

This is a well-designed feature. Don's separation of concerns is clean. Joel's implementation plan is thorough without being over-engineered.

Ship it.

---

**Status:** APPROVED - proceed to Kent Beck for tests, then Rob Pike for implementation.

# Linus Torvalds - Plan Review: REG-334 Promise Dataflow Tracking

**Status: APPROVED with minor clarifications**

---

## Executive Summary

This plan is **solid**. Don and Joel have done their homework:

1. They understood the problem correctly
2. They chose the right approach (forward registration, not brute-force)
3. They avoided the complexity trap (no enricher phase scanning)
4. The complexity analysis is accurate - no O(n) iterations

This is exactly how Grafema features should be designed.

---

## Complexity Checklist (Mandatory)

### 1. Iteration Space

| Operation | Complexity | Verdict |
|-----------|------------|---------|
| Promise executor detection | O(1) per NewExpression | OK |
| Context lookup for resolve() | O(d) where d = nesting depth | OK |
| RESOLVES_TO edge creation | O(r) where r = resolve calls | OK |
| traceValues traversal | O(e) where e = edges (1-2) | OK |

**No O(n) iterations over all nodes.** The plan explicitly integrates into existing AST traversal rather than creating new scanning phases.

### 2. Plugin Architecture

**Forward Registration Pattern: YES**

- Analyzer marks data during normal traversal (not scanning for patterns later)
- Edges buffered in collections, flushed by GraphBuilder
- traceValues follows edges from specific starting point

This matches the HTTP_RECEIVES precedent exactly. The plan correctly identified this parallel.

### 3. Extensibility Check

**Adding new Promise-like patterns requires:**
- New detection in JSASTAnalyzer for that specific pattern
- No changes to traceValues (it just follows RESOLVES_TO)

This is acceptable. The alternative (generic "thenable" detection) would be over-engineering for MVP.

---

## What's Good

### 1. Correct Root Cause Analysis

The plan correctly identifies that `resolve()` is not a normal function call - it's a **data channel**. This semantic insight drives the right solution.

### 2. Leveraging Existing Patterns

The HTTP_RECEIVES precedent in traceValues.ts is exactly the right model. The plan follows it closely:

```typescript
// HTTP_RECEIVES (existing)
if (nodeType === 'CALL' || nodeType === 'METHOD_CALL') {
  const httpEdges = await backend.getOutgoingEdges(nodeId, ['HTTP_RECEIVES']);
  if (httpEdges.length > 0) { /* follow them */ }
}

// RESOLVES_TO (proposed) - same pattern
if (nodeType === 'CONSTRUCTOR_CALL') {
  const resolveEdges = await backend.getIncomingEdges(nodeId, ['RESOLVES_TO']);
  if (resolveEdges.length > 0) { /* follow them */ }
}
```

### 3. Scope Boundaries Are Clear

The plan explicitly lists what's in and out of scope:

**IN:** Direct resolve() calls, nested callbacks, multiple resolve paths
**OUT:** resolve passed as argument, destructured resolve, .then() chains

This is correct prioritization for MVP.

### 4. Context Management Strategy

The revised approach using Map keyed by function position (Section 3.4 in Joel's plan) is cleaner than the stack approach. It naturally handles nested Promises without complex pop timing.

---

## Concerns

### 1. getIncomingEdges Optional Interface

Joel's plan makes `getIncomingEdges` optional in `TraceValuesGraphBackend`:

```typescript
getIncomingEdges?(nodeId: string, edgeTypes: string[] | null): Promise<TraceValuesEdge[]>;
```

**Problem:** This creates a silent failure path. If a backend doesn't implement it, Promise tracing silently falls back to "unknown".

**Recommendation:** Make it required. All our backends (RFDB) support incoming edge queries. If we add a backend that doesn't, we'll deal with it then. Don't design for hypotheticals.

### 2. Edge Direction Inconsistency

The plan proposes:
- `RESOLVES_TO` edge: `CALL(resolve) --> CONSTRUCTOR_CALL(Promise)`

But HTTP_RECEIVES uses outgoing edges from CALL:
- `HTTP_RECEIVES` edge: `CALL(fetch) --> backend response node`

Both semantically represent "data flows TO here FROM there", but:
- HTTP_RECEIVES is followed via `getOutgoingEdges`
- RESOLVES_TO would need `getIncomingEdges`

**This inconsistency is acceptable** because the semantics are slightly different:
- HTTP_RECEIVES: "this call receives data from that source"
- RESOLVES_TO: "this resolve call provides data to that Promise"

However, document this decision clearly in the code.

### 3. CONSTRUCTOR_CALL Not Currently Handled

Looking at traceValues.ts, there's no current handling for `CONSTRUCTOR_CALL` node type. The trace path is:

```
VARIABLE --ASSIGNED_FROM--> CONSTRUCTOR_CALL --???--> nowhere
```

The plan correctly identifies this gap and adds handling. But verify that ASSIGNED_FROM edges are actually created for `const x = new Promise(...)` patterns.

### 4. CALL Node ID Generation for resolve()

Joel's plan shows:
```typescript
const callId = scopeTracker
  ? computeSemanticId('CALL', calleeName, scopeTracker.getContext(), {...})
  : `CALL#${calleeName}#${module.file}#${line}:${column}:...`;
```

**Question:** Does `resolve()` get a CALL node created in the normal CallExpression handler? If so, we need to ensure we use the SAME ID when creating the RESOLVES_TO edge. If not, we need to CREATE the CALL node.

The plan assumes the CALL node exists. **Verify this assumption** before implementation.

---

## What's Missing

### 1. Test for Backend getIncomingEdges

The test plan includes complexity verification but should also include a test that verifies RFDB backend correctly supports `getIncomingEdges` for RESOLVES_TO edges.

### 2. Documentation for AI Agents

Per project vision, every feature must be documented for LLM agents. Add a section explaining when/how to use Promise dataflow tracing in queries.

### 3. Error Handling for Malformed Executors

What if executor isn't a function? What if it has no parameters?

```javascript
new Promise(null);           // executor is null
new Promise(() => {});       // no resolve parameter
new Promise(existingFunc);   // not inline function
```

The plan handles the third case (out of scope). But the first two should be handled gracefully (just don't create edges, don't crash).

---

## Action Items

Before implementation:

1. **Verify CALL node existence**: Confirm resolve() calls get CALL nodes in normal processing
2. **Make getIncomingEdges required**: Remove the `?` from interface
3. **Add edge case tests**: null executor, no-param executor

These are minor clarifications, not blockers. Implementation can proceed.

---

## Verdict

**APPROVED**

This plan demonstrates:
- Understanding of Grafema's architecture (forward registration)
- Correct complexity analysis (no O(n) traps)
- Pragmatic scoping (MVP focus, clear boundaries)
- Building on existing patterns (HTTP_RECEIVES precedent)

The concerns raised are clarifications, not fundamental issues. Joel's technical spec is detailed enough for implementation.

Proceed to Kent for test implementation.

---

**Reviewed by:** Linus Torvalds (simulated)
**Date:** 2026-02-04

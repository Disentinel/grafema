## Auto-Review: REG-432 Plan

**Verdict:** REJECT

**Vision & Architecture:** CRITICAL ISSUE
**Practical Quality:** Issues found
**Code Quality:** OK

## Critical Issues

### 1. ARCHITECTURAL MISMATCH — Node Type Namespace (BLOCKING)

**Issue:** Plan proposes adding `socket:connection` and `socket:server` to node types, BUT the existing codebase already has a `net:` namespace for network operations.

**Evidence from types package:**
```typescript
// NAMESPACED_TYPE enum (lines 77-79)
NET_REQUEST: 'net:request',
NET_STDIO: 'net:stdio',
```

**Evidence from helper functions:**
```typescript
// isSideEffectType() (lines 360-364)
export function isSideEffectType(nodeType: string): boolean {
  if (nodeType === NODE_TYPE.SIDE_EFFECT) return true;
  const ns = getNamespace(nodeType);
  return ns === 'db' || ns === 'fs' || ns === 'net';  // ← 'net' namespace already exists
}
```

**Correct namespace:** `net:connection` and `net:server` (not `socket:*`)

**Why this matters:**
1. **Consistency:** Existing `net:request` already uses `net:` namespace
2. **Helper functions:** `isSideEffectType()` already checks for `ns === 'net'`
3. **Convention:** Network operations use `net:` prefix (established pattern)

**Root Cause Policy violation:** This is an architectural gap that MUST be fixed before implementation. Using `socket:` would create namespace fragmentation and break existing helper functions.

### 2. INCOMPLETE COMPLEXITY ANALYSIS

**Issue:** Plan states "Matches FetchAnalyzer: linear scan of all modules" but doesn't validate against the MANDATORY Complexity Checklist.

**Missing analysis:**
1. ✗ Iteration space not verified against actual node counts
2. ✗ No discussion of whether this extends existing iteration or adds new pass
3. ✗ No comparison with similar analyzers (DatabaseAnalyzer, SocketIOAnalyzer)

**Required:** Explicit statement that:
- Analyzer iterates O(M) modules (same as FetchAnalyzer) — acceptable
- Enricher iterates O(C × S) where C and S are bounded small sets — acceptable
- No brute-force scanning of all graph nodes

### 3. MISSING EDGE TYPE — CONTAINS not in enricher metadata

**Issue:** Plan shows enricher creating only `INTERACTS_WITH` edges, but analyzer creates `CONTAINS` edges from MODULE to socket nodes. HTTPConnectionEnricher doesn't create CONTAINS edges — those come from the analyzer phase.

**Evidence from plan (Step 2, line 171):**
```typescript
creates: {
  nodes: ['socket:connection', 'socket:server'],
  edges: ['CONTAINS', 'MAKES_REQUEST']  // ← CONTAINS is analyzer's job
}
```

**Evidence from HTTPConnectionEnricher (lines 54-57):**
```typescript
creates: {
  nodes: [],
  edges: ['INTERACTS_WITH', 'HTTP_RECEIVES']  // ← No CONTAINS
}
```

**Correction needed:** Analyzer creates CONTAINS (MODULE → socket nodes), enricher only creates INTERACTS_WITH (socket:connection → socket:server).

## Practical Quality Issues

### 4. Test fixture numbering incorrect

**Issue:** Plan proposes `test/fixtures/08-socket-connections/` but fixture 08 already exists.

**Evidence:**
```
drwxr-xr-x@  5 vadim  staff   160 14 февр. 20:25 08-no-http-requests
drwxr-xr-x@  5 vadim  staff   160 14 февр. 20:25 08-reexports
```

**Correction:** Use next available number (need to check what comes after 09).

### 5. Missing metadata property — library resolution unclear

**Issue:** Plan shows `library: 'net'` but doesn't explain how to detect custom socket wrappers (e.g., libraries that wrap `net.Socket`).

**Question:** Should this analyzer detect ONLY direct `net.*` calls, or also custom wrappers (like FetchAnalyzer detects `authFetch`)?

**Impact on scope:** If custom wrappers are in scope, detection logic needs pattern matching beyond simple `net.*` member expressions.

## Recommendations

### BLOCKING (Must fix before implementation):

1. **Change namespace from `socket:*` to `net:*`:**
   ```typescript
   // Correct node types:
   NET_CONNECTION: 'net:connection',
   NET_SERVER: 'net:server',
   ```

2. **Verify complexity against checklist:**
   - State explicitly: "Analyzer iterates M modules (bounded, same as FetchAnalyzer)"
   - State explicitly: "Enricher iterates C × S where C and S are small sets (typically <100)"
   - Confirm: "No iteration over all graph nodes"

3. **Fix metadata.creates in enricher:**
   ```typescript
   // SocketConnectionEnricher should NOT create CONTAINS edges
   creates: {
     nodes: [],
     edges: ['INTERACTS_WITH']  // Only this
   }
   ```

### RECOMMENDED (Should address):

4. **Clarify library detection scope:** V1 covers ONLY direct `net.*` calls (no custom wrappers). Document this as limitation.

5. **Fix test fixture numbering:** Check highest fixture number, use next available (likely 10 or beyond).

6. **Update isSideEffectType() example in Step 1:** Plan shows adding `|| ns === 'socket'` but should not change (already covers `ns === 'net'`).

## Summary

**Why REJECT:**
- **Architectural gap:** Using wrong namespace (`socket:` vs `net:`) breaks existing conventions and helper functions
- **Incomplete complexity analysis:** Missing mandatory checklist verification
- **Pattern mismatch:** Enricher metadata doesn't follow existing pattern

**Next steps:**
1. Don revises plan with `net:*` namespace
2. Don adds explicit complexity verification
3. Don fixes enricher metadata (no CONTAINS in creates)
4. Re-submit for review

This is exactly the kind of issue the Root Cause Policy is designed to catch BEFORE implementation starts. Better to spend 30 minutes fixing the plan than 3 hours refactoring implemented code.

# Steve Jobs + Вадим Решетников - Full Scope Review for REG-311

## Joint Decision: CONDITIONAL APPROVE

Coverage jump 55% → ~85% justifies the effort. Plan is architecturally sound with **SIX MANDATORY FIXES**.

---

## Mandatory Conditions

### 1. Variable Micro-Trace: Replace Depth Limit with Cycle Detection

**Problem:** Depth 3 is arbitrary, misses deep chains common in error handling.

**Fix:**
```typescript
private microTraceToErrorClass(variableName: string, funcPath: NodePath<t.Function>): {
  const visited = new Set<string>();  // Cycle detection
  let currentName = variableName;
  const maxDepth = 10;  // Safeguard only
  
  while (visited.size < maxDepth) {
    if (visited.has(currentName)) break;  // Cycle detected
    visited.add(currentName);
    // ... trace logic ...
  }
}
```

### 2. Priority Ordering Documentation

Add explicit comment:
```typescript
priority: 70, // Runs AFTER FunctionCallResolver (80) - higher priority runs first
```

### 3. CATCHES_FROM Edge: REMOVE FROM MVP

- Semantics under-specified
- Not required for core rejection tracking
- Defer to v0.3

**Saves ~1.5 days.**

### 4. isInsideTryBlock: Use O(1) Counter

**Problem:** O(s) scope chain traversal per call = O(s*c) total.

**Fix:**
```typescript
let insideTryDepth = 0;

TryStatement: {
  enter() { insideTryDepth++; },
  exit() { insideTryDepth--; }
}

CallExpression: (callPath) => {
  const isInsideTry = insideTryDepth > 0;  // O(1)
}
```

### 5. Fixpoint Convergence Warning

- Log WARNING if MAX_ITERATIONS reached
- Add `converged: boolean` to result metadata
- Document max depth 10 limitation

### 6. Precise Complexity Documentation

- Not "linear" but "O(a*c) per iteration"
- Document max depth 10 limitations
- Create Linear issues for known gaps BEFORE merging

---

## Timeline Revision

| Phase | Days |
|-------|------|
| Week 1: Analysis Phase | 5 days |
| Week 2: Enrichment Phase | 4 days |
| Testing + Polish | 2 days |
| **Total** | **11-13 days** |

---

## What We're Buying

**Before:** 55% coverage
**After:** ~85% coverage

**Deferred to v0.3:**
- CATCHES_FROM edges
- Promise.all/race support
- Deep chains (>10)

---

## Final Verdict

**CONDITIONAL APPROVE** — implement with mandatory fixes above.

**Steve Jobs** & **Вадим Решетников**
*High-level Reviewers*

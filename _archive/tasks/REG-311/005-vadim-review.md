# Вадим Решетников - High-Level Review for REG-311

## Decision: **REJECT**

This plan has fundamental architectural issues that will create technical debt and limit future extensibility.

---

## Vision Alignment

**Question: Does this align with "AI should query the graph, not read code"?**

**PARTIAL.** The feature adds queryable metadata (`canReject`) and edges (`REJECTS`), which is good. However, the limitation "only `new Error()` patterns" defeats the purpose for >50% of real-world async error handling.

Real-world rejection patterns:
```javascript
// Pattern 1: Variable rejection (NOT tracked by this plan)
function apiCall(url) {
  return fetch(url)
    .catch(err => Promise.reject(err));  // err is variable
}

// Pattern 2: Error forwarding (NOT tracked)
function wrapper() {
  return doSomething()
    .catch(reject);  // reject is a reference
}

// Pattern 3: Async/await implicit rejection (NOT tracked)
async function getData() {
  throw new Error('fail');  // Becomes rejection, not tracked as REJECTS
}
```

---

## Critical Architectural Issues

### 1. **Async/Await Completely Missing**

The plan ignores that `throw` inside `async function` becomes a rejection:

```javascript
async function fetchData() {
  throw new ValidationError('bad input');  // This REJECTS, not THROWS
}
```

**Impact:** The graph will show this as `hasThrow=true` but NOT `canReject=true`. This is **factually incorrect** - the function doesn't throw, it rejects.

**Root cause:** The plan treats async/await as "out of scope" when it's the PRIMARY async pattern in modern JavaScript.

### 2. **Semantic Overlap with RESOLVES_TO is Unclear**

REG-334 already creates RESOLVES_TO edges with `metadata.isReject: true`. This plan adds REJECTS edges.

**Question:** What does REJECTS tell us that RESOLVES_TO with isReject doesn't?

**Counterargument from Steve:** They are complementary - RESOLVES_TO tracks data flow, REJECTS tracks error typing. **This is acceptable** if clearly documented.

### 3. **Builtin Error Handling is a Hack**

Joel's plan creates synthetic IDs `CLASS:Error:builtin`.

**This is WRONG on multiple levels:**

1. **Inconsistent with existing architecture:** Grafema has `packages/core/src/data/builtins/` for builtin definitions. Why not use it?
2. **Creates zombie nodes:** These synthetic CLASS nodes don't exist as real nodes
3. **No forward path for improvement:** If we later add builtin CLASS nodes, this becomes technical debt

### 4. **Complexity Analysis is Misleading**

Step 7 in Joel's plan:
```typescript
for (const pattern of rejectionPatterns) {
  const errorClass = classDeclarations.find(c => c.name === pattern.errorClassName);
```

This is **O(r * c)** where r = rejection patterns, c = class declarations.

**Impact:** For large codebases with many custom error classes, this becomes slow.

**Correct approach:** Use a Map for class lookups, or defer to enrichment phase.

---

## MVP Limitations That Defeat the Feature

| Pattern | Tracked? | Coverage |
|---------|----------|----------|
| `Promise.reject(new Error())` | ✅ Yes | ~10% |
| `reject(new Error())` in executor | ✅ Yes | ~15% |
| `reject(err)` where err is variable | ❌ No | ~35% |
| `throw` in async function | ❌ No | ~30% |
| Error-first callbacks | ❌ No | ~10% |

**Coverage: ~25%** of real-world patterns.

**This is concerning** but not necessarily a blocker IF we have a clear path to improve coverage.

---

## Recommended Changes

### 1. Fix Builtin Error Handling (CRITICAL)

**Do NOT create synthetic CLASS nodes.** Instead:

```typescript
export interface ControlFlowMetadata {
  // ... existing fields ...
  canReject: boolean;
  rejectedBuiltinErrors?: string[];  // ['Error', 'TypeError']
}
```

Only create REJECTS edges for user-defined error classes.

### 2. Address Async/Await Semantic Error

For MVP: Add a note that `throw` in async function should be tracked separately.

Create follow-up issue: "REG-XXX: Track throw in async function as rejection"

### 3. Optimize Class Lookups

Use Map instead of array.find():

```typescript
const classMap = new Map(classDeclarations.map(c => [c.name, c]));
// Then O(1) lookups
const errorClass = classMap.get(pattern.errorClassName);
```

### 4. Document All Limitations

Clear documentation of what IS and IS NOT tracked, with follow-up issues created.

---

## Verdict

**REJECT the current plan** due to:
1. Synthetic builtin CLASS nodes (technical debt)
2. Missing async/await semantic handling
3. Inefficient O(r*c) class lookups

**However**, the core approach is sound. With these fixes, the plan is acceptable for MVP:

1. Remove synthetic CLASS node creation - use metadata for builtins
2. Optimize class lookups to O(r) with Map
3. Create follow-up issues for async/await and variable rejections
4. Document limitations clearly

**Estimated additional effort:** 0.5 days to address these concerns.

---

## Process Note

**To user:** Steve and I agree on the core issues:
- No synthetic CLASS nodes (phantom nodes violate graph integrity)
- The feature is useful even at 25% coverage IF we have clear roadmap for improvement

**Key question for user:** Do you want to:
1. **Fix and proceed** - Address the three issues above, ship MVP
2. **Expand scope** - Include async/await handling (adds ~1-2 days)
3. **Defer entirely** - Wait until we can do comprehensive async error tracking

My recommendation: **Option 1** - Fix critical issues, ship MVP with documented limitations.

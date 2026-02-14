# Revised Plan — REG-286: Track ThrowStatement systematically

## Steve's Feedback Addressed

Steve rejected Don's plan for proposing "extend by cloning" instead of extending the existing abstraction. He's right. Here's the revised approach.

### Answers to Steve's Questions

**Q: Why separate ThrowPatternInfo?**
A: No reason. We reuse `RejectionPatternInfo` and add `sync_throw` to the type union.

**Q: hasThrow vs canThrow?**
A: Redundant. Keep `hasThrow` (already exists). Add `thrownBuiltinErrors: string[]` to ControlFlowMetadata (mirrors `rejectedBuiltinErrors`).

**Q: THROWS vs REJECTS — one edge type or two?**
A: Two, because they have different error handling semantics:
- `try { f() } catch(e) {}` — catches THROWS only
- `await f()` in try/catch — catches THROWS + REJECTS
- `.catch(handler)` — catches REJECTS only

Separate edges enable precise queries: "what can fail with try/catch?" vs "what needs .catch()?"

## Revised Approach (3 steps)

### Step 1: Extend RejectionPatternInfo with `sync_throw`

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

Add `sync_throw` to the `rejectionType` union:
```typescript
rejectionType:
  | 'promise_reject'
  | 'executor_reject'
  | 'async_throw'
  | 'sync_throw'         // NEW: throw in non-async function
  | 'variable_traced'
  | 'variable_parameter'
  | 'variable_unknown';
```

### Step 2: Remove `isAsyncFunction` guard in ThrowStatement visitor

**File:** `JSASTAnalyzer.ts` ~line 3912

Currently: throw patterns collected only when `isAsyncFunction && currentFunctionId`.
Change: collect for ALL functions. Use `sync_throw` type for non-async.

```
// Before: if (isAsyncFunction && currentFunctionId && ...)
// After: if (currentFunctionId && ...)
//   rejectionType: isAsyncFunction ? 'async_throw' : 'sync_throw'
```

Add `thrownBuiltinErrors` to ControlFlowMetadata (mirrors `rejectedBuiltinErrors`):
```typescript
thrownBuiltinErrors?: string[];  // error class names from sync throws
```

Populate it alongside `rejectedBuiltinErrors` computation, filtering for `sync_throw` patterns.

### Step 3: Extend `bufferRejectionEdges` to emit THROWS edges

**File:** `GraphBuilder.ts` ~line 3489

Instead of always emitting `REJECTS`, choose edge type based on pattern:
```typescript
const edgeType = isSyncPattern ? 'THROWS' : 'REJECTS';
```

Where `isSyncPattern` = pattern has `sync_throw` or `variable_*` from a non-async function.

**Decision:** We need to know if the function is async to decide edge type. Options:
- a) Add `isAsync` field to RejectionPatternInfo (simplest)
- b) Look up function from `functions` array (O(1) with Map)

Choice: (a) — add `isAsync: boolean` to RejectionPatternInfo. Clean, no lookups.

## What we DON'T do
- No new `ThrowPatternInfo` interface
- No new `throwPatterns` collection
- No new `bufferThrowsEdges()` method
- No `canThrow` metadata (hasThrow already exists)

## Tests
- Sync throw: `throw new Error()` → THROWS edge + thrownBuiltinErrors
- Sync throw with class: `throw new ValidationError()` → THROWS edge to CLASS
- Async throw: still creates REJECTS edge (no regression)
- Variable throw: `throw err` → micro-trace works for sync too
- Parameter throw: `throw param` → tracked as variable_parameter

## Complexity
O(t) where t = throw statements. Single iteration, single edge buffering pass (extended, not duplicated).

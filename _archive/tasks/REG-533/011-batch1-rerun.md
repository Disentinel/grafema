# Batch 1 Re-run Review - REG-533

**Date:** 2026-02-20
**Fix Applied:** UpdateExpression field name corrected from `testObjectSourceName` to `testUpdateArgSourceName`

---

## Steve Jobs — Vision Review (Re-run)

**Verdict:** APPROVE

### Change Analysis

The fix addresses a field name mismatch bug in line 555 of `ControlFlowBuilder.ts`. Previously:
```typescript
if (expressionType === 'UpdateExpression' && loop.testObjectSourceName) {
```

Now:
```typescript
if (expressionType === 'UpdateExpression' && loop.testUpdateArgSourceName) {
```

### Architecture Impact: NONE

This is a pure bug fix with zero architectural changes:

1. **No new abstractions** — Same pattern as existing UnaryExpression handling (lines 548-553)
2. **No behavior changes** — Just using the correct field that was already being extracted by `extractDiscriminantExpression()` (JSASTAnalyzer.ts:2477)
3. **No new complexity** — The field was already defined in LoopInfo (types.ts:181) and extracted by LoopHandler (lines 152, 174, 197, 255)

The bug was simple: UpdateExpression returns `updateArgSourceName` from the extractor, LoopHandler correctly maps it to `testUpdateArgSourceName`, but ControlFlowBuilder was checking the wrong field (`testObjectSourceName` is for MemberExpression, not UpdateExpression).

### Vision Alignment: UNCHANGED

The original approval stands. This fix simply makes UpdateExpression work as intended — no vision or architecture changes.

**Verdict:** APPROVE. Ship it.

---

## Вадим auto — Completeness Review (Re-run)

**Verdict:** APPROVE

### Gap Closed

Dijkstra's Issue 1 identified that UpdateExpression in loop test conditions would NEVER create DERIVES_FROM edges due to the field name mismatch.

**Before fix:**
```javascript
for (; i++ < 10; ) { }
```
- `extractDiscriminantExpression()` returns `updateArgSourceName: 'i'`
- `LoopHandler` extracts it to `testUpdateArgSourceName`
- `ControlFlowBuilder` checks `loop.testObjectSourceName` (wrong field!)
- Result: No DERIVES_FROM edge created ❌

**After fix:**
```javascript
for (; i++ < 10; ) { }
```
- `extractDiscriminantExpression()` returns `updateArgSourceName: 'i'`
- `LoopHandler` extracts it to `testUpdateArgSourceName`
- `ControlFlowBuilder` checks `loop.testUpdateArgSourceName` (correct!)
- Result: DERIVES_FROM edge created to variable `i` ✅

### Verification

All changed locations verified:

1. **LoopInfo type** (types.ts:181): `testUpdateArgSourceName?: string` — field exists ✅
2. **LoopHandler variable** (line 152): `let testUpdateArgSourceName: string | undefined;` — declared ✅
3. **LoopHandler while/do-while** (line 174): `testUpdateArgSourceName = condResult.updateArgSourceName;` — extracted ✅
4. **LoopHandler for-loop** (line 197): `testUpdateArgSourceName = condResult.updateArgSourceName;` — extracted ✅
5. **LoopHandler data passing** (line 255): `testUpdateArgSourceName,` — passed to collection ✅
6. **ControlFlowBuilder** (line 555): `if (expressionType === 'UpdateExpression' && loop.testUpdateArgSourceName)` — FIXED ✅

### Expression Type Coverage

UpdateExpression is now fully functional:
- ✅ BinaryExpression
- ✅ LogicalExpression
- ✅ ConditionalExpression
- ✅ MemberExpression
- ✅ TemplateLiteral
- ✅ UnaryExpression
- ✅ **UpdateExpression** (FIXED)
- ✅ Identifier

All 8 expression types from the spec are now working.

### Scope Creep Check

**Zero scope creep.** The fix changes exactly 1 field name in 1 line of code. No new features, no refactoring, no additional changes.

**Verdict:** APPROVE. The UpdateExpression gap is closed. Ready to merge.

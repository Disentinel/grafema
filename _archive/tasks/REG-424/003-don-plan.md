# REG-424: Don's Refactoring Plan

## Analysis

CallExpressionVisitor.ts is **1,526 lines** with these logical groups:

| Group | Methods | Lines | % |
|-------|---------|-------|---|
| Types/interfaces | 8 interfaces | 166 | 11% |
| Top-level helpers | checkNodeComments, getGrafemaIgnore, PATTERN | 78 | 5% |
| Argument extraction | extractArguments, extractIdentifiers | 267 | 18% |
| Object literal extraction | extractObjectProperties | 186 | 12% |
| Array literal extraction | extractArrayElements | 141 | 9% |
| Mutation detection | detectArrayMutation, detectObjectAssign | 179 | 12% |
| Helpers | extractMemberExpressionName, getFunctionScopeId | 75 | 5% |
| Handler logic | getHandlers (CallExpression + NewExpression) | 358 | 23% |
| Class shell + imports | | 76 | 5% |

## Strategy: Extract Utility Classes

Unlike REG-422 (which decomposed a traverse block into handler classes), CallExpressionVisitor's complexity comes from **utility methods** that do data extraction. The handlers (`getHandlers`) call these utilities.

**Approach:** Extract utility methods into standalone helper classes. Keep `getHandlers()` and the class shell in the main file.

### Extraction Plan

**1. `call-expression-types.ts`** — All 8 interfaces (~166 lines)
- ObjectLiteralInfo, ObjectPropertyInfo, ArrayLiteralInfo, ArrayElementInfo
- ArgumentInfo, CallSiteInfo, MethodCallInfo, EventListenerInfo
- MethodCallbackInfo, LiteralInfo

**2. `call-expression-helpers.ts`** — Top-level helpers + grafema-ignore logic (~78 lines)
- GRAFEMA_IGNORE_PATTERN constant
- checkNodeComments()
- getGrafemaIgnore()

**3. `ArgumentExtractor.ts`** — Static utility class (~280 lines)
- extractArguments() — needs collections, delegates to ObjectPropertyExtractor/ArrayElementExtractor
- extractIdentifiers() — recursive identifier collection

**4. `ObjectPropertyExtractor.ts`** — Static utility class (~200 lines)
- extractObjectProperties() — recursive

**5. `ArrayElementExtractor.ts`** — Static utility class (~160 lines)
- extractArrayElements() — recursive, calls ObjectPropertyExtractor

**6. `MutationDetector.ts`** — Static utility class (~200 lines)
- detectArrayMutation()
- detectObjectAssign()

### What stays in CallExpressionVisitor.ts

- Class declaration, constructor (~10 lines)
- extractMemberExpressionName (static, 24 lines) — used externally
- getFunctionScopeId (51 lines) — tightly coupled to visitor
- getHandlers() (358 lines) — the actual visitor handlers
- Imports and wiring

**Estimated main file size: ~470 lines** (within 500 target)

### Problem: getHandlers() is 358 lines

Even with extractions, main file will be ~470 lines — close to limit. The `getHandlers()` method itself is huge. But it doesn't split naturally — it's one visitor definition with CallExpression + NewExpression. Breaking it into sub-handlers would add unnecessary complexity for only 2 handlers.

Alternative: extracting inline handler logic into private methods:
- `handleDirectCall()` (~40 lines)
- `handleMethodCall()` (~80 lines)
- `handleNestedMethodCall()` (~70 lines)
- `handleNewIdentifier()` (~30 lines)
- `handleNewMemberExpression()` (~40 lines)

This would reduce `getHandlers()` to ~100 lines of delegation, and the private methods would be ~260 lines. Total main file: ~420 lines.

## Execution Steps

### Step 1: Snapshot tests (safety net)
- Ensure existing snapshot tests cover CallExpressionVisitor output
- If not, add targeted snapshot tests

### Step 2: Extract types → `call-expression-types.ts`
- Move all 8 interfaces
- Update imports in CallExpressionVisitor.ts
- Build + test

### Step 3: Extract helpers → `call-expression-helpers.ts`
- Move GRAFEMA_IGNORE_PATTERN, checkNodeComments, getGrafemaIgnore
- Update imports
- Build + test

### Step 4: Extract ObjectPropertyExtractor
- Move extractObjectProperties to static class
- Accept scopeTracker as parameter instead of `this.scopeTracker`
- Build + test

### Step 5: Extract ArrayElementExtractor
- Move extractArrayElements to static class
- Build + test

### Step 6: Extract MutationDetector
- Move detectArrayMutation, detectObjectAssign to static class
- Both need scopeTracker + collections — pass as parameters
- Build + test

### Step 7: Extract ArgumentExtractor
- Move extractArguments, extractIdentifiers to static class
- Delegates to ObjectPropertyExtractor, ArrayElementExtractor
- Build + test

### Step 8: Extract handler methods from getHandlers()
- Create private methods for each handler branch
- getHandlers() becomes pure delegation
- Build + test

### Step 9: Final verification
- `pnpm build && node --test --test-concurrency=1 'test/unit/*.test.js'`
- Verify main file < 500 lines
- Verify no method > 50 lines

## File size estimates

| File | Lines |
|------|-------|
| CallExpressionVisitor.ts | ~420 |
| call-expression-types.ts | ~170 |
| call-expression-helpers.ts | ~80 |
| ArgumentExtractor.ts | ~280 |
| ObjectPropertyExtractor.ts | ~200 |
| ArrayElementExtractor.ts | ~160 |
| MutationDetector.ts | ~200 |
| **Total** | ~1,510 |

## Risks

1. **Circular deps** — ObjectPropertyExtractor ↔ ArrayElementExtractor call each other recursively. Solution: pass the other extractor as a callback/parameter.
2. **Collections threading** — extractors need collections + counters. Solution: pass as parameters (already method params).
3. **ScopeTracker threading** — mutation detector + object properties need scopeTracker. Solution: pass as parameter.

## Commit Strategy

One commit per extraction step (steps 2-8), each atomic and passing tests.

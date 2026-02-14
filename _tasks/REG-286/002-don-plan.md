# Don Melton - Technical Plan for REG-286

## Executive Summary

REG-286 is 70% complete. REG-311 already added async rejection tracking using `RejectionPatternInfo` infrastructure. We need to extend this existing pattern to handle **synchronous throws** for all functions (not just async).

**Key insight:** The THROWS edge infrastructure should mirror REJECTS edge implementation from REG-311. Same data collection pattern, same edge creation pattern, just different edge type.

## What Already Works

1. **Data Collection Infrastructure (REG-311)**
   - `RejectionPatternInfo` interface exists and collects error class names
   - `ThrowStatement` visitor (line 3899) already extracts error class from:
     - `throw new Error()` → error class name
     - `throw variable` → micro-trace to constructor
   - Currently only collects for ASYNC functions

2. **Edge Creation Pattern (REG-311)**
   - `bufferRejectionEdges()` in GraphBuilder creates REJECTS edges
   - Pattern: FUNCTION --[REJECTS]--> CLASS (error class)
   - Uses computeSemanticId to target CLASS nodes

3. **Metadata Storage (REG-311)**
   - `ControlFlowMetadata.canReject` exists for async rejection tracking
   - `ControlFlowMetadata.hasThrow` already tracks throw presence (REG-267)
   - `rejectedBuiltinErrors: string[]` stores error class names

## What's Missing

1. **Throw pattern collection for SYNC functions**
   - Current: only async functions populate `rejectionPatterns` for throws
   - Need: collect throw patterns for ALL functions

2. **THROWS edges**
   - `THROWS` edge type declared but never created
   - Need: `bufferThrowsEdges()` method (mirror `bufferRejectionEdges`)

3. **`canThrow` metadata**
   - Currently: only `hasThrow: boolean` exists
   - Need: `canThrow: boolean` to match `canReject` pattern
   - Need: `thrownBuiltinErrors: string[]` to match `rejectedBuiltinErrors` pattern

## High-Level Approach

### Step 1: Extend ThrowStatement visitor to collect ALL throws
**File:** `JSASTAnalyzer.ts` line ~3899

Change: Remove `if (isAsyncFunction)` guard. Collect throw patterns for ALL functions.

**New data structure:** `ThrowPatternInfo` (similar to RejectionPatternInfo but for THROWS)
- Same fields as RejectionPatternInfo
- Different pattern types: `sync_throw`, `variable_traced`, etc.

**Tradeoff:** Reuse RejectionPatternInfo vs create separate ThrowPatternInfo?
- **Recommendation:** Create separate `throwPatterns` collection
- **Rationale:** Clear separation of concerns (THROWS vs REJECTS), easier to query

### Step 2: Add canThrow metadata to ControlFlowMetadata
**File:** `packages/core/src/plugins/analysis/ast/types.ts` line ~189

Add fields mirroring the REG-311 pattern:
```typescript
canThrow?: boolean;
thrownBuiltinErrors?: string[];
```

### Step 3: Create bufferThrowsEdges() method
**File:** `GraphBuilder.ts`

Clone `bufferRejectionEdges()` method (line 3453), change:
- Edge type: `REJECTS` → `THROWS`
- Input: `throwPatterns` instead of `rejectionPatterns`

Pattern: FUNCTION --[THROWS]--> CLASS (error class)

### Step 4: Populate canThrow metadata
**File:** `JSASTAnalyzer.ts` line ~4837

After computing `canReject`, compute `canThrow`:
```typescript
const canThrow = throwPatterns.length > 0;
const thrownBuiltinErrors = [...new Set(
  throwPatterns
    .filter(p => p.errorClassName !== null)
    .map(p => p.errorClassName!)
)];
```

### Step 5: Wire up edge creation
**File:** `GraphBuilder.ts`

Call `bufferThrowsEdges(functions, throwPatterns)` after other edge buffering.

## Key Decisions

### Decision 1: Separate throwPatterns vs reuse rejectionPatterns?
**Choice:** Separate collections

**Rationale:**
- Clear semantic distinction (sync vs async errors)
- Separate edge types (THROWS vs REJECTS)
- Easier to query: "what can this function throw?" vs "what can it reject?"
- Pattern already established by REG-311

### Decision 2: What is the edge target?
**Choice:** CLASS node representing the error class

**Example:**
```javascript
function validate(x) {
  throw new ValidationError('bad');
}
```
Creates: `FUNCTION[validate] --[THROWS]--> CLASS[ValidationError]`

**Why CLASS?**
- Matches REJECTS edge pattern (consistency)
- Enables queries like "show all functions that throw TypeError"
- Works for both user-defined and built-in errors (dangling refs for built-ins)

### Decision 3: Track ALL throws or only NEW expressions?
**Choice:** Track all, use pattern types to distinguish

**Pattern types:**
- `sync_throw` - `throw new Error()`
- `variable_traced` - `throw err` where err traced to constructor
- `variable_parameter` - `throw param` (parameter forwarding)
- `variable_unknown` - `throw x` (couldn't trace)

**Rationale:** Matches existing RejectionPatternInfo design, enables querying by certainty level

## Risk Assessment

**LOW RISK** - This is a straightforward extension of existing REG-311 infrastructure.

**Mitigations:**
- Reuse proven patterns from REG-311
- No architectural changes
- Isolated to throw tracking subsystem
- Test coverage mirrors REG-311 tests

**Complexity:** O(t) where t = throw statements. Same as REG-311 rejection tracking.

## Alignment Check

**Does this align with "AI should query the graph, not read code"?**
YES. After this change, AI can query:
- "Which functions throw ValidationError?" → `MATCH (f:FUNCTION)-[:THROWS]->(c:CLASS {name: 'ValidationError'})`
- "What errors can this function throw?" → Check `thrownBuiltinErrors` metadata or follow THROWS edges
- "Show me all error sources in this module" → Query THROWS edges + REJECTS edges

**No architectural gaps:** Uses existing graph primitives, extends proven pattern.

## Next Steps

Joel: Expand this into detailed implementation spec with:
1. Exact interface definition for ThrowPatternInfo
2. Line-by-line changes to ThrowStatement visitor
3. Test plan covering sync/async, traced/untraced patterns

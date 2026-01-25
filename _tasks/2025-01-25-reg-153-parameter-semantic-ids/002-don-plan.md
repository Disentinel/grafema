# Don Melton - Tech Lead Analysis

## REG-153: Use Semantic IDs for PARAMETER Nodes

**Question:** Is this the RIGHT thing to do?

**Verdict:** Yes. This is not just a cleanup task - it's fixing a fundamental design inconsistency that violates our core principle: **AI should query the graph, not read code.**

---

## 1. Current State Analysis

### The Problem

PARAMETER nodes use legacy line-based IDs:
```typescript
const paramId = `PARAMETER#${param.name}#${file}#${line}:${index}`;
```

This creates **unstable identifiers** - adding a comment or blank line above a function changes all parameter IDs downstream.

### Where PARAMETER IDs Are Created (3 places)

1. **`FunctionVisitor.ts`** (lines 219-274)
   - Local `createParameterNodes` function (NOT the shared utility!)
   - Creates legacy IDs: `PARAMETER#name#file#line:index`

2. **`createParameterNodes.ts`** (shared utility)
   - Used by ClassVisitor for class methods/constructors
   - Creates legacy IDs: `PARAMETER#name#file#line:index`

3. **`ASTWorker.ts`** (lines 419-432) - **ALREADY CORRECT!**
   - Uses `computeSemanticId('PARAMETER', param.name, scopeTracker.getContext(), { discriminator: index })`
   - This is the parallel/worker code path

### Critical Insight

There are **TWO code paths** for AST analysis:
1. **Sequential path** (FunctionVisitor/ClassVisitor) - uses legacy IDs
2. **Parallel path** (ASTWorker) - uses semantic IDs

This means the same codebase analyzed with `--parallel` vs sequential produces **different PARAMETER IDs**. This is a serious consistency bug.

---

## 2. Places That Need to Change

### Primary Changes

| File | Current | Change Needed |
|------|---------|---------------|
| `FunctionVisitor.ts` | Local `createParameterNodes` with legacy IDs | Use semantic IDs via `computeSemanticId` |
| `createParameterNodes.ts` | Shared utility with legacy IDs | Accept `ScopeTracker`, generate semantic IDs |
| `ClassVisitor.ts` | Calls shared utility | Pass `ScopeTracker` to utility |

### Key Observation

FunctionVisitor has its **own local** `createParameterNodes` function (lines 219-274) that duplicates the shared utility. This is tech debt from REG-134 that was noted but not addressed.

**Fix path:**
1. Enhance shared `createParameterNodes.ts` to accept `ScopeTracker` and generate semantic IDs
2. Remove local duplicate in FunctionVisitor
3. Update all call sites to pass `ScopeTracker`

---

## 3. Consumers That Parse PARAMETER IDs

I searched for consumers that parse `#`-separated IDs. Found:

### GraphBuilder.ts (lines 872, 963, 1444)

```typescript
const varParts = variableId.split('#');
const varFile = varParts.length >= 3 ? varParts[2] : null;
```

This pattern is used for VARIABLE/CONSTANT IDs, NOT for PARAMETER IDs. Parameters are looked up by:
- `file` + `name` combination (paramLookup map)
- NOT by parsing the ID

### No Direct Consumers of PARAMETER ID Format

The code queries parameters by:
- Node type: `n.type === 'PARAMETER'`
- Name attribute: `n.name === 'paramName'`
- Parent function: via `HAS_PARAMETER` edge

**This means we can safely change the ID format.**

---

## 4. High-Level Approach

### Phase 1: Update Shared Utility (SINGLE CHANGE POINT)

Modify `createParameterNodes.ts` signature:

```typescript
export function createParameterNodes(
  params: Node[],
  functionId: string,
  file: string,
  line: number,
  parameters: ParameterInfo[],
  scopeTracker?: ScopeTracker  // NEW: optional for backward compat
): void {
  params.forEach((param, index) => {
    const name = extractParamName(param);
    if (!name) return;

    // Generate ID: semantic if scopeTracker provided, legacy otherwise
    const paramId = scopeTracker
      ? computeSemanticId('PARAMETER', name, scopeTracker.getContext(), { discriminator: index })
      : `PARAMETER#${name}#${file}#${line}:${index}`;  // Fallback

    parameters.push({
      id: paramId,
      semanticId: scopeTracker ? paramId : undefined,  // Populate semanticId field
      // ... rest of fields
    });
  });
}
```

### Phase 2: Update Call Sites

1. **ClassVisitor.ts**: Already has `scopeTracker` in scope, just pass it to `createParameterNodes`
2. **FunctionVisitor.ts**: Remove local duplicate, import and use shared utility with `scopeTracker`

### Phase 3: Verify Parity

Run `ParallelSequentialParity.test.js` to ensure sequential and parallel paths produce identical IDs.

---

## 5. Concerns and Risks

### Risk 1: Breaking Existing Graphs
- **Impact:** Saved graphs with legacy PARAMETER IDs won't match new semantic IDs
- **Mitigation:** This is expected for any ID format change. Document in migration notes.

### Risk 2: Incremental Analysis Invalidation
- **Impact:** First analysis after change will recreate all PARAMETER nodes
- **Mitigation:** Acceptable one-time cost for long-term stability

### Risk 3: Tests Expecting Legacy IDs
- **Impact:** Some tests may assert specific ID formats
- **Mitigation:** Tests should use semantic matching (`attr(X, "name", "foo")`), not ID parsing

---

## 6. Alignment with Project Vision

### Why This Matters

From CLAUDE.md:
> **AI should query the graph, not read code.**
> If reading code gives better results than querying Grafema - that's a product gap.

Unstable IDs are a **query gap**:
- AI can't reliably reference the same parameter across commits
- Diffs are noisy with phantom changes
- Cross-reference queries break after unrelated edits

Semantic IDs fix this by encoding **meaning** (where in the scope hierarchy) rather than **location** (line number).

### Format

Current legacy: `PARAMETER#userId#src/auth.js#42:0`
Semantic: `src/auth.js->login->PARAMETER->userId#0`

The semantic format tells you:
- File: `src/auth.js`
- Scope: inside `login` function
- Type: `PARAMETER`
- Name: `userId`
- Discriminator: `#0` (first parameter with this name in scope)

This is **more queryable** for AI agents.

---

## 7. Execution Summary

| Step | What | Who |
|------|------|-----|
| 1 | Write tests that assert semantic ID format for parameters | Kent |
| 2 | Update `createParameterNodes.ts` to accept ScopeTracker | Rob |
| 3 | Remove duplicate in FunctionVisitor, use shared utility | Rob |
| 4 | Update ClassVisitor calls to pass ScopeTracker | Rob |
| 5 | Run ParallelSequentialParity tests | Rob |
| 6 | Review ID format consistency | Kevlin |
| 7 | Architecture alignment check | Linus |

**Estimated scope:** 3 files changed, ~50 lines modified

---

## Recommendation

**PROCEED.** This is a clean refactoring that:
1. Fixes a real bug (parallel/sequential inconsistency)
2. Aligns with project vision (semantic > positional)
3. Uses existing infrastructure (ScopeTracker, computeSemanticId)
4. Has minimal blast radius (shared utility is single change point)

The fact that ASTWorker already does this correctly proves the pattern works.

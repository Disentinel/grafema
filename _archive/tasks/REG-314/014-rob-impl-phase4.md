# Rob Pike - AnnotationSuggester Implementation (REG-314 Phase 4)

**Date:** 2026-02-03
**Status:** COMPLETE - All 19 tests pass

---

## Summary

Implemented `AnnotationSuggester` class that analyzes the graph to identify which function call patterns should be annotated with cardinality metadata. The implementation follows CardinalityEnricher patterns for consistency.

---

## Implementation Details

### File: `/Users/vadimr/grafema-worker-1/packages/core/src/core/AnnotationSuggester.ts`

### Algorithm

1. **Find LOOP nodes** - Query graph for all LOOP nodes
2. **Get ITERATES_OVER edges** - For each loop, get edges to iteration targets
3. **Check annotation status** - If edge has `metadata.cardinality`, it's already annotated
4. **Trace to CALL** - Follow DERIVES_FROM edge from variable to source CALL node
5. **Build pattern** - Format as `object.method` or just `functionName`
6. **Accumulate** - Group by pattern, count occurrences, collect unique files
7. **Infer scale** - Apply naming heuristics for suggestedScale
8. **Sort and limit** - Order by occurrences descending, apply topN limit
9. **Calculate coverage** - `annotatedLoops / totalLoops * 100`

### Key Design Decisions

1. **Reused CardinalityEnricher heuristics** - Same regex patterns for consistency:
   - `query*`, `list*`, `fetch*`, `getAll*` -> `nodes` scale
   - `find*`, `get*ById` -> `constant` scale

2. **File deduplication** - Use `Set<string>` for files per pattern to avoid duplicates

3. **Pattern without DERIVES_FROM** - Silently skip (literal arrays, etc.) - no pattern to suggest

4. **Unknown patterns** - Include in candidates but with `suggestedScale: null`

5. **Coverage calculation** - 0% if no loops, otherwise `Math.round((annotated/total) * 100)`

### Interface Structure

```typescript
interface SuggestionCandidate {
  pattern: string;           // "graph.queryNodes" or "fetchUsers"
  occurrences: number;       // Count of unannotated loops
  files: string[];           // Unique files containing these loops
  suggestedScale: ScaleCategory | null;  // Based on naming heuristics
}

interface AnnotationSuggestionResult {
  candidates: SuggestionCandidate[];
  totalLoops: number;
  annotatedLoops: number;
  coveragePercent: number;
}
```

---

## Test Results

```
# tests 19
# pass 19
# fail 0
```

All test groups pass:
- Empty graph
- Loops with cardinality (already annotated)
- Multiple loops same pattern
- Unknown call patterns
- Naming heuristic match
- Coverage calculation
- Sorting and limiting results

---

## Commit

```
feat(core): Implement AnnotationSuggester for cardinality suggestions

Analyzes graph to suggest which functions should be annotated with
cardinality based on loop iteration frequency.

REG-314
```

Commit hash: 2e7ca8f

---

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/core/AnnotationSuggester.ts` | Implementation (~260 lines) |
| `packages/core/src/index.ts` | Export added (Kent's work, included in commit) |
| `test/unit/core/AnnotationSuggester.test.js` | Tests (Kent's work, included in commit) |

---

## Next Steps

CLI command `grafema annotate --suggest` needs implementation in:
- `packages/cli/src/commands/annotate.ts`

This will use AnnotationSuggester and format output as specified in Don's plan.

---

-- Rob Pike

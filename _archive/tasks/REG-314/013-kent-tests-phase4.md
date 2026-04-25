# Kent Beck - AnnotationSuggester Tests (REG-314 Phase 4)

**Date:** 2026-02-03
**Status:** COMPLETE - Tests ready, placeholder created

---

## Summary

Created comprehensive test suite for `AnnotationSuggester` following TDD methodology. Tests are written first and currently fail with "not implemented" - exactly as expected for the red phase.

---

## Test File

`/Users/vadimr/grafema-worker-1/test/unit/core/AnnotationSuggester.test.js`

### Test Coverage: 19 tests across 7 groups

| Group | Tests | Description |
|-------|-------|-------------|
| Empty graph | 1 | Returns empty candidates, 0 coverage |
| Loops with cardinality | 2 | Already annotated loops excluded |
| Multiple loops same pattern | 2 | Counted correctly, files deduplicated |
| Unknown call patterns | 2 | Included but no suggestedScale |
| Naming heuristic match | 7 | query*, list*, fetch*, getAll*, find*, get*ById |
| Coverage calculation | 3 | 0%, 100%, mixed percentages |
| Sorting and limiting | 2 | Sort by occurrences, respect topN |

---

## Placeholder Implementation

`/Users/vadimr/grafema-worker-1/packages/core/src/core/AnnotationSuggester.ts`

### Exports Added to Index

```typescript
export { AnnotationSuggester } from './core/AnnotationSuggester.js';
export type { SuggestionCandidate, AnnotationSuggestionResult, AnnotationSuggesterOptions } from './core/AnnotationSuggester.js';
```

### Interface Definitions

```typescript
interface SuggestionCandidate {
  pattern: string;
  occurrences: number;
  files: string[];
  suggestedScale: ScaleCategory | null;
}

interface AnnotationSuggestionResult {
  candidates: SuggestionCandidate[];
  totalLoops: number;
  annotatedLoops: number;
  coveragePercent: number;
}

interface AnnotationSuggesterOptions {
  topN?: number;
}
```

---

## MockGraphBackend

Reused pattern from CardinalityEnricher tests:

```javascript
class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }

  async *queryNodes(filter) { /* yield LOOP nodes */ }
  async getOutgoingEdges(nodeId, types) { /* return edges */ }
  async getNode(id) { /* return node by id */ }
}
```

Supports:
- `queryNodes()` - returns LOOP nodes for iteration
- `getOutgoingEdges()` - returns ITERATES_OVER edges
- `getNode()` - returns VARIABLE/CALL nodes for tracing

---

## Test Results (Current State)

```
# tests 19
# pass 0
# fail 19
```

All tests fail with: `AnnotationSuggester.analyze() not implemented`

This is the correct TDD red phase.

---

## Key Test Scenarios

### 1. Empty Graph
```javascript
it('should return empty candidates and 0 coverage for empty graph')
```
Verifies graceful handling when graph has no LOOP nodes.

### 2. Annotated Loops Excluded
```javascript
it('should not include loops with cardinality in suggestions')
```
Loops with existing cardinality metadata are counted but not suggested.

### 3. Pattern Counting
```javascript
it('should count multiple loops for same pattern correctly')
```
Three loops calling `db.fetchUsers()` should report `occurrences: 3`.

### 4. File Deduplication
```javascript
it('should deduplicate files when same file has multiple loops')
```
Two loops in `api.ts` should have `files: ['api.ts']` (not duplicated).

### 5. Naming Heuristics
```javascript
it('should suggest "nodes" scale for query* pattern')
it('should suggest "constant" scale for find* pattern')
```
Uses same heuristics as CardinalityEnricher for consistency.

### 6. Coverage Calculation
```javascript
it('should calculate coverage percentage correctly')
// 4 loops: 1 annotated, 3 unannotated = 25% coverage
```

### 7. Sorting
```javascript
it('should sort candidates by occurrences (highest first)')
```
Pattern with 10 occurrences should appear before pattern with 5.

### 8. Top N Limit
```javascript
it('should respect top N limit', async () => {
  const result = await suggester.analyze(graph, { topN: 3 });
  assert.strictEqual(result.candidates.length, 3);
})
```

---

## Ready for Implementation

Rob can now implement `AnnotationSuggester.analyze()` to make these tests pass.

Algorithm from plan:
1. Find all LOOP nodes via `queryNodes({ type: 'LOOP' })`
2. For each LOOP, get ITERATES_OVER edges
3. Check if edge has cardinality metadata (annotated vs unannotated)
4. Trace to CALL node via VARIABLE -> DERIVES_FROM -> CALL
5. Build call pattern string (object.method or functionName)
6. Group by pattern, count occurrences, collect files
7. Apply naming heuristics for suggestedScale
8. Sort by occurrences descending, limit to topN

---

-- Kent Beck

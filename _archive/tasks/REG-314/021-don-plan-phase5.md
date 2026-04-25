# Don Melton's Plan - REG-314 Phase 5: Escape Hatches

## Goal

`// @grafema-ignore cardinality` comment before loop skips cardinality enrichment.

## Design

1. **Comment syntax:** `// @grafema-ignore cardinality` (line comment only)
2. **Scope:** Next line only (like eslint-disable-next-line)
3. **Implementation:** Store `ignoreCardinality: true` on LOOP node during analysis

## Implementation Flow

```
JSASTAnalyzer → detects @grafema-ignore comment → sets ignoreCardinality: true
GraphBuilder → stores flag on LOOP node metadata
CardinalityEnricher → skips loops with ignoreCardinality: true
```

## Files to Modify

| File | Change |
|------|--------|
| `packages/types/src/nodes.ts` | Add `ignoreCardinality?: boolean` to LoopNodeRecord |
| `packages/core/src/plugins/analysis/ast/types.ts` | Add to LoopInfo interface |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Add `hasGrafemaIgnore()` helper |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Pass flag to LOOP node |
| `packages/core/src/plugins/enrichment/CardinalityEnricher.ts` | Skip ignored loops |

## Test Scenarios

1. Loop with ignore comment → skipped
2. Loop without comment → processed
3. Wrong rule name → not skipped
4. Nested loops → only ignored loop skipped

## Acceptance Criteria

- [ ] `// @grafema-ignore cardinality` skips loop
- [ ] Flag visible on LOOP node metadata
- [ ] Unit tests pass

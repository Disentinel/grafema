# Don Melton's Plan - REG-314 Phase 4: CLI Annotation Suggestions

## Goal

`grafema annotate --suggest` - help users identify which functions should be annotated with cardinality.

## Command Structure

```bash
grafema annotate --suggest             # Show suggestions
grafema annotate --suggest --json      # JSON output
grafema annotate --suggest --verbose   # Show file locations
grafema annotate --suggest --top 20    # Limit results (default: 10)
```

## Algorithm

```
For each LOOP node:
  Get ITERATES_OVER edges
  For each edge:
    Get target VARIABLE node
    Trace DERIVES_FROM to source CALL node
    Extract call pattern (object.method or functionName)
    Record: { pattern, file, line, hasCardinality }

Group by pattern
Sort by count (descending)
Return top N without cardinality
```

## Output Format

```
Cardinality Annotation Suggestions
==================================

Coverage: 12 of 47 loops have cardinality (25%)

Top unannotated call patterns:

  1. graph.queryNodes() - 23 loop iterations
     Files: packages/core/src/plugins/enrichment/*.ts
     Suggested scale: nodes

  2. db.fetchUsers() - 15 loop iterations
     Files: src/api/*.ts
     Suggested scale: nodes

Add to .grafema/cardinality.yaml:
  entryPoints:
    - pattern: "graph.queryNodes"
      returns: nodes
```

## Implementation Files

| File | Purpose |
|------|---------|
| `packages/core/src/core/AnnotationSuggester.ts` | Core analysis logic |
| `packages/cli/src/commands/annotate.ts` | CLI command |
| `test/unit/core/AnnotationSuggester.test.ts` | Tests |

## Data Model

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
```

## Dependencies

- Uses CardinalityEnricher's naming heuristics
- Uses RFDBServerBackend for graph queries
- **Does NOT need attr_edge()** (Phase 3 blocker)

## Estimated Effort

- AnnotationSuggester: 1 day
- CLI command: 0.5 day
- Tests: 0.5 day
- **Total: 2 days**

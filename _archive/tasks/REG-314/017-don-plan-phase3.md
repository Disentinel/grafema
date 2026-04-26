# Don Melton's Plan - REG-314 Phase 3: Standard Datalog Rules Library

## Design Decision: YAML-Based Include System

Users reference standard rules via `uses` directive in `guarantees.yaml`:

```yaml
uses:
  - standard:n-squared-same-scale
  - standard:nodes-in-nodes

guarantees:
  - id: "no-n-squared-enrichers"
    uses: "standard:n-squared-same-scale"
    governs: ["packages/core/src/plugins/enrichment/**"]
```

## Standard Rules Library

Location: `packages/core/src/guarantees/standard-rules.yaml`

### Rules Included

1. **n-squared-same-scale** - Nested loops both at same cardinality scale
2. **unbounded-enricher-iteration** - Unbounded iterations in enrichers
3. **nodes-in-nodes** - Nested loops both at nodes scale (10M × 10M)
4. **unfiltered-large-iteration** - Loop over nodes-scale without filtering

### Example Rule

```yaml
nodes-in-nodes:
  description: "Nested loops both at nodes scale (10M x 10M potential)"
  rule: |
    violation(Outer, Inner, File, Line) :-
      node(Outer, "LOOP"),
      node(Inner, "LOOP"),
      edge(Outer, Inner, "CONTAINS"),
      edge(Outer, Coll1, "ITERATES_OVER"),
      edge(Inner, Coll2, "ITERATES_OVER"),
      attr_edge(Outer, Coll1, "ITERATES_OVER", "cardinality.scale", "nodes"),
      attr_edge(Inner, Coll2, "ITERATES_OVER", "cardinality.scale", "nodes"),
      attr(Outer, "file", File),
      attr(Outer, "line", Line).
  severity: error
```

## Implementation Files

| File | Purpose |
|------|---------|
| `packages/core/src/guarantees/standard-rules.yaml` | Rules library |
| `packages/core/src/guarantees/index.ts` | Library loader |
| `packages/core/src/core/GuaranteeManager.ts` | Add `uses` support |
| `packages/cli/src/commands/check.ts` | Add `--list-standard-rules` |
| `test/unit/guarantees/standard-rules.test.js` | Tests |

## Acceptance Criteria

- [ ] Standard rules library exists
- [ ] `uses` directive works in guarantees.yaml
- [ ] At least 4 standard rules
- [ ] Tests verify rules detect violations
- [ ] CLI lists available standard rules

## Estimated Effort: 3 days

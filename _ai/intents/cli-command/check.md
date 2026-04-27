---
noCapture: true
whenToUse: |
  CI gate. Runs every guarantee declared in `.grafema/guarantees.yaml`
  against the current graph and exits non-zero if any are violated.
  Use as the final step in your pipeline to fail builds when an
  architectural rule is broken (e.g., "no SQL inside HTTP handlers").
seeAlso:
  - mcp:tool:check_guarantees
  - mcp:tool:create_guarantee
  - mcp:tool:list_guarantees
gotchas:
  - Empty `.grafema/guarantees.yaml` → exits 0 with a no-op message.
    Add guarantees via the MCP tool `create_guarantee` or hand-edit.
  - Each guarantee is a Datalog rule; if a predicate is unknown the
    rule is skipped with a warning rather than crashing.
---

## Run all guarantees

```sh
grafema check
```

```
{captured: check-all}
```

## List available diagnostic categories

```sh
grafema check --list-categories
```

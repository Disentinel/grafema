---
whenToUse: |
  Surfaces FEATURE-level cross-modality insights. Today: `--duplicates`
  lists groups of FEATUREs (CLI commands, MCP tools, HTTP routes,
  vscode commands, package exports) that share an identical BEHAVIOR
  hash — i.e., "this CLI command and this MCP tool are thin wrappers
  around the same library function." Useful for finding consolidation
  opportunities or confirming intentional cross-modality design.
seeAlso:
  - cli:command:export
  - mcp:tool:find_shared_behaviors
gotchas:
  - Empty result on small projects with single-modality features —
    you need cross-modality to see anything. On Grafema itself: 0
    clusters at the time of writing.
---

## Find duplicate behaviors

```sh
grafema features --duplicates
```

```
{captured: features-dup}
```

## JSON output

```sh
grafema features --duplicates --json
```

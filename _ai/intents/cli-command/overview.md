---
whenToUse: |
  Project-level dashboard: file count, node-type counts, edge counts,
  feature counts, ISSUE summary, METRIC summary. Use after `analyze`
  to confirm the analysis covered what you expected — if `MODULE: 0`
  appears, your config's `include` glob isn't matching anything.
seeAlso:
  - cli:command:stats
  - cli:command:doctor
  - mcp:tool:get_stats
gotchas:
  - Counts include diagnostic node types (METRIC, ISSUE) — not just
    code. Subtract them if you want a "pure code" total.
---

## Project-wide overview

```sh
grafema overview
```

```
{captured: overview-output}
```

## JSON output for scripting

```sh
grafema overview --json
```

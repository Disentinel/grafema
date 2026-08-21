---
whenToUse: |
  The unified transitive-traversal tool. Set `along` to pick what to follow:
  - "data"    — data flow (ASSIGNED_FROM, PASSES_ARGUMENT, FLOWS_INTO).
                Forward: "where does this value flow next?" Backward: "where
                does it come from?" Use for taint analysis, "is this user
                input ever logged", "is the password hashed before storage".
  - "calls"   — the call graph (CALLS, CALLS_REMOTE), incl. cross-language
                hops. "What does this call / who calls this?"
  - "effects" — transitive side effects (IO, MUTATION, THROW…) via effects-db.
  - "alias"   — an alias chain back to its source (const fn = obj.method).
                Requires `file`.
  - "edges"   — generic BFS over given `edge_types` (impact analysis,
                dependency trees, reachability). Requires edge_types.
  Set `direction`: "forward" (default), "backward", or "both"
  (data/calls/edges). Replaces trace_dataflow / trace_calls / trace_effects /
  trace_alias / traverse_graph — they are now `along` modes of one tool.
seeAlso:
  - mcp:tool:find_calls
  - mcp:tool:get_node
  - cli:command:wtf
gotchas:
  - Start with `max_depth: 5` and increase if the trace truncates. Going to
    20 on a large project may take seconds.
  - Cross-process flows (HTTP, queue messages) are surfaced via
    `CALLS_REMOTE` bridges only when the analyzer recognized the library —
    use the bridge-detection list to verify coverage.
  - For along="edges" against the knowledge graph, set `graph: "knowledge"`
    and pass relation names in `edge_types`.
---

## Forward data trace from user input

```json
{ "source": "userInput", "along": "data", "direction": "forward" }
```

## Backward data trace to find sources

```json
{ "source": "response", "along": "data", "direction": "backward", "max_depth": 7 }
```

## Who calls this (call graph, backward)

```json
{ "source": "handleRequest", "along": "calls", "direction": "backward" }
```

## Transitive side effects of a function

```json
{ "source": "processOrder", "along": "effects" }
```

## Impact analysis over import edges

```json
{ "source": "<modId>", "along": "edges", "edge_types": ["IMPORTS_FROM"], "max_depth": 10 }
```

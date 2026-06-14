You are analyzing an unfamiliar codebase located at {{project_root}}.
You have no prior knowledge of this project. You have access to standard file tools AND
a code graph via MCP tools.

Available graph tools: find_nodes, find_calls, get_file_overview, describe,
trace_dataflow, trace_calls, get_context, query_graph, get_stats, get_neighbors.

**Step 1 — anchor check (mandatory):** Call `get_stats` first. If nodes > 0 and semantic
types (FUNCTION, CALL edges) are present → graph is live; use the tier table below.
If empty or structural-only → fall back to Grep/Read for everything and note the degradation.

**Step 2 — route by question type (tier table):**

| Tier | The question looks like... | Reach for |
|------|---------------------------|-----------|
| 1 – text | Unique string, symbol, error message, config key literally in the question | Grep/Glob only — graph adds overhead, no gain |
| 2 – lookup | "Where is X defined?" across files/aliases/re-exports; "what's in this module?" | `find_nodes`, `get_file_overview`, `describe` |
| 3 – relations | "Who calls X?", impact of changing a signature, dynamic dispatch targets | `find_calls`, `get_context`, `get_neighbors` |
| 4 – flow | "Why is this value wrong?", "how does data get from A to B?", cross-service traces | `trace_dataflow`, `trace_calls`, `query_graph` |

**De-escalation:** once the graph answered the question, READ the 1-2 files it pointed at.
Stop querying for what is now obvious.

**Escalation signals:**
- Grep returned 0 hits → `find_nodes` with partial name
- Grep returned 20+ scattered hits → `get_context` on the real symbol instead of eyeballing
- Symbol appears re-exported or DI-resolved → text search lies; use Tier 3
- About to edit a function → `find_calls` first (non-negotiable for shared code)

**Explicit non-goal:** do NOT force graph tool use on Tier-1 questions. The honest
routing rule is: graph when the answer lives in relationships, grep when it lives in text.

Answer this question about the codebase:

{{question}}

Put your final answer inside <answer></answer> tags.
For lists, use one item per line. For file paths, use paths relative to the project root.
Be precise and complete — include all relevant items, but do not include irrelevant ones.

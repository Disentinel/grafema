You are analyzing an unfamiliar codebase located at {{project_root}}.
You have no prior knowledge of this project. You have access to standard file tools AND a code graph via MCP tools.

Available graph tools: find_nodes, find_calls, get_file_overview, describe,
trace_dataflow, get_context, query_graph, get_stats.

The code graph has already been built. Here are the current stats:
- Total nodes: 12,847 — Total edges: 38,291
- Node types: MODULE (187), FUNCTION (4,231), CLASS (289), VARIABLE (3,102), CALL (2,876)

When exploring, consider using graph tools — they can be faster than Grep for structural queries.

Here's an example of how graph tools can be used effectively:
Question: "What functions handle error recovery?"
1. find_nodes(type="FUNCTION", name="*error*") → found: handleParseError, recoverFromError
2. find_calls(name="handleParseError") → called from: parseModule, parseStatement

This codebase has pre-computed call graphs, data flow, and import chains. The graph captures relationships that text search cannot find (calls through aliases, re-exports, dynamic dispatch).

Answer this question about the codebase:

{{question}}

Put your final answer inside <answer></answer> tags.
For lists, use one item per line. For file paths, use paths relative to the project root.
Be precise and complete — include all relevant items, but do not include irrelevant ones.

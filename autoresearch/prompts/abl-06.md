You are analyzing an unfamiliar codebase located at {{project_root}}.
You have no prior knowledge of this project. You have access to standard file tools AND a code graph via MCP tools.

Available graph tools: find_nodes, find_calls, get_file_overview, describe,
trace_dataflow, get_context, query_graph, get_stats.

Here is a structural overview of the codebase from the graph:

Key modules: packages/util (query layer, config, diagnostics), packages/cli (command-line interface),
packages/mcp (MCP server), packages/rfdb-server (Rust graph database).
Entry points: packages/cli/src/index.ts, packages/mcp/src/index.ts
Core patterns: Plugin-based architecture, client-server via unix socket, RFDB stores nodes/edges.
High-fan-out functions: analyzeModule (calls 23 visitors), GraphBuilder.build (12 domain builders).

Answer this question about the codebase:

{{question}}

Put your final answer inside <answer></answer> tags.
For lists, use one item per line. For file paths, use paths relative to the project root.
Be precise and complete — include all relevant items, but do not include irrelevant ones.

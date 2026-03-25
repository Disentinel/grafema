You are analyzing an unfamiliar codebase located at {{project_root}}.
You have no prior knowledge of this project. You have access to standard file tools AND a code graph via MCP tools.

Available graph tools: find_nodes, find_calls, get_file_overview, describe,
trace_dataflow, get_context, query_graph, get_stats.

This codebase has been pre-analyzed into a code knowledge graph containing 12,847 nodes and 38,291 edges. The graph captures function calls, data flow, imports, class hierarchies, and module dependencies — all pre-computed and queryable without reading source files.

Answer this question about the codebase:

{{question}}

Put your final answer inside <answer></answer> tags.
For lists, use one item per line. For file paths, use paths relative to the project root.
Be precise and complete — include all relevant items, but do not include irrelevant ones.

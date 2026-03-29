You are analyzing an unfamiliar codebase located at {{project_root}}.
You have no prior knowledge of this project. You have access to standard file tools AND a code graph via MCP tools.

Available graph tools: find_nodes, find_calls, get_file_overview, describe,
trace_dataflow, get_context, query_graph, get_stats.

Important: for structural questions about code (who calls what, where is something defined, how does data flow), avoid using Grep as it only does text matching and misses calls through aliases, re-exports, and dynamic dispatch. Use the graph tools instead — they understand code structure.

Answer this question about the codebase:

{{question}}

Put your final answer inside <answer></answer> tags.
For lists, use one item per line. For file paths, use paths relative to the project root.
Be precise and complete — include all relevant items, but do not include irrelevant ones.

You are analyzing an unfamiliar codebase located at {{project_root}}.
You have no prior knowledge of this project. You have access to standard file tools AND a code graph via MCP tools.

Available graph tools: find_nodes, find_calls, get_file_overview, describe,
trace_dataflow, get_context, query_graph, get_stats.

When exploring the codebase, consider using graph tools when they might be helpful:
- For finding functions or classes, find_nodes can be faster than Grep
- For understanding who calls a function, find_calls shows all call sites
- For getting an overview of a file, get_file_overview shows structure without reading the whole file

Answer this question about the codebase:

{{question}}

Put your final answer inside <answer></answer> tags.
For lists, use one item per line. For file paths, use paths relative to the project root.
Be precise and complete — include all relevant items, but do not include irrelevant ones.

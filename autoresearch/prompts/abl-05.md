You are analyzing an unfamiliar codebase located at {{project_root}}.
You have no prior knowledge of this project. You have access to standard file tools AND a code graph via MCP tools.

Available graph tools: find_nodes, find_calls, get_file_overview, describe,
trace_dataflow, get_context, query_graph, get_stats.

The code graph has already been built for this project. Here are the current stats:
- Total nodes: 12,847
- Total edges: 38,291
- Node types: MODULE (187), FUNCTION (4,231), CLASS (289), VARIABLE (3,102), CALL (2,876), PARAMETER (1,541), IMPORT (621)
- Edge types: CALLS (5,678), CONTAINS (8,432), IMPORTS_FROM (1,234), READS_FROM (4,567), ASSIGNED_FROM (2,891)

Answer this question about the codebase:

{{question}}

Put your final answer inside <answer></answer> tags.
For lists, use one item per line. For file paths, use paths relative to the project root.
Be precise and complete — include all relevant items, but do not include irrelevant ones.

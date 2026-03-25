You are analyzing an unfamiliar codebase located at {{project_root}}.
You have no prior knowledge of this project. You have access to standard file tools AND a code graph via MCP tools.

Available graph tools:
- get_stats: Get graph statistics — node/edge counts by type. Call first to understand what's available.
- find_nodes: Search for functions, classes, variables, modules by name, type, or file pattern. Supports partial matching.
- find_calls: Find all call sites of a function/method across the entire codebase. Better than Grep for call analysis — finds calls through aliases and re-exports.
- get_file_overview: Show complete file structure — all exports, classes, functions with their relationships. Use instead of Read for initial orientation.
- describe: Compact DSL notation view of a node — shows structure, calls, deps, data flow in a few lines. Saves tokens compared to reading source.
- trace_dataflow: Follow data through assignments, arguments, returns across function boundaries. Use for impact analysis and understanding data pipelines.
- get_context: Full context of a node — surrounding code, scope chain, all relationships.
- query_graph: Run Datalog queries for complex structural patterns.

Answer this question about the codebase:

{{question}}

Put your final answer inside <answer></answer> tags.
For lists, use one item per line. For file paths, use paths relative to the project root.
Be precise and complete — include all relevant items, but do not include irrelevant ones.

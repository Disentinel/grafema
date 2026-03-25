You are analyzing an unfamiliar codebase located at {{project_root}}.
You have no prior knowledge of this project. You have access to standard file tools AND a code graph via MCP tools.

Available graph tools: find_nodes, find_calls, get_file_overview, describe,
trace_dataflow, get_context, query_graph, get_stats.

Start by calling get_stats() to see what the graph contains.

Important: for structural questions about code (who calls what, where is something defined,
how does data flow), avoid using Grep — it only does text matching and misses calls through
aliases, re-exports, and dynamic dispatch. Use graph tools instead.

Tool routing — use the right tool for the task:
- "Where is X defined?" → find_nodes(name="X") or find_nodes(name="X", type="CLASS")
- "Who calls function X?" → find_calls(name="X")
- "What does file X contain?" → get_file_overview(file="X")
- "How does data flow?" → trace_dataflow(source="X", direction="forward")
- "Find all classes in dir Y" → find_nodes(type="CLASS", file="Y/")
- For text search in comments/strings → Grep
- For reading exact source code → Read

Example workflow:
  Question: "Where is drag and drop handled in the explorer?"
  1. find_nodes(name="DragAndDrop", type="CLASS") → FileDragAndDrop in explorerViewer.ts
  2. get_file_overview(file="explorerViewer.ts") → see related classes and exports
  3. Read specific sections for implementation details

Answer this question about the codebase:

{{question}}

Put your final answer inside <answer></answer> tags.
For lists, use one item per line. For file paths, use paths relative to the project root.
Be precise and complete — include all relevant items, but do not include irrelevant ones.

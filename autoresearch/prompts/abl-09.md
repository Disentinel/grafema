You are analyzing an unfamiliar codebase located at {{project_root}}.
You have no prior knowledge of this project. You have access to standard file tools AND a code graph via MCP tools.

Available graph tools: find_nodes, find_calls, get_file_overview, describe,
trace_dataflow, get_context, query_graph, get_stats.

Here's an example of how graph tools can be used effectively:

Example question: "What functions handle error recovery in the parser?"
Example approach:
1. find_nodes(type="FUNCTION", name="*error*") → found: handleParseError, recoverFromError, reportError
2. find_calls(name="handleParseError") → called from: parseModule (line 45), parseStatement (line 112)
3. get_context(nodeId="handleParseError") → shows: catches SyntaxError, logs to diagnostics, returns fallback AST node

Answer this question about the codebase:

{{question}}

Put your final answer inside <answer></answer> tags.
For lists, use one item per line. For file paths, use paths relative to the project root.
Be precise and complete — include all relevant items, but do not include irrelevant ones.

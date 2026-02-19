# User Request: REG-521

## Task
MCP server audit: improve tool descriptions + add traversal tools

## Context
Before REG-520 (SWE-bench benchmarking), audit the MCP server to ensure it's ready for AI agent consumption.

## Requirements

### 1. Improve server description
- Current: "Provides code analysis tools via Model Context Protocol" — says nothing
- Need: explain this is a code graph for navigation, impact analysis, caller tracking, data flow tracing
- Core message: "query the graph, not read code"

### 2. Improve tool descriptions (~8 tools with weak descriptions)
- `find_nodes`, `trace_dataflow`, `get_stats`, `discover_services`, `analyze_project`, `get_coverage`, `list_guarantees`, `check_guarantees`
- Add when/why/use cases following pattern of good descriptions (find_guards, get_function_details, get_context)
- Every description must be self-documenting for AI agents

### 3. Add new tools
- **`traverse_graph`** — BFS/DFS from node(s) by edge types, configurable depth/direction. Core has `bfs()` + `getOutgoing/IncomingEdges()`
- **`get_neighbors`** — direct incoming/outgoing edges of a node, simplest graph query
- **`get_node`** — get single node by semantic ID with full metadata

### 4. Agent can map code to graph
- Agent reads code, sees something on line 42 → can use `find_nodes({file, type, name})` to get semantic ID
- No need for separate `resolve_node` — semantic ID + location in find_nodes results is enough

## Acceptance Criteria
- Server description explains value proposition for AI agents
- All 24+ tool descriptions have when/why/use cases
- `traverse_graph` works with BFS mode, edge type filter, depth limit, direction
- `get_neighbors` returns edges grouped by type with connected node info
- `get_node` returns full node record by semantic ID
- All existing tests pass
- New tools have tests

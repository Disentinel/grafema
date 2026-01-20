# @grafema/mcp

> MCP server for Grafema code analysis toolkit

**Warning: This package is in early alpha stage and is not recommended for production use.**

## Installation

```bash
npm install @grafema/mcp
```

## Overview

Model Context Protocol (MCP) server that exposes Grafema's code analysis capabilities to AI assistants like Claude. Enables AI agents to query code graphs, trace data flow, and check invariants.

## Quick Start

### Running the server

```bash
npx grafema-mcp --project /path/to/your/project
```

### Claude Code configuration

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "grafema": {
      "command": "npx",
      "args": ["@grafema/mcp", "--project", "."]
    }
  }
}
```

### Claude Desktop configuration

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "grafema": {
      "command": "npx",
      "args": ["@grafema/mcp", "--project", "/path/to/project"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `query_graph` | Execute Datalog queries on the code graph |
| `find_calls` | Find all calls to a function or method |
| `trace_alias` | Trace variable aliases to their source |
| `get_value_set` | Analyze possible values of a variable |
| `trace_data_flow` | Trace data flow from source to sink |
| `check_invariant` | Verify code invariants via Datalog |
| `analyze_project` | Trigger full or incremental analysis |

## Example Queries

```
// Find all database queries
query_graph("node(X, 'db:query')")

// Trace where user input flows
trace_data_flow({ from: "req.body", file: "api/users.js" })

// Check for eval usage
check_invariant("violation(X) :- node(X, 'CALL'), attr(X, 'name', 'eval')")
```

## License

Apache-2.0

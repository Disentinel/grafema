# @grafema/mcp

> MCP server for Grafema code analysis toolkit

**Warning: This package is in beta stage and the API may change between minor versions.**

## Installation

```bash
npm install @grafema/mcp
```

## Overview

Model Context Protocol (MCP) server that exposes Grafema's code analysis capabilities to AI assistants like Claude. Enables AI agents to query code graphs, trace data flow, and check invariants — without reading source code.

## Quick Start

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

The RFDB graph database server is auto-started on first query. No manual setup needed.

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

## Available Tools (24)

### Graph Queries
| Tool | Description |
|------|-------------|
| `query_graph` | Execute Datalog queries on the code graph |
| `find_nodes` | Find nodes by type, name, or file |
| `find_calls` | Find all calls to a function or method |
| `get_stats` | Get graph statistics (node/edge counts by type) |
| `get_schema` | Get available node and edge types |

### Navigation
| Tool | Description |
|------|-------------|
| `get_function_details` | Comprehensive function details (calls, calledBy, parameters) |
| `get_file_overview` | Structured overview of all entities in a file |
| `get_context` | Deep context for a node (source code + graph neighborhood) |
| `find_guards` | Find conditional guards protecting a node |
| `read_project_structure` | Directory structure of the project |

### Data Flow
| Tool | Description |
|------|-------------|
| `trace_alias` | Trace alias chains to the original source |
| `trace_dataflow` | Trace data flow from/to a variable or expression |

### Analysis
| Tool | Description |
|------|-------------|
| `analyze_project` | Run full or incremental analysis |
| `get_analysis_status` | Current analysis status and progress |
| `get_coverage` | Analysis coverage for a path |
| `discover_services` | Discover services without full analysis |

### Guarantees
| Tool | Description |
|------|-------------|
| `check_invariant` | Check a code invariant via Datalog rule |
| `create_guarantee` | Create a Datalog-based or contract-based guarantee |
| `list_guarantees` | List all defined guarantees |
| `check_guarantees` | Run all or specific guarantees |
| `delete_guarantee` | Delete a guarantee by name |

### Utilities
| Tool | Description |
|------|-------------|
| `get_documentation` | Documentation about Grafema usage |
| `report_issue` | Report a bug to GitHub (requires GITHUB_TOKEN) |
| `write_config` | Write or update .grafema/config.yaml |

## Example Queries

```
// Find all database queries
query_graph("node(X, 'db:query')")

// Trace where user input flows
trace_dataflow({ from: "req.body", file: "api/users.js" })

// Check for eval usage
check_invariant("violation(X) :- node(X, 'CALL'), attr(X, 'name', 'eval')")
```

## Configuration

### GitHub Token (for bug reporting)

```json
{
  "mcpServers": {
    "grafema": {
      "command": "npx",
      "args": ["@grafema/mcp", "--project", "."],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

## License

Apache-2.0

# Grafema

[![CI](https://github.com/Disentinel/grafema/actions/workflows/ci.yml/badge.svg)](https://github.com/Disentinel/grafema/actions/workflows/ci.yml)

> Understand your code without reading it all

Grafema is a code analysis tool that lets you **trace data flow across your codebase**. Click on a frontend `fetch()` call, trace it to the backend handler. Click on `res.json(data)`, trace back to where that data came from.

**Frontend to backend. Code to data. In clicks.**

## What Can You Do With It?

- **Find where data comes from** - Trace any variable back to its source, across files and services
- **Trace API calls to handlers** - Click a frontend request, see the backend handler that responds
- **Understand code without reading it all** - Query the graph instead of grep-ing through thousands of files
- **Let AI navigate your code** - Claude Code can query Grafema directly via MCP, no file reading needed

## Quick Start

### 1. Analyze Your Project

```bash
# Using npx (no installation needed)
npx @grafema/cli init
npx @grafema/cli analyze
```

This creates a `.grafema/` directory with the code graph.

### 2. Query the Graph

```bash
# Find all API endpoints
npx @grafema/cli query "route /api"

# Find where a function is called from
npx @grafema/cli query "function myFunction"

# Search in specific scope
npx @grafema/cli query "variable token in authenticate"
```

### 3. Use with Claude Code (MCP Integration)

Add to your `.mcp.json` in the project root:

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

Or for Claude Desktop (`~/.config/claude/claude_desktop_config.json`):

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

Now Claude can query your codebase graph directly instead of reading files.

### 4. VS Code Extension

Interactive graph navigation for visual exploration.

**Installation (build from source):**
```bash
cd packages/vscode
pnpm install
pnpm build
# Then in VS Code: Cmd+Shift+P > "Extensions: Install from VSIX..."
# Select packages/vscode/grafema-explore-*.vsix
```

**Usage:**
- **Cmd+Shift+G** (Mac) / **Ctrl+Shift+G** (Windows/Linux) - Find the graph node at cursor
- Expand nodes to explore incoming/outgoing edges
- Click on edges to trace connections
- Click any node to jump to its source location

## Features

### Cross-Service Tracing

Trace data flow from frontend to backend and back:
```
fetch('/api/users') → Express route → handler → database query → response
```

### Data Flow Tracking

Follow how data moves through your code:
- Variable assignments and reassignments
- Function arguments to parameters
- Return values to callers
- Promise resolution chains
- Generator yields and delegations
- Update expressions (`i++`, `--count`)

### AI-First Design

Built for AI agents to navigate code efficiently:
- MCP tools for Claude integration
- Graph queries instead of file reading
- Structured navigation instead of grep
- MCP Prompts for guided onboarding
- Plugin metadata queryable via graph (no source reading needed)

### Plugin System

Extensible architecture with declarative dependencies:
- Declare `dependencies: ['ImportExportLinker']` instead of magic priority numbers
- Automatic topological ordering with cycle detection
- Batch IPC for fast analysis (10-17x speedup vs sequential calls)

## Language Support

Currently supported:
- JavaScript
- TypeScript
- Express.js (route and handler analysis)

## Packages

| Package | Description |
|---------|-------------|
| [@grafema/cli](./packages/cli) | Command-line interface |
| [@grafema/core](./packages/core) | Core analysis engine |
| [@grafema/mcp](./packages/mcp) | MCP server for AI assistants |
| [@grafema/types](./packages/types) | Type definitions |
| [grafema-explore](./packages/vscode) | VS Code extension |

## Programmatic Usage

```typescript
import { Orchestrator } from '@grafema/core';

const orchestrator = new Orchestrator({
  rootDir: './src',
});

await orchestrator.initialize();
await orchestrator.run();

// Query the graph
const handlers = await orchestrator.query('http:handler');
```

### With RFDB (Persistent Storage)

For larger codebases or persistent storage:

```typescript
import { Orchestrator, RFDBServerBackend } from '@grafema/core';

const orchestrator = new Orchestrator({
  rootDir: './src',
  backend: new RFDBServerBackend({ socketPath: '/tmp/rfdb.sock' }),
});
```

Start RFDB server:
```bash
npm install @grafema/rfdb
npx rfdb-server ./rfdb-data --socket /tmp/rfdb.sock
```

## Requirements

- Node.js >= 18

## Documentation

- [Configuration Guide](./docs/configuration.md)
- [Datalog Cheat Sheet](./docs/datalog-cheat-sheet.md)
- [Project Onboarding](./docs/project-onboarding.md)
- [CLI Reference](./packages/cli/README.md)

## License

Apache-2.0

## Author

Vadim Reshetnikov

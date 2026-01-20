# Grafema

> Static code analysis toolkit with graph-based representation

**Warning: This project is in early alpha stage (v0.1.0-alpha) and is not recommended for production use. APIs may change without notice.**

## What is Grafema?

Grafema is a code analysis toolkit that builds a graph representation of your codebase. It parses source code into an AST, extracts entities (functions, classes, variables), and tracks relationships between them (calls, imports, data flow).

Key capabilities:
- Graph-based code representation
- Data flow and alias tracking
- Datalog query support
- MCP integration for AI assistants
- Plugin architecture for custom analyzers

## Packages

| Package | Description |
|---------|-------------|
| [@grafema/types](./packages/types) | Type definitions |
| [@grafema/core](./packages/core) | Core analysis engine |
| [@grafema/mcp](./packages/mcp) | MCP server for AI assistants |
| [@grafema/rfdb-client](./packages/rfdb) | RFDB graph database client |
| [@grafema/rfdb](https://github.com/Disentinel/rfdb) | RFDB server (optional, for persistent storage) |

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Using with Claude Code

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

### Programmatic usage

```typescript
import { Orchestrator } from '@grafema/core';

// Default: in-memory backend (no persistence, works out of the box)
const orchestrator = new Orchestrator({
  rootDir: './src',
});

await orchestrator.initialize();
await orchestrator.run();
```

### With RFDB (optional, for persistent storage)

```typescript
import { Orchestrator, RFDBServerBackend } from '@grafema/core';

// Requires rfdb-server to be running
const orchestrator = new Orchestrator({
  rootDir: './src',
  backend: new RFDBServerBackend({ socketPath: '/tmp/rfdb.sock' }),
});
```

To start RFDB server:

```bash
npm install @grafema/rfdb
npx rfdb-server --socket /tmp/rfdb.sock --data-dir ./rfdb-data
```

## Requirements

- Node.js >= 18
- pnpm >= 8

## Roadmap

### Current (Alpha)
- Core analysis pipeline
- JavaScript/TypeScript support
- Basic plugin system
- MCP server integration

### Planned
- Improved data flow analysis
- Additional language support
- VSCode extension
- Incremental analysis improvements

## License

Apache-2.0

## Author

Vadim Reshetnikov

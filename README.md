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

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Using with Claude

```bash
npx @grafema/mcp --project /path/to/your/project
```

### Programmatic usage

```typescript
import { Orchestrator, RFDBServerBackend } from '@grafema/core';

const orchestrator = new Orchestrator({
  rootDir: './src',
  backend: new RFDBServerBackend({ socketPath: '/tmp/rfdb.sock' })
});

await orchestrator.initialize();
await orchestrator.run();
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

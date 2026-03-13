# Getting Started with Grafema

> **Zero to insight in 5 minutes.** Grafema builds a queryable graph of your codebase, answering questions like "who calls this function?" or "where does this data flow?" without reading thousands of lines of code.

## Prerequisites

- **Node.js 18+** (check with `node --version`)
- A JavaScript or TypeScript project with a `package.json`
- macOS (ARM or Intel) or Linux x64

## Step 1: Install

```bash
npm install grafema
```

## Step 2: Initialize (30 seconds)

In your project directory:

```bash
grafema init
```

This creates `.grafema/config.yaml` with default settings. Grafema automatically detects your project language (JS or TS) and configures file patterns.

## Step 3: Analyze (1-2 minutes)

Build the code graph:

```bash
grafema analyze
```

Expected output:
```
Analyzing project: /path/to/your-project
Analysis complete
  Nodes: 2,847
  Edges: 5,123
```

## Step 4: Explore

### What's in a file?

```bash
grafema tldr src/server.ts
```

Returns a compact DSL overview — 10-20x smaller than the source file:
```
server.ts {
  o- imports express, cors, helmet
  > calls app.listen, setupRoutes
  < reads config.port
  => writes app
}
```

### Who calls a function?

```bash
grafema who handleRequest
```

### Where does data come from?

```bash
grafema wtf req.user
```

Traces backward through assignments, function parameters, and imports to show where the value originates.

### Project overview

```bash
grafema overview
```

Shows node/edge counts by type — modules, functions, classes, call sites.

## Step 5: AI Integration (MCP)

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "grafema": {
      "command": "npx",
      "args": ["grafema-mcp", "--project", "."]
    }
  }
}
```

Now Claude Code (or any MCP client) can query your codebase graph instead of reading files. Available tools include `find_nodes`, `find_calls`, `trace_dataflow`, `get_file_overview`, `describe`, and 20+ more.

## Step 6: Health Check

```bash
grafema doctor
```

Checks binary availability, RFDB server status, and common issues.

## Configuration

The generated `.grafema/config.yaml` uses minimal defaults:

```yaml
version: "0.3"
root: ".."
include:
  - "src/**/*.{ts,tsx,js,jsx}"
exclude:
  - "**/*.test.*"
  - "**/__tests__/**"
  - "**/node_modules/**"
  - "**/dist/**"
```

Edit `include`/`exclude` patterns to match your project layout. Paths resolve relative to the `.grafema/` directory, so `root: ".."` points to the project root.

See [Configuration Reference](configuration.md) for all options.

## Next Steps

- [Configuration Reference](configuration.md) - Customize file patterns and services
- [Datalog Cheat Sheet](datalog-cheat-sheet.md) - Advanced graph queries
- [Known Limitations](../KNOWN_LIMITATIONS.md) - What works and what doesn't

## Troubleshooting

**"No graph database found"**
Run `grafema analyze` first to build the graph.

**Analysis shows 0 files**
Check `.grafema/config.yaml` — make sure `include` patterns match your source files and `root` points to the project root (usually `".."`).

**"package.json not found"**
Grafema currently requires a `package.json`. Run `npm init -y` to create one.

**Binaries not found**
Run `grafema doctor` to check which binaries are available and where they're expected.

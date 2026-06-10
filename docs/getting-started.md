# Getting Started with Grafema

> **Zero to insight in 5 minutes.** Grafema builds a queryable graph of your codebase, answering questions like "who calls this function?" or "where does this data flow?" without reading thousands of lines of code.

## Prerequisites

- **Node.js 18+** (check with `node --version`)
- A JavaScript or TypeScript project with a `package.json`
- macOS (ARM or Intel) or Linux x64

## Step 1: Install

```bash
npm install -g grafema
```

## Step 2: Index (1-2 minutes)

In your project directory:

```bash
grafema analyze --quickstart
```

`--quickstart` auto-detects your project languages, generates `.grafema/config.yaml`, and builds the code graph in one step.

Expected output:
```
Analyzing project: /path/to/your-project
Analysis complete
  Nodes: 2,847
  Edges: 5,123
```

**Two-step alternative** — if you want to review the config before indexing:

```bash
grafema init        # generates .grafema/config.yaml
grafema analyze     # builds the graph
```

## Step 3: Explore

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

## Step 4: AI Integration (MCP)

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

Now Claude Code (or any MCP client) can query your codebase graph instead of reading files. Available tools include `find_nodes`, `find_calls`, `trace_dataflow`, `get_file_overview`, `describe`, and 30+ more.

## Step 5: Health Check

```bash
grafema doctor
```

Checks binary availability, RFDB server status, and common issues.

## Configuration

The generated `.grafema/config.yaml` uses minimal defaults:

```yaml
version: "0.3.29"
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
Run `grafema upgrade` to clean stale artifacts and download fresh binaries.

**Upgrading from an older version**
Run `grafema upgrade` to remove stale binaries from `~/.grafema/bin/` and download the current versions. Use `grafema upgrade --lang js,python` to install only specific language analyzers.

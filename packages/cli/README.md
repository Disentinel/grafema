# @grafema/cli

> Grafema command-line interface for building and querying the code graph.

## Quick Start

```bash
npx @grafema/cli init
npx @grafema/cli analyze
npx @grafema/cli overview
```

## Commands

### Project setup

```bash
npx @grafema/cli init           # Create .grafema/config.yaml
npx @grafema/cli analyze         # Build the graph
npx @grafema/cli overview        # Summary of nodes/edges found
npx @grafema/cli schema          # List node and edge types
npx @grafema/cli types           # List available node types
```

### Querying the graph

```bash
npx @grafema/cli query "auth"                    # Name search (partial match)
npx @grafema/cli query "function login"          # Type + name
npx @grafema/cli query "route /api"              # Route search
npx @grafema/cli query "token in authenticate"   # Scope filtering
npx @grafema/cli query --type http:request "/api" # Exact type
npx @grafema/cli query --raw 'type(X, "FUNCTION")'
```

### Data flow tracing

```bash
npx @grafema/cli trace "userId"                   # Trace variable sources/sinks
npx @grafema/cli trace "userId from authenticate" # Scoped trace
npx @grafema/cli trace --to "addNode#0.type"       # Sink-based trace
npx @grafema/cli trace --from-route "GET /status"  # Route response trace
```

### Navigation helpers

```bash
npx @grafema/cli ls --type FUNCTION        # List nodes by type
npx @grafema/cli get <semantic-id>         # Get a single node by ID
npx @grafema/cli explain <node-id>         # Explain a node (summary)
```

### Checks & diagnostics

```bash
npx @grafema/cli check                 # Run all guarantees
npx @grafema/cli check dataflow        # Run a diagnostic category
npx @grafema/cli check --list-categories
npx @grafema/cli doctor                # Validate local setup
```

### Misc

```bash
npx @grafema/cli coverage               # Coverage stats
npx @grafema/cli impact                 # Impact analysis
npx @grafema/cli explore                # Interactive explorer (TUI)
```

## Notes

- All commands accept `--project <path>` to point at a specific repo.
- `npx @grafema/cli` works without global install and is preferred for docs/examples.

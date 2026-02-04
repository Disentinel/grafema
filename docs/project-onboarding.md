# Project Onboarding Guide

> **Your codebase has thousands of files.** Where does user data flow? Which endpoints call the database? Which functions are never called? Grafema answers these questions in seconds, not hours. Here's how to get started.

This guide will help you integrate Grafema into an existing project and iteratively improve semantic code coverage.

## Process Overview

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   SETUP     │ →   │  ANALYZE    │ →   │   ASSESS    │ →   │   QUERY     │
├─────────────┤     ├─────────────┤     ├─────────────┤     ├─────────────┤
│ Configure   │     │ First       │     │ Evaluate    │     │ Explore     │
│ .grafema/   │     │ analysis    │     │ coverage    │     │ the graph   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

All plugins are enabled by default ("batteries included"). Plugins that don't find relevant patterns simply do nothing.

## Step 1: Initial Setup

### 1.1 Initialize

The simplest way to start:

```bash
grafema init
```

This creates `.grafema/config.yaml` with sensible defaults.

### 1.2 Directory Structure

Grafema stores configuration and data in `.grafema/`:

```
your-project/
├── .grafema/
│   ├── config.yaml       # Plugin configuration (version controlled)
│   └── graph.rfdb        # Graph database (gitignore)
├── src/
└── ...
```

### 1.3 Configuration

By default, Grafema uses all built-in plugins — "batteries included".
Plugins that don't find relevant patterns simply do nothing.

Minimal `.grafema/config.yaml` example:

```yaml
plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
    - ExpressRouteAnalyzer
  enrichment:
    - MethodCallResolver
  validation:
    - EvalBanValidator
```

Full configuration reference: [configuration.md](configuration.md)

**Built-in Plugins:**

| Phase | Plugins | What They Do |
|-------|---------|--------------|
| Indexing | JSModuleIndexer | Builds module dependency tree |
| Analysis | JSASTAnalyzer | Core AST: functions, classes, calls |
| | ExpressRouteAnalyzer | HTTP routes (Express) |
| | SocketIOAnalyzer | WebSocket events |
| | DatabaseAnalyzer | SQL/NoSQL queries |
| | FetchAnalyzer | HTTP client requests |
| | ServiceLayerAnalyzer | Service layer patterns |
| Enrichment | MethodCallResolver | Resolves method calls |
| | AliasTracker | Tracks variable aliases |
| | ValueDomainAnalyzer | Analyzes possible values |
| | MountPointResolver | Resolves mount points (Express) |
| | PrefixEvaluator | Computes path prefixes |
| | HTTPConnectionEnricher | Connects frontend requests to backend routes |
| Validation | EvalBanValidator | Bans eval() and Function() |
| | SQLInjectionValidator | Detects SQL injection |
| | CallResolverValidator | Verifies call resolution |

### 1.4 Add to .gitignore

```gitignore
# Grafema
.grafema/graph.rfdb
.grafema/rfdb.sock
```

`grafema init` automatically adds these lines to `.gitignore`.

## Step 2: First Analysis

### 2.1 Run Analysis

```bash
grafema analyze
```

Or via MCP:
```javascript
// MCP tool: analyze_project
{ "force": true }
```

### 2.2 Check Results

```bash
grafema overview
```

Example output:
```
Nodes: 1,234 total
  MODULE: 45
  FUNCTION: 234
  CALL: 567
  VARIABLE: 388
Edges: 2,456 total
  CONTAINS: 890
  CALLS: 123
  DEPENDS_ON: 44
```

### 2.3 Check Schema

```bash
grafema schema
```

Shows all node types and edge types in the graph.

## Step 3: Assess Coverage

### 3.1 Find "Blind Spots"

Use Datalog queries to find unanalyzed code. See [Datalog Cheat Sheet](datalog-cheat-sheet.md) for query syntax.

```bash
# Find unresolved function calls (no CALLS edge)
grafema query 'violation(X) :- node(X, "CALL"), \+ edge(X, _, "CALLS").'

# Find unresolved method calls
grafema query 'violation(X) :- node(X, "METHOD_CALL"), \+ edge(X, _, "CALLS").'
```

### 3.2 Analysis by File

```bash
# Find files with the most unresolved calls
grafema query 'violation(F) :- node(C, "CALL"), attr(C, "file", F), \+ edge(C, _, "CALLS").'
```

### 3.3 Check Dependencies

Grafema determines dependencies by imports (more reliable than package.json):

```bash
# Find all external dependencies
grafema query 'violation(X) :- node(X, "MODULE"), attr(X, "external", "true").'
```

## Step 4: Coverage Metrics

Track these metrics:

```bash
# 1. Call resolution rate - grafema overview shows totals

# 2. Unresolved calls (should decrease over time)
grafema query 'violation(X) :- node(X, "CALL"), \+ edge(X, _, "CALLS").'

# 3. Semantic coverage (HTTP routes, DB queries, etc.)
grafema query 'violation(X) :- node(X, "http:route").'  # How many routes found
```

### 4.1 When to Write a Custom Plugin

If:
- You use a library without a built-in plugin (e.g., Fastify, NestJS)
- You have project-specific patterns (custom ORM, internal frameworks)
- You need specific semantics

See [plugin-development.md](plugin-development.md) for the guide.

## Step 5: Explore the Graph

Now you can query the graph to understand your codebase:

```bash
# Find functions by name
grafema query "function authenticate"

# Find HTTP routes
grafema query "route /api"

# Trace variables
grafema trace "userId"
```

For more query examples, see [Datalog Cheat Sheet](datalog-cheat-sheet.md).

## What's Next?

1. **Expand coverage** — Write custom plugins for libraries specific to your project
2. **Query during code review** — Use Grafema to understand changes before merging
3. **Track metrics** — Monitor call resolution rate over time

## Onboarding Checklist

- [ ] Run `grafema init`
- [ ] Configure `.grafema/config.yaml` (if needed)
- [ ] Add `.grafema/graph.rfdb` to `.gitignore`
- [ ] First analysis complete (`grafema analyze`)
- [ ] Schema verified (`grafema schema`)
- [ ] Coverage metrics checked (unresolved calls)
- [ ] Try some queries (`grafema query`)

## Troubleshooting

### Analysis takes too long

- Use `exclude` in config to skip tests and generated code
- Use `include` to limit analysis to specific directories

### Many unresolved calls

- Verify `MethodCallResolver` and `AliasTracker` are enabled in enrichment
- Check if plugins exist for libraries you use
- Some dynamic patterns cannot be resolved statically

### Plugin doesn't find patterns

- Verify the plugin is in the correct phase (analysis vs enrichment)
- Check plugin order — enrichers depend on analysis results
- Use `--log-level debug` for detailed logs

### `grafema init` fails

- Ensure you have a `package.json` in the project root
- Check write permissions for `.grafema/` directory

## Glossary

See [glossary.md](glossary.md) for definitions of terms like "enrichment", "semantic node", "Datalog", etc.

## See Also

- [Configuration Reference](configuration.md) — Full configuration reference
- [Plugin Development](plugin-development.md) — Writing plugins
- [Datalog Cheat Sheet](datalog-cheat-sheet.md) — Common queries with explanations
- [Glossary](glossary.md) — Term definitions

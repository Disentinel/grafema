# Getting Started with Grafema

> **Zero to insight in 5 minutes.** Grafema builds a queryable graph of your codebase, answering questions like "what calls this function?" or "where does this data flow?" without reading thousands of lines of code.

## Prerequisites

- **Node.js 18+** (check with `node --version`)
- A JavaScript or TypeScript project with a `package.json`

## Step 1: Initialize (30 seconds)

In your project directory:

```bash
npx grafema init
```

This creates `.grafema/config.yaml` with default settings. Grafema automatically detects Express routes, database queries, API calls, and more.

## Step 2: Analyze (1-2 minutes)

Build the code graph:

```bash
npx grafema analyze
```

Expected output:
```
Analyzing project: /path/to/your-project
Loaded 24 plugins
Analysis complete in 4.52s
  Nodes: 2,847
  Edges: 5,123
```

## Step 3: Explore (2 minutes)

### See what was found

```bash
npx grafema overview
```

Output:
```
Code Structure:
- Modules: 45
- Functions: 234
- Classes: 12
- Call sites: 567

External Interactions:
- HTTP routes: 18
- Database queries: 23
```

### Find all API endpoints

```bash
npx grafema query "route /api"
```

Output:
```
[http:route] GET /api/users
  Location: src/routes/users.js:15

[http:route] POST /api/users
  Location: src/routes/users.js:42

Found 2 results.
```

### Search for functions

```bash
npx grafema query "function authenticate"
```

Output:
```
[FUNCTION] authenticate
  ID: src/auth/middleware.ts->authenticate
  Location: src/auth/middleware.ts:12

Called by (3):
  <- loginHandler (src/routes/auth.ts:28)
  <- protectedRoute (src/middleware/auth.ts:5)
  <- validateToken (src/auth/token.ts:15)
```

### Trace data flow

```bash
npx grafema trace "userId from authenticate"
```

Output:
```
[VARIABLE] userId
  ID: src/auth/middleware.ts->authenticate->userId
  Location: src/auth/middleware.ts:18

Data sources (where value comes from):
  <- token (PARAMETER)
     src/auth/middleware.ts:12

Possible values:
  - <parameter token> (runtime input)
```

### Check for issues

```bash
npx grafema check connectivity
```

Output:
```
Checking Graph Connectivity...

No issues found
```

## Step 4: VS Code Extension (optional)

For visual graph exploration:

1. Install the extension:
   ```bash
   cd node_modules/grafema/packages/vscode
   ./scripts/install-local.sh
   ```

2. Open your project in VS Code

3. Press **Cmd+Shift+G** (Mac) or **Ctrl+Shift+G** (Windows/Linux) to find the graph node at your cursor

4. Use the "Grafema Explore" panel in the sidebar to navigate edges and relationships

## Common Queries

```bash
# Find functions by name (partial match)
npx grafema query "auth"

# Find all HTTP routes
npx grafema query "route"

# Find variables in a specific function
npx grafema query "config in loadSettings"

# Trace where a value flows
npx grafema trace "apiKey"

# Check data flow integrity
npx grafema check dataflow

# See all available checks
npx grafema check --list-categories
```

## Next Steps

- [Configuration Reference](configuration.md) - Customize plugins and file patterns
- [Project Onboarding Guide](project-onboarding.md) - Comprehensive setup for teams
- [Datalog Cheat Sheet](datalog-cheat-sheet.md) - Advanced graph queries
- [Guarantee Workflow](guarantee-workflow.md) - Enforce code invariants in CI

## Troubleshooting

**"No graph database found"**
Run `grafema analyze` first to build the graph.

**Analysis is slow**
Add an `exclude` pattern in `.grafema/config.yaml`:
```yaml
exclude:
  - "**/*.test.ts"
  - "**/node_modules/**"
```

**"package.json not found"**
Grafema currently supports JavaScript/TypeScript projects. Run `npm init -y` to create a package.json.

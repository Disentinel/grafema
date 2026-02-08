# Grafema Configuration Reference

> **Configure Grafema to understand your codebase.** Tell it which plugins to use, which files to analyze, and which services make up your project. Most projects work with zero configuration — just run `npx @grafema/cli init` and go.

This document describes the complete configuration format for Grafema.

## Quick Start

Run `npx @grafema/cli init` to create a default configuration:

```bash
npx @grafema/cli init
```

This creates `.grafema/config.yaml` with sensible defaults.

## Configuration File

Grafema looks for configuration in `.grafema/config.yaml` (preferred) or `.grafema/config.json` (deprecated).

```
your-project/
├── .grafema/
│   ├── config.yaml       # Configuration (version controlled)
│   ├── guarantees.yaml   # Invariants (version controlled)
│   └── graph.rfdb        # Graph database (gitignore)
├── src/
└── ...
```

## Full Configuration Schema

```yaml
# .grafema/config.yaml

# Plugin configuration by phase
plugins:
  discovery: []           # Service discovery plugins
  indexing:               # Module tree building
    - JSModuleIndexer
  analysis:               # AST parsing and semantic node creation
    - JSASTAnalyzer
    - ExpressRouteAnalyzer
    - SocketIOAnalyzer
    - DatabaseAnalyzer
    - FetchAnalyzer
    - ServiceLayerAnalyzer
  enrichment:             # Graph enrichment (resolving calls, tracking values)
    - MethodCallResolver
    - ArgumentParameterLinker
    - AliasTracker
    - ClosureCaptureEnricher
    - ValueDomainAnalyzer
    - MountPointResolver
    - PrefixEvaluator
    - ImportExportLinker
    - HTTPConnectionEnricher
  validation:             # Invariant checking
    - GraphConnectivityValidator
    - DataFlowValidator
    - EvalBanValidator
    - CallResolverValidator
    - SQLInjectionValidator
    - ShadowingDetector
    - TypeScriptDeadCodeValidator
    - BrokenImportValidator

# Optional: Explicit service definitions for multi-service projects
# If specified, auto-discovery is skipped
services:
  - name: "backend"
    path: "apps/backend"        # Relative to project root
    entryPoint: "src/index.ts"  # Optional, auto-detected if omitted
  - name: "frontend"
    path: "apps/frontend"

# File filtering patterns (optional)
include:                  # Only analyze files matching these patterns
  - "src/**/*.{ts,js,tsx,jsx}"

exclude:                  # Skip files matching these patterns
  - "**/*.test.ts"
  - "**/__tests__/**"
```

## Configuration Options

### plugins

Plugin configuration organized by analysis phase. Each phase runs in order:

1. **discovery** - Find services and entry points
2. **indexing** - Build module dependency tree
3. **analysis** - Parse AST, create semantic nodes
4. **enrichment** - Add relationships between nodes
5. **validation** - Check invariants, detect issues

If a phase is omitted, default plugins are used. To disable a phase, set it to an empty array:

```yaml
plugins:
  validation: []  # Skip all validation
```

### services

Explicit service definitions for multi-service projects (monorepos). When specified:
- Auto-discovery is completely skipped
- Each service is analyzed independently
- Paths must be relative to project root
- Entry points are auto-detected if not specified

```yaml
services:
  - name: "api"              # Service identifier (used in graph node IDs)
    path: "packages/api"     # Service directory (must exist)
    entryPoint: "src/main.ts" # Optional entry file
```

If `services` is not specified or empty, Grafema uses auto-discovery.

### include / exclude

Glob patterns for filtering which files are analyzed:

```yaml
include:
  - "src/**/*.ts"
  - "lib/**/*.js"

exclude:
  - "**/*.test.ts"
  - "**/__mocks__/**"
  - "**/fixtures/**"
```

**Rules:**
- `include` - only files matching at least one pattern are processed
- `exclude` - files matching any pattern are skipped (takes precedence over include)
- Uses [minimatch](https://github.com/isaacs/minimatch) syntax
- Patterns are matched against paths relative to project root
- `node_modules` is always excluded automatically

If neither is specified, Grafema follows imports from entry points.

## Available Plugins

### Discovery Phase

Discovery plugins find services and entry points in a project.

| Plugin | Description |
|--------|-------------|
| (none by default) | Auto-discovery via `package.json` analysis |

### Indexing Phase

Indexing plugins build the module dependency tree.

| Plugin | Description |
|--------|-------------|
| **JSModuleIndexer** | Builds module dependency tree via DFS from entry points. Creates MODULE nodes and DEPENDS_ON edges. Handles ES modules, CommonJS, and TypeScript. |

### Analysis Phase

Analysis plugins parse AST and create semantic nodes.

| Plugin | Description |
|--------|-------------|
| **JSASTAnalyzer** | Core AST parser. Creates FUNCTION, CLASS, METHOD, VARIABLE, CALL nodes. Handles ES6+, TypeScript, JSX. |
| **ExpressRouteAnalyzer** | Detects Express.js/Router endpoints. Creates `http:route` nodes with method, path, middleware info. |
| **SocketIOAnalyzer** | Detects Socket.IO events (emit/on). Creates `socketio:emit` and `socketio:on` nodes. |
| **DatabaseAnalyzer** | Detects database queries (SQL, MongoDB, etc.). Creates `db:query` nodes. |
| **FetchAnalyzer** | Detects HTTP client requests (fetch, axios, etc.). Creates `http:request` nodes. |
| **ServiceLayerAnalyzer** | Detects service layer patterns (classes with @Service, repository patterns). |

### Enrichment Phase

Enrichment plugins add relationships between nodes.

| Plugin | Description |
|--------|-------------|
| **MethodCallResolver** | Resolves method calls to method definitions. Creates CALLS edges from CALL to METHOD/FUNCTION. |
| **ArgumentParameterLinker** | Links function call arguments to parameter definitions. Creates PASSES_ARGUMENT edges. |
| **AliasTracker** | Tracks variable aliasing (`const m = obj.method; m()`). Resolves indirect calls. |
| **ClosureCaptureEnricher** | Detects closure variable captures. Creates CAPTURES edges. |
| **ValueDomainAnalyzer** | Value set analysis for computed member access. Resolves `obj[method]()` when deterministic. |
| **MountPointResolver** | Resolves Express router mount points. Computes full paths for nested routes. |
| **PrefixEvaluator** | Evaluates string prefix expressions. Computes URL prefixes for routes. |
| **ImportExportLinker** | Links imports to exports across modules. Creates IMPORTS_FROM edges. |
| **HTTPConnectionEnricher** | Connects frontend HTTP requests to backend routes. Creates INTERACTS_WITH edges. |

### Validation Phase

Validation plugins check invariants and detect issues.

| Plugin | Description |
|--------|-------------|
| **GraphConnectivityValidator** | Checks all nodes are reachable from SERVICE/MODULE roots. |
| **DataFlowValidator** | Verifies variables trace to leaf nodes via ASSIGNED_FROM. |
| **EvalBanValidator** | **Security:** Detects `eval()`, `new Function()` usage. |
| **CallResolverValidator** | Reports unresolved function calls for debugging. |
| **SQLInjectionValidator** | **Security:** Detects SQL injection vulnerabilities. |
| **ShadowingDetector** | Detects variable shadowing issues. |
| **TypeScriptDeadCodeValidator** | Detects unreachable/dead code in TypeScript. |
| **BrokenImportValidator** | Detects broken imports (missing files, wrong exports). |

## Configuration Examples

### Single Service (default)

For most projects, no configuration is needed:

```yaml
# .grafema/config.yaml
plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
    - ExpressRouteAnalyzer
  enrichment:
    - MethodCallResolver
    - HTTPConnectionEnricher
  validation:
    - EvalBanValidator
    - SQLInjectionValidator
```

### Monorepo with Multiple Services

```yaml
# .grafema/config.yaml

services:
  - name: "api"
    path: "packages/api"
    entryPoint: "src/server.ts"
  - name: "web"
    path: "packages/web"
    entryPoint: "src/index.tsx"
  - name: "shared"
    path: "packages/shared"
    entryPoint: "src/index.ts"

plugins:
  analysis:
    - JSASTAnalyzer
    - ExpressRouteAnalyzer  # For API
    - ReactAnalyzer         # For Web
    - FetchAnalyzer         # For frontend requests
  enrichment:
    - MethodCallResolver
    - HTTPConnectionEnricher  # Connect web requests to API routes
```

### Security-Focused Analysis

```yaml
# .grafema/config.yaml

plugins:
  validation:
    - EvalBanValidator       # No eval()
    - SQLInjectionValidator  # No SQL injection
    - CallResolverValidator  # Track unresolved calls
```

### Minimal Configuration (Performance)

For large codebases, disable unused plugins:

```yaml
# .grafema/config.yaml

plugins:
  indexing:
    - JSModuleIndexer
  analysis:
    - JSASTAnalyzer
  enrichment:
    - MethodCallResolver
  validation: []  # Skip validation for faster analysis

include:
  - "src/**/*.ts"

exclude:
  - "**/*.test.ts"
  - "**/__tests__/**"
```

## Migrating from config.json

If you have an existing `.grafema/config.json`:

```bash
npx @grafema/cli init --force
```

This will create a new `config.yaml` while preserving your settings.

## See Also

- [Project Onboarding Guide](project-onboarding.md) - Getting started with Grafema
- [Plugin Development Guide](plugin-development.md) - Creating custom plugins

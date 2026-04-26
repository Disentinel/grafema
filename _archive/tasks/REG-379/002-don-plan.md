# Don Melton: REG-379 Analysis & Plan

## Analysis

### Current State
- **ExpressRouteAnalyzer** handles Express routes (`router.get('/path', handler)`), file-based with Babel AST traversal
- **DECORATOR node infrastructure** exists (ClassVisitor extracts, DecoratorNode factory creates, GraphBuilder flushes) but ALL integration tests are SKIPPED pending `decorators-legacy` Babel plugin
- All existing analyzers follow the same pattern: iterate MODULE nodes, readFileSync, parse with Babel, traverse AST, write nodes to graph

### Architectural Decision: File-based approach

**Why NOT graph-based (querying DECORATOR nodes):**
- DECORATOR integration tests are all skipped — the pipeline is unproven end-to-end
- Adding a dependency on unvalidated infrastructure would be risky
- ALL other analyzers use file-based approach — this is the established pattern

**Why file-based:**
- Proven pattern used by ExpressRouteAnalyzer, SocketIOAnalyzer, FetchAnalyzer, etc.
- Babel `typescript` plugin should parse decorator syntax in `.ts` files
- Self-contained — doesn't depend on DECORATOR node infrastructure being correct
- Follows existing patterns exactly → predictable behavior, easier to review

### What the Reference Plugin Gets Right/Wrong

**Right:** Decorator detection logic (Controller + Get/Post/Put/etc), path combination, array paths
**Wrong:** Hardcoded ToolJet paths, reads files with fs directly, creates redundant http:handler nodes, includes frontend fetch detection (already handled by FetchAnalyzer), does N*M request/route matching (already handled by HTTPConnectionEnricher)

### Design: NestJSRouteAnalyzer

**Scope:** Backend route detection ONLY. Creates `http:route` nodes. Downstream enrichers (HTTPConnectionEnricher, MountPointResolver) handle the rest.

**Algorithm:**
1. Iterate MODULE nodes (via `getModules()`)
2. For each module: read file, parse with Babel (including `decorators` plugin for safety)
3. AST traversal: find `@Controller(...)` class decorators → extract base paths
4. For each class with @Controller: find method decorators `@Get/@Post/@Put/@Patch/@Delete/@Options/@Head` → extract method paths
5. Combine base + method path → create `http:route` node with framework='nestjs'
6. Store handler method info (line/column/name) for later HANDLED_BY linking

**Key points:**
- NO `http:handler` nodes — the FUNCTION node already exists from JSASTAnalyzer
- Store `handlerName` in http:route metadata for ExpressHandlerLinker to link
- Standard `http:route` node type → HTTPConnectionEnricher automatically matches with frontend requests
- `framework: 'nestjs'` metadata to distinguish from Express routes

### Registration (5 points, matching ExpressRouteAnalyzer pattern):
1. `packages/core/src/index.ts` — export
2. `packages/core/src/config/ConfigLoader.ts` — DEFAULT_CONFIG
3. `packages/cli/src/commands/analyze.ts` — import + BUILTIN_PLUGINS
4. `packages/mcp/src/config.ts` — import + BUILTIN_PLUGINS
5. `packages/mcp/src/analysis-worker.ts` — import + builtinPlugins

### Complexity
- O(m) over MODULE nodes (same as all other analyzers) — inherent to the architecture
- For each module: O(n) AST traversal where n = AST nodes in that file
- Only creates nodes for files that have @Controller decorators
- No O(n*m) cross-module operations

### Recommendation
**Mini-MLA configuration.** Well-scoped task, clear patterns to follow, single module.

# Don Melton: Revised Plan (post-Steve review)

## Root Cause Fix

Steve was right: the graph-based approach is correct. The DECORATOR infrastructure exists and is well-implemented — it just can't run because Babel parser rejects decorator syntax.

**Fix:** Add `'decorators-legacy'` to JSASTAnalyzer Babel plugins (1-line change).

After this fix:
- ALL files with decorators will parse correctly (currently they silently fail)
- ClassVisitor will extract decorators (code already exists)
- GraphBuilder will create DECORATOR nodes + DECORATED_BY edges (code already exists)
- The entire DECORATOR pipeline becomes functional

## Two-Phase Implementation

### Phase 1: Enable Decorator Parsing (JSASTAnalyzer fix)
- Change `plugins: ['jsx', 'typescript']` → `plugins: ['jsx', 'typescript', 'decorators-legacy']`
- Un-skip DecoratorNodeMigration integration tests
- Verify DECORATOR nodes appear in graph

### Phase 2: NestJSRouteAnalyzer (graph-based)
- Query DECORATOR nodes where `name` is in ['Controller']
- Follow DECORATED_BY edges to get target CLASS nodes
- For each CLASS: find method DECORATOR nodes (Get, Post, Put, etc.)
- Combine base path + method path → create `http:route` nodes

**Complexity:** O(d) where d = number of Controller/HTTP-method decorators (typically dozens)
**No file I/O.** No AST parsing. Pure graph queries.

## Architecture

```
JSASTAnalyzer (Phase 1 fix)
  → parses files with decorators-legacy
  → ClassVisitor extracts DecoratorInfo
  → GraphBuilder creates DECORATOR nodes + DECORATED_BY edges

NestJSRouteAnalyzer (Phase 2, new)
  → queries DECORATOR nodes (name = 'Controller', 'Get', 'Post', etc.)
  → follows DECORATED_BY edges to CLASS/METHOD
  → creates http:route nodes
```

This is the proper "forward registration" pattern:
- JSASTAnalyzer marks data → stores in graph
- NestJSRouteAnalyzer queries marked data → creates semantic nodes

## Extensibility

Tomorrow: Fastify routes (@FastifyRoute), TypeORM entities (@Entity), Angular components (@Component) — all use the same pattern: query DECORATOR nodes → create semantic nodes. No new file iteration needed.

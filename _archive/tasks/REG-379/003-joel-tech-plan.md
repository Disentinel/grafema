# Joel Spolsky: REG-379 Technical Plan

## Overview

New analysis plugin `NestJSRouteAnalyzer` that detects HTTP routes from NestJS decorator patterns (@Controller + @Get/@Post/etc).

## File Changes

### New File
- `packages/core/src/plugins/analysis/NestJSRouteAnalyzer.ts` — the analyzer

### New Test File
- `test/unit/plugins/analysis/NestJSRouteAnalyzer.test.ts` — unit + integration tests

### Modified Files (registration, 5 files)
1. `packages/core/src/index.ts` — add export
2. `packages/core/src/config/ConfigLoader.ts` — add to DEFAULT_CONFIG.plugins.analysis
3. `packages/cli/src/commands/analyze.ts` — add import + BUILTIN_PLUGINS entry
4. `packages/mcp/src/config.ts` — add import + BUILTIN_PLUGINS entry
5. `packages/mcp/src/analysis-worker.ts` — add import + builtinPlugins entry

## Implementation Details

### NestJSRouteAnalyzer.ts

```typescript
class NestJSRouteAnalyzer extends Plugin {
  metadata: {
    name: 'NestJSRouteAnalyzer',
    phase: 'ANALYSIS',
    creates: { nodes: ['http:route'], edges: ['CONTAINS'] },
    dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']
  }
}
```

**execute() algorithm:**

1. `getModules(graph)` — get all MODULE nodes
2. For each module:
   a. `readFileSync(module.file)` — read source
   b. `parse(code, { plugins: ['jsx', 'typescript', 'decorators-legacy'] })` — parse AST (add `decorators-legacy` for safety)
   c. **Pass 1: Find @Controller classes**
      - Traverse `ClassDeclaration` nodes
      - Check if class has `@Controller(...)` decorator
      - Extract base paths from decorator argument (string, array, or empty → '/')
      - Record: className, classNode, basePaths
   d. **Pass 2: Find HTTP method decorators on class methods**
      - For each @Controller class, traverse its `ClassMethod` nodes
      - Check for `@Get/@Post/@Put/@Patch/@Delete/@Options/@Head` decorators
      - Extract method path from decorator argument (string or empty → '')
      - Combine with base path: `joinRoutePath(basePath, methodPath)`
      - Create `http:route` node

**http:route node structure:**
```typescript
{
  id: `http:route:nestjs:${relativePath}:${line}:${method}:${path}`,
  type: 'http:route',
  name: `${method} ${fullPath}`,
  method: 'GET' | 'POST' | ...,
  path: fullPath,
  file: absolutePath,
  line: decoratorLine,
  column: decoratorColumn,
  framework: 'nestjs',
  handlerName: `${className}.${methodName}`,
  handlerLine: methodLine,
  handlerColumn: methodColumn,
}
```

**Edges created:**
- `CONTAINS`: MODULE → http:route

**Helper functions:**
- `parseDecoratorPath(args)` — extract path from decorator arguments (handle string, array, empty, object with `path` key)
- `joinRoutePath(base, sub)` — combine base + method path with proper `/` handling

### Edge Cases

| Case | Input | Expected Output |
|------|-------|-----------------|
| No argument | `@Controller()` | basePath = '/' |
| String | `@Controller('users')` | basePath = '/users' |
| Leading slash | `@Controller('/users')` | basePath = '/users' |
| Array | `@Controller(['users', 'api/users'])` | 2 base paths |
| Object | `@Controller({ path: 'users' })` | basePath = '/users' |
| Empty Get | `@Get()` | methodPath = '' |
| Get with path | `@Get(':id')` | methodPath = '/:id' |
| Get with slash | `@Get('/:id')` | methodPath = '/:id' |
| No Controller | class without @Controller | Skip entirely |
| Multiple methods | 2 @Get on same class | 2 routes |

### Test Plan

**Unit tests (no graph):**
1. `parseDecoratorPath()` — string, array, empty, object, edge cases
2. `joinRoutePath()` — various base + sub combinations

**Integration tests (with graph):**
1. Basic `@Controller('users') + @Get()` → http:route with `GET /users`
2. `@Controller('users') + @Get(':id')` → http:route with `GET /users/:id`
3. Multiple HTTP methods on same controller
4. Array base path `@Controller(['users', 'api/users'])` → 2 routes per method
5. Empty `@Controller()` + `@Get('health')` → `GET /health`
6. Object form `@Controller({ path: 'users' })`
7. Multiple controllers in same file
8. File with no controllers → 0 routes
9. All HTTP methods: Get, Post, Put, Patch, Delete, Options, Head

**Verification test (on ToolJet fixture if available):**
10. Run on ToolJet controllers directory → non-zero routes

### Complexity Analysis

- **Time:** O(M * N) where M = number of modules, N = average AST size per module
  - Same as ExpressRouteAnalyzer — inherent to analysis phase
  - Actual work only happens in files with @Controller — others are quick parse + skip
- **Space:** O(R) where R = number of routes created — small
- **No cross-module operations** — each module analyzed independently

## Execution Order

1. Kent: Write tests (unit + integration, ~15 test cases)
2. Rob: Implement NestJSRouteAnalyzer + register in 5 files
3. Donald: Run and verify
4. Kevlin: Code review

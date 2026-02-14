# Joel Spolsky: Revised Technical Plan

## Phase 1: Enable Decorator Parsing in JSASTAnalyzer

### Change
**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (line ~1426)

```diff
- plugins: ['jsx', 'typescript']
+ plugins: ['jsx', 'typescript', 'decorators-legacy']
```

### Impact
- Files with decorators (NestJS, Angular, MobX, TypeORM, etc.) will now parse instead of silently failing
- ClassVisitor will extract decorators → DECORATOR nodes + DECORATED_BY edges created
- No regression for files without decorators — the plugin only adds support, doesn't change existing parsing

### Tests
- Un-skip integration tests in `test/unit/DecoratorNodeMigration.test.js` (lines 374-718)
- Verify DECORATOR nodes are created with correct IDs, arguments, targetId, targetType
- Verify DECORATED_BY edges connect CLASS/METHOD → DECORATOR

## Phase 2: NestJSRouteAnalyzer

### New File: `packages/core/src/plugins/analysis/NestJSRouteAnalyzer.ts`

```typescript
class NestJSRouteAnalyzer extends Plugin {
  metadata: {
    name: 'NestJSRouteAnalyzer',
    phase: 'ANALYSIS',
    creates: { nodes: ['http:route'], edges: ['CONTAINS'] },
    dependencies: ['JSASTAnalyzer']  // needs DECORATOR nodes
  }
}
```

### Algorithm

```
1. Query all DECORATOR nodes where name = 'Controller'
   (via graph.queryNodes({ type: 'DECORATOR', name: 'Controller' }))

2. For each Controller decorator:
   a. Extract base paths from arguments:
      - undefined/empty → ['/']
      - string 'users' → ['/users']
      - array ['users', 'api/users'] → ['/users', '/api/users']
      - object { path: 'users' } → ['/users']
   b. Get target CLASS via decorator.targetId
   c. Get CLASS node to find file/module info

3. For each Controller's CLASS:
   a. Find all METHOD decorators on methods of this class:
      - Query DECORATOR nodes where targetType = 'METHOD'
        and name in ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head']
      - Filter by file (same file as class)
      OR
      - Follow CONTAINS edges from CLASS to find child FUNCTION nodes
      - Check each FUNCTION's DECORATED_BY edges for HTTP method decorators
   b. For each HTTP method decorator:
      - Extract method path from arguments (same logic as base path but default to '')
      - Map decorator name to HTTP method: Get→GET, Post→POST, etc.

4. Combine and create nodes:
   For each (basePath, methodPath, httpMethod, decorator):
     fullPath = joinRoutePath(basePath, methodPath)
     routeId = `http:route:nestjs:${relativeFile}:${decorator.line}:${httpMethod}:${fullPath}`

     Create http:route node:
       id: routeId
       type: 'http:route'
       name: `${httpMethod} ${fullPath}`
       method: httpMethod
       path: fullPath
       file: decorator.file
       line: decorator.line
       framework: 'nestjs'
       handlerName: className.methodName  (for future HANDLED_BY linking)

     Create CONTAINS edge: MODULE → http:route
```

### Finding Method Decorators Efficiently

**Strategy:** After step 2, we have the Controller's CLASS node ID. We need HTTP method decorators on methods of this class.

**Option A — Query all HTTP method decorators, filter by class file:**
```
Query DECORATOR nodes where name in ['Get','Post','Put','Patch','Delete','Options','Head']
  and targetType = 'METHOD'
Group by file → match with Controller class file
```

This is O(d_http) where d_http = total HTTP method decorators across all files.

**Option B — From CLASS, follow edges to methods, then to their decorators:**
```
From CLASS node → get outgoing CONTAINS edges → find FUNCTION children
For each FUNCTION → get outgoing DECORATED_BY edges → find DECORATOR children
Filter for HTTP method names
```

Option A is simpler and sufficient. We query all relevant decorators upfront.

**Chosen: Option A** — One upfront query, then group by file. Simple, fast.

### Helper: parseDecoratorPaths

```typescript
function parseDecoratorPaths(args: unknown[]): string[] {
  if (!args || args.length === 0) return ['/'];   // @Controller()

  const first = args[0];

  if (typeof first === 'string') {
    return [normalizePath(first)];                  // @Controller('users')
  }

  if (Array.isArray(first)) {
    return first.filter(v => typeof v === 'string') // @Controller(['a','b'])
                .map(normalizePath);
  }

  if (typeof first === 'object' && first !== null) {
    const path = (first as any).path;               // @Controller({ path: 'users' })
    if (typeof path === 'string') return [normalizePath(path)];
    if (Array.isArray(path)) return path.filter(v => typeof v === 'string').map(normalizePath);
    return ['/'];
  }

  return ['/'];
}

function normalizePath(p: string): string {
  const cleaned = p.replace(/^\/+|\/+$/g, '');
  return cleaned ? `/${cleaned}` : '/';
}

function joinRoutePath(base: string, sub: string): string {
  if (base === '/' && !sub) return '/';
  if (base === '/') return sub.startsWith('/') ? sub : `/${sub}`;
  if (!sub) return base;
  return sub.startsWith('/') ? `${base}${sub}` : `${base}/${sub}`;
}
```

### Registration (5 files)

Same pattern as ExpressRouteAnalyzer:

1. `packages/core/src/index.ts`:
   ```typescript
   export { NestJSRouteAnalyzer } from './plugins/analysis/NestJSRouteAnalyzer.js';
   ```

2. `packages/core/src/config/ConfigLoader.ts` — add after ExpressRouteAnalyzer:
   ```typescript
   'NestJSRouteAnalyzer',
   ```

3. `packages/cli/src/commands/analyze.ts`:
   ```typescript
   import { ..., NestJSRouteAnalyzer } from '@grafema/core';
   // In BUILTIN_PLUGINS:
   NestJSRouteAnalyzer: () => new NestJSRouteAnalyzer() as Plugin,
   ```

4. `packages/mcp/src/config.ts`:
   ```typescript
   import { ..., NestJSRouteAnalyzer } from '@grafema/core';
   // In BUILTIN_PLUGINS:
   NestJSRouteAnalyzer: () => new NestJSRouteAnalyzer(),
   ```

5. `packages/mcp/src/analysis-worker.ts`:
   ```typescript
   import { ..., NestJSRouteAnalyzer } from '@grafema/core';
   // In builtinPlugins:
   NestJSRouteAnalyzer: () => new NestJSRouteAnalyzer(),
   ```

### New Test File: `test/unit/plugins/analysis/NestJSRouteAnalyzer.test.ts`

**Tests:**

1. **Basic route:** `@Controller('users') + @Get()` → `GET /users`
2. **Route with path:** `@Controller('users') + @Get(':id')` → `GET /users/:id`
3. **Multiple methods:** `@Get() + @Post() + @Put()` on same controller
4. **Array base path:** `@Controller(['users', 'api/users'])` → 2x routes per method
5. **Empty controller:** `@Controller()` + `@Get('health')` → `GET /health`
6. **Object form:** `@Controller({ path: 'users' })` → `GET /users`
7. **Multiple controllers in one file**
8. **File with no controllers** → 0 routes
9. **All HTTP methods:** Get, Post, Put, Patch, Delete, Options, Head
10. **CONTAINS edge:** MODULE → http:route exists
11. **Node fields:** method, path, framework='nestjs' are correct

### Complexity

- Phase 1 query: O(d_ctrl) — number of Controller decorators (small)
- Phase 2 query: O(d_http) — number of HTTP method decorators (small)
- Route creation: O(d_ctrl * d_http_per_class) — bounded by class structure
- No file I/O, no AST parsing — pure graph queries

## Execution Order

1. Kent: Tests for Phase 1 (un-skip decorator tests) + Phase 2 (NestJS analyzer)
2. Rob: Phase 1 (1-line JSASTAnalyzer fix) + Phase 2 (NestJSRouteAnalyzer) + registration
3. Donald: Run and verify
4. Kevlin: Code review

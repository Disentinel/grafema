# Don's Exploration: HTTP/Express Analyzer Node Creation

**Date:** 2026-02-15
**Task:** REG-370 - Create node contracts and factory methods for HTTP/Express analyzers
**Branch:** `task/REG-368`

## Executive Summary

5 TypeScript errors in HTTP/Express analyzers caused by inline node creation bypassing NodeFactory. All analyzers create `http:route`, `http:request`, `express:mount`, and `express:middleware` nodes as plain objects, which are not compatible with `AnyBrandedNode` type required by `graph.addNode()`.

**Root cause:** Branded types introduced in REG-368 enforce node creation through NodeFactory. Analyzers predate this change and create nodes inline.

**Solution:** Create node contracts for each HTTP/Express node type, add factory methods to NodeFactory, update analyzers to use factories.

---

## Type System Context

### Branded Types (from REG-368)

```typescript
// packages/types/src/branded.ts
export type BrandedNode<T extends BaseNodeRecord> = T & {
  readonly [NODE_BRAND]: true;
};

export type AnyBrandedNode = BrandedNode<NodeRecord>;
```

**Purpose:** Enforce that ALL nodes go through NodeFactory, preventing inline object creation that bypasses validation.

**Pattern:** `NodeFactory.createX()` → returns `BrandedNode<XNodeRecord>` via `brandNodeInternal()`.

---

## Error Analysis

### 1. ExpressAnalyzer.ts:115

**Error:**
```
Type 'NodeRecord[]' is not assignable to type 'AnyBrandedNode[]'.
  Type 'BaseNodeRecord' is missing property '[NODE_BRAND]'
```

**Location:** Line 115
```typescript
await graph.addNodes(nodes);
```

**Problem:** `nodes` array contains inline objects (http:route, express:mount, net:request), not branded nodes.

**Inline node creation sites in ExpressAnalyzer:**
- **Line 96-97:** `NetworkRequestNode.create()` - already uses contract, but not branded
  ```typescript
  const networkNode = NetworkRequestNode.create();
  nodes.push(networkNode as unknown as NodeRecord);
  ```

- **Lines 221-231:** http:route nodes (inline object)
  ```typescript
  endpoints.push({
    id: `http:route#${method}:${routePath}#${module.file}#${getLine(node)}`,
    type: 'http:route',
    method: method,
    path: routePath,
    localPath: routePath,
    file: module.file!,
    line: getLine(node),
    column: getColumn(node),
    mountedOn: objectName
  });
  ```

- **Lines 299-309:** express:mount nodes (inline object)
  ```typescript
  mountPoints.push({
    id: `express:mount#${prefix}#${module.file}#${getLine(node)}`,
    type: 'express:mount',
    prefix: prefix,
    targetFunction: targetFunction,
    targetVariable: targetVariable,
    file: module.file!,
    line: getLine(node),
    column: getColumn(node),
    mountedOn: objectName
  });
  ```

### 2. ExpressRouteAnalyzer.ts:437

**Error:** Same as #1, different file.

**Location:** Line 437
```typescript
await graph.addNodes(nodes);
```

**Inline node creation sites:**
- **Lines 271-288:** http:route nodes with handler metadata
  ```typescript
  endpoints.push({
    id: endpointId,
    type: 'http:route',
    method: method.toUpperCase(),
    path: routePath,
    file: module.file!,
    line: getLine(node),
    column: getColumn(node),
    routerName: objectName,
    handlerLine: actualHandler.loc ? getLine(actualHandler) : getLine(node),
    handlerColumn: actualHandler.loc ? getColumn(actualHandler) : getLine(node),
    handlerStart,
    handlerName
  });
  ```

- **Lines 312-323:** express:middleware nodes with endpointId
  ```typescript
  middlewares.push({
    id: middlewareId,
    type: 'express:middleware',
    name: middlewareName,
    file: module.file!,
    line: mwNode.loc ? getLine(mwNode) : getLine(node),
    column: mwNode.loc ? getColumn(mwNode) : getColumn(node),
    endpointId: endpointId,
    order: index
  });
  ```

- **Lines 358-368:** express:middleware nodes for app.use()
  ```typescript
  middlewares.push({
    id: middlewareId,
    type: 'express:middleware',
    name: middlewareName,
    file: module.file!,
    line: getLine(node),
    column: getColumn(node),
    mountPath: mountPath,
    isGlobal: mountPath === '/'
  });
  ```

### 3. FetchAnalyzer.ts:461

**Error:** Same as #1.

**Location:** Line 461
```typescript
await graph.addNodes(nodes);
```

**Inline node creation sites:**
- **Lines 92-95:** `NetworkRequestNode.create()` - already uses contract, but not branded
  ```typescript
  const networkNode = NetworkRequestNode.create();
  await graph.addNode(networkNode);
  ```

- **Lines 208-220:** http:request nodes for fetch()
  ```typescript
  const request: HttpRequestNode = {
    id: `http:request#${method}:${url}#${module.file}#${line}`,
    type: 'http:request',
    name: `${method} ${url}`,
    method: method,
    methodSource: methodInfo.source,
    url: url,
    library: 'fetch',
    file: module.file!,
    line: line,
    column: getColumn(node),
    staticUrl: url !== 'dynamic' && url !== 'unknown' ? 'yes' : 'no'
  };
  ```

- **Lines 244-256:** http:request nodes for axios.method()
- **Lines 285-297:** http:request nodes for axios(config)
- **Lines 322-334:** http:request nodes for custom wrappers
- **Lines 439-444:** EXTERNAL nodes
  ```typescript
  nodes.push({
    id: apiId,
    type: 'EXTERNAL',
    domain: apiDomain,
    name: apiDomain
  } as unknown as NodeRecord);
  ```

### 4. FetchAnalyzer.ts:93

**Error:**
```
Argument of type 'NetworkRequestNodeRecord' is not assignable to parameter of type 'AnyBrandedNode'.
  Type 'NetworkRequestNodeRecord' is missing property '[NODE_BRAND]'
```

**Location:** Line 93
```typescript
await graph.addNode(networkNode);
```

**Problem:** `NetworkRequestNode.create()` returns unbranded `NetworkRequestNodeRecord`.

### 5. NestJSRouteAnalyzer.ts:201

**Error:** Similar to #1, inline object.

**Location:** Line 201
```typescript
await graph.addNode({
  id: routeId,
  type: 'http:route',
  name: `${method.httpMethod} ${fullPath}`,
  method: method.httpMethod,
  path: fullPath,
  file: controller.file,
  line: method.line,
  framework: 'nestjs',
  handlerName: `${className}.${methodName}`,
});
```

**Problem:** Direct inline object passed to `graph.addNode()`.

---

## Existing Node Contracts Pattern

### Example: NetworkRequestNode

**File:** `packages/core/src/core/nodes/NetworkRequestNode.ts`

```typescript
interface NetworkRequestNodeRecord extends BaseNodeRecord {
  type: 'net:request';
}

export class NetworkRequestNode {
  static readonly TYPE = 'net:request' as const;
  static readonly SINGLETON_ID = 'net:request#__network__';

  static readonly REQUIRED = ['name', 'file'] as const;
  static readonly OPTIONAL = [] as const;

  static create(): NetworkRequestNodeRecord {
    return {
      id: this.SINGLETON_ID,
      type: this.TYPE,
      name: '__network__',
      file: '__builtin__',
      line: 0
    };
  }

  static validate(node: NetworkRequestNodeRecord): string[] {
    // validation logic
  }
}
```

**Pattern:**
1. Define typed interface extending `BaseNodeRecord`
2. Export class with `TYPE`, `REQUIRED`, `OPTIONAL` static fields
3. `create()` method generates ID and returns typed record
4. `validate()` method checks structure
5. **MISSING:** Integration with NodeFactory

### Example: HttpRequestNode

**File:** `packages/core/src/core/nodes/HttpRequestNode.ts`

```typescript
interface HttpRequestNodeRecord extends BaseNodeRecord {
  type: 'HTTP_REQUEST';
  column: number;
  url?: string;
  method: string;
  parentScopeId?: string;
}

export class HttpRequestNode {
  static readonly TYPE = 'HTTP_REQUEST' as const;

  static create(
    url: string | undefined,
    method: string | undefined,
    file: string,
    line: number,
    column: number,
    options: HttpRequestNodeOptions = {}
  ): HttpRequestNodeRecord {
    const httpMethod = method || 'GET';
    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:HTTP_REQUEST:${httpMethod}:${line}:${column}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: `${httpMethod} ${url || 'dynamic'}`,
      url,
      method: httpMethod,
      file,
      line,
      column,
      parentScopeId: options.parentScopeId
    };
  }
}
```

**Note:** Type is `HTTP_REQUEST` (uppercase), but analyzers create `http:request` (namespaced). **These are DIFFERENT node types.**

---

## Node Types Inventory

### What Exists in packages/types/src/nodes.ts

```typescript
export const NAMESPACED_TYPE = {
  HTTP_ROUTE: 'http:route',
  HTTP_REQUEST: 'http:request',
  EXPRESS_ROUTER: 'express:router',
  EXPRESS_MIDDLEWARE: 'express:middleware',
  EXPRESS_MOUNT: 'express:mount',
  // ...
}

export interface HttpRouteNodeRecord extends BaseNodeRecord {
  type: 'http:route';
  method: string;
  path: string;
  handler?: string;
}
```

**Note:** Type definitions exist, but no node contracts (class with `create()`, `validate()`).

### What Analyzers Create

| Analyzer | Node Type | Fields | ID Format |
|----------|-----------|--------|-----------|
| ExpressAnalyzer | `http:route` | method, path, localPath, file, line, column, mountedOn | `http:route#${method}:${path}#${file}#${line}` |
| ExpressAnalyzer | `express:mount` | prefix, targetFunction, targetVariable, file, line, column, mountedOn | `express:mount#${prefix}#${file}#${line}` |
| ExpressRouteAnalyzer | `http:route` | method, path, file, line, column, routerName, handlerLine, handlerColumn, handlerStart?, handlerName? | `http:route#${method}:${path}#${file}#${line}` |
| ExpressRouteAnalyzer | `express:middleware` | name, file, line, column, endpointId?, order?, mountPath?, isGlobal? | `express:middleware#${name}#${file}#${line}` |
| FetchAnalyzer | `http:request` | name, method, methodSource, url, library, file, line, column, staticUrl, responseDataNode? | `http:request#${method}:${url}#${file}#${line}` |
| FetchAnalyzer | `EXTERNAL` | domain, name | `EXTERNAL#${domain}` |
| NestJSRouteAnalyzer | `http:route` | name, method, path, file, line, framework, handlerName | `http:route:nestjs:${relFile}:${line}:${method}:${path}` |

**Observations:**
1. **http:route** has 3 different shapes (ExpressAnalyzer, ExpressRouteAnalyzer, NestJSRouteAnalyzer)
2. **http:request** vs **HTTP_REQUEST** are DIFFERENT types (namespaced vs uppercase)
3. ID formats vary significantly between analyzers

---

## Required Node Contracts

### 1. HttpRouteNode (http:route)

**Challenge:** Multiple analyzers create different shapes.

**Proposed unified interface:**
```typescript
interface HttpRouteNodeRecord extends BaseNodeRecord {
  type: 'http:route';
  method: string;           // HTTP method (GET, POST, etc.)
  path: string;             // Route path
  file: string;
  line: number;
  column: number;

  // Framework-specific (optional)
  framework?: 'express' | 'nestjs';

  // Express-specific
  localPath?: string;       // Path before mounting
  mountedOn?: string;       // Router variable name
  routerName?: string;      // Alternative name
  handlerLine?: number;     // Handler location
  handlerColumn?: number;
  handlerStart?: number;    // Byte offset (inline handlers)
  handlerName?: string;     // Named handler reference
}
```

**ID Format:** Need to reconcile 3 different formats
- ExpressAnalyzer: `http:route#${method}:${path}#${file}#${line}`
- ExpressRouteAnalyzer: Same as above
- NestJSRouteAnalyzer: `http:route:nestjs:${relFile}:${line}:${method}:${path}` (DIFFERENT!)

**Recommendation:** Use ExpressAnalyzer format as canonical, make NestJSRouteAnalyzer conform.

### 2. HttpRequestNode (http:request)

**Current state:** Conflict with existing `HttpRequestNode` (type: `HTTP_REQUEST`).

**Proposed:** Rename existing `HttpRequestNode` → `HttpRequestCallNode` or deprecate it.

**New HttpRequestNode:**
```typescript
interface HttpRequestNodeRecord extends BaseNodeRecord {
  type: 'http:request';
  name: string;             // Human-readable: "GET /api/users"
  method: string;           // HTTP method
  methodSource: 'explicit' | 'default' | 'unknown';
  url: string;              // URL or 'dynamic' or 'unknown'
  library: string;          // 'fetch', 'axios', custom wrapper name
  file: string;
  line: number;
  column: number;
  staticUrl: 'yes' | 'no';
  responseDataNode?: string | null;
}
```

**ID Format:** `http:request#${method}:${url}#${file}#${line}`

### 3. ExpressMountNode (express:mount)

```typescript
interface ExpressMountNodeRecord extends BaseNodeRecord {
  type: 'express:mount';
  prefix: string;
  targetFunction: string | null;
  targetVariable: string | null;
  file: string;
  line: number;
  column: number;
  mountedOn: string;
}
```

**ID Format:** `express:mount#${prefix}#${file}#${line}`

### 4. ExpressMiddlewareNode (express:middleware)

```typescript
interface ExpressMiddlewareNodeRecord extends BaseNodeRecord {
  type: 'express:middleware';
  name: string;
  file: string;
  line: number;
  column: number;

  // Optional metadata
  endpointId?: string;
  order?: number;
  mountPath?: string;
  isGlobal?: boolean;
}
```

**ID Format:** `express:middleware#${name}#${file}#${line}`

### 5. ExternalNode (EXTERNAL)

**Note:** This is NOT HTTP-specific, should be in separate contract.

```typescript
interface ExternalNodeRecord extends BaseNodeRecord {
  type: 'EXTERNAL';
  domain: string;
  name: string;
}
```

**ID Format:** `EXTERNAL#${domain}`

---

## NodeFactory Integration Pattern

### Current Pattern (from FunctionNode)

```typescript
// In NodeFactory:
static createFunction(name: string, file: string, line: number, column: number, options: FunctionOptions = {}) {
  return brandNodeInternal(FunctionNode.create(name, file, line, column, options));
}
```

**Pattern:**
1. NodeFactory method wraps node contract's `create()`
2. `brandNodeInternal()` applies brand
3. Returns `BrandedNode<XNodeRecord>`

### Proposed Factory Methods

```typescript
// packages/core/src/core/NodeFactory.ts

interface HttpRouteOptions {
  framework?: 'express' | 'nestjs';
  localPath?: string;
  mountedOn?: string;
  routerName?: string;
  handlerLine?: number;
  handlerColumn?: number;
  handlerStart?: number;
  handlerName?: string;
}

static createHttpRoute(
  method: string,
  path: string,
  file: string,
  line: number,
  column: number,
  options: HttpRouteOptions = {}
) {
  return brandNodeInternal(HttpRouteNode.create(method, path, file, line, column, options));
}

interface HttpRequestOptions {
  methodSource?: 'explicit' | 'default' | 'unknown';
  library?: string;
  staticUrl?: 'yes' | 'no';
  responseDataNode?: string | null;
}

static createHttpRequest(
  method: string,
  url: string,
  file: string,
  line: number,
  column: number,
  options: HttpRequestOptions = {}
) {
  return brandNodeInternal(HttpRequestNode.create(method, url, file, line, column, options));
}

// ... similar for ExpressMountNode, ExpressMiddlewareNode
```

---

## Migration Strategy

### Phase 1: Create Node Contracts

1. **HttpRouteNode.ts** - unified interface for all route analyzers
2. **HttpRequestNode.ts** - rename existing to HttpRequestCallNode, create new
3. **ExpressMountNode.ts**
4. **ExpressMiddlewareNode.ts**
5. **ExternalNode.ts** (separate task, not HTTP-specific)

### Phase 2: Add Factory Methods

Add 4 new methods to NodeFactory:
- `createHttpRoute()`
- `createHttpRequest()`
- `createExpressMount()`
- `createExpressMiddleware()`

### Phase 3: Update Analyzers

Replace inline object creation with factory calls:
- **ExpressAnalyzer**: `NetworkRequestNode.create()` → `NodeFactory.createNetworkRequest()`
- **ExpressAnalyzer**: inline http:route → `NodeFactory.createHttpRoute()`
- **ExpressAnalyzer**: inline express:mount → `NodeFactory.createExpressMount()`
- **ExpressRouteAnalyzer**: inline http:route → `NodeFactory.createHttpRoute()`
- **ExpressRouteAnalyzer**: inline express:middleware → `NodeFactory.createExpressMiddleware()`
- **FetchAnalyzer**: `NetworkRequestNode.create()` → `NodeFactory.createNetworkRequest()`
- **FetchAnalyzer**: inline http:request → `NodeFactory.createHttpRequest()`
- **NestJSRouteAnalyzer**: inline http:route → `NodeFactory.createHttpRoute()`

### Phase 4: Update NetworkRequestNode

Add branding to existing contract:
```typescript
// NetworkRequestNode already has create(), just needs NodeFactory wrapper
static createNetworkRequest() {
  return brandNodeInternal(NetworkRequestNode.create());
}
```

---

## Open Questions

### 1. HTTP_REQUEST vs http:request

**Current state:**
- `HttpRequestNode` (contract) creates type `HTTP_REQUEST`
- FetchAnalyzer creates type `http:request`
- These are DIFFERENT node types

**Question:** Which one is correct? Should we:
- A) Keep both (different semantic purposes)
- B) Deprecate `HTTP_REQUEST`, use `http:request` everywhere
- C) Rename `http:request` → `HTTP_REQUEST`

**Recommendation:** Keep both. They serve different purposes:
- `HTTP_REQUEST` - generic HTTP request node (from HttpRequestNode contract)
- `http:request` - specific fetch/axios call site (from FetchAnalyzer)

### 2. http:route ID Format Inconsistency

NestJSRouteAnalyzer uses different ID format than ExpressAnalyzer/ExpressRouteAnalyzer.

**Current:**
- Express: `http:route#${method}:${path}#${file}#${line}`
- NestJS: `http:route:nestjs:${relFile}:${line}:${method}:${path}`

**Impact:** ID format differences could cause deduplication issues.

**Recommendation:** Normalize to single format. Add `framework` metadata field instead.

### 3. NetworkRequestNode Singleton

Already has a contract, but not integrated with NodeFactory.

**Current usage:**
```typescript
const networkNode = NetworkRequestNode.create();
nodes.push(networkNode as unknown as NodeRecord); // NOT BRANDED
```

**Should be:**
```typescript
const networkNode = NodeFactory.createNetworkRequest();
nodes.push(networkNode); // BRANDED
```

**Action:** Add `createNetworkRequest()` to NodeFactory.

---

## Dependencies Check

### NetworkRequestNodeRecord

**From error #4:** `NetworkRequestNodeRecord` is referenced but not exported from `@grafema/types`.

**Current state:**
```typescript
// packages/core/src/core/nodes/NetworkRequestNode.ts
interface NetworkRequestNodeRecord extends BaseNodeRecord {
  type: 'net:request';
}

export class NetworkRequestNode { ... }
export type { NetworkRequestNodeRecord }; // ✅ exported locally
```

**Problem:** Not re-exported from `@grafema/types` index.

**Fix:** Add to `packages/types/src/nodes.ts`:
```typescript
export interface NetworkRequestNodeRecord extends BaseNodeRecord {
  type: 'net:request';
}
```

---

## Complexity Estimate

### Contract Creation (4 files)
- HttpRouteNode.ts - **2 hours** (complex due to 3 analyzer variations)
- HttpRequestNode.ts - **1.5 hours** (naming conflict with existing)
- ExpressMountNode.ts - **1 hour** (straightforward)
- ExpressMiddlewareNode.ts - **1 hour** (straightforward)

### NodeFactory Integration
- Add 4 factory methods - **1 hour**
- Update imports/exports - **0.5 hours**

### Analyzer Updates (4 files)
- ExpressAnalyzer.ts - **1.5 hours**
- ExpressRouteAnalyzer.ts - **2 hours** (most complex)
- FetchAnalyzer.ts - **1.5 hours**
- NestJSRouteAnalyzer.ts - **1 hour**

### Testing
- Unit tests for contracts - **2 hours**
- Verify analyzers still work - **1 hour**

**Total:** ~14-16 hours

---

## Recommendations

1. **Start with simplest:** ExpressMountNode, ExpressMiddlewareNode
2. **Resolve naming conflict:** HttpRequestNode vs HTTP_REQUEST before implementing
3. **Normalize IDs:** Make NestJSRouteAnalyzer use same format as Express analyzers
4. **Add NetworkRequestNode:** to NodeFactory (quick win, fixes error #4)
5. **Write tests first:** Lock behavior before refactoring analyzers

---

## Next Steps (for Joel)

1. Design unified `HttpRouteNodeRecord` interface that accommodates all 3 analyzers
2. Decide on `HTTP_REQUEST` vs `http:request` naming
3. Create detailed implementation plan with test coverage
4. Specify migration order to minimize breaking changes

# Don Melton: Revised Plan for REG-198 (Option A)

## Executive Summary

Based on user decisions, we're implementing the **correct architectural fix** (Option A) instead of the `brandFromDb()` workaround:

1. **Change `GraphBackend` interface** to return `AnyBrandedNode` from retrieval methods
2. **Update `RFDBServerBackend`** to brand nodes on retrieval
3. **Document `addNode` = upsert** in the interface JSDoc
4. **Use stable SemanticID format** WITHOUT location for new node types where possible

This eliminates **all 41 Category D errors automatically** because nodes retrieved from the database will already be branded.

---

## What Option A Changes

### Previous Plan (Option B - REJECTED)
- Add `brandFromDb()` helper function
- Call it at 41 sites where nodes are retrieved from DB
- Type safety hole: function allows bypassing NodeFactory

### New Plan (Option A - APPROVED)
- Change `getNode()`, `getAllNodes()`, `queryNodes()` to return `AnyBrandedNode`
- Brand once in `RFDBServerBackend._parseNode()`
- All 41 Category D call sites automatically become type-safe
- No new helper function, no call site changes needed

---

## Impact Analysis

### Category D Errors (41) - AUTO-FIXED

All 41 errors in these files are **automatically resolved** by changing return types:

| File | Errors | Status |
|------|--------|--------|
| RustAnalyzer.ts | 6 | Auto-fixed |
| ReactAnalyzer.ts | 5 | Auto-fixed |
| ExpressResponseAnalyzer.ts | 5 | Auto-fixed |
| SocketIOAnalyzer.ts | 4 | Auto-fixed |
| ServiceLayerAnalyzer.ts | 4 | Auto-fixed |
| FetchAnalyzer.ts | 3 | Auto-fixed |
| DatabaseAnalyzer.ts | 3 | Auto-fixed |
| SystemDbAnalyzer.ts | 2 | Auto-fixed |
| ExpressRouteAnalyzer.ts | 2 | Auto-fixed |
| IncrementalAnalysisPlugin.ts | 2 | Auto-fixed |
| SQLiteAnalyzer.ts | 1 | Auto-fixed |
| MountPointResolver.ts | 1 | Auto-fixed |
| MonorepoServiceDiscovery.ts | 1 | Auto-fixed |
| IncrementalModuleIndexer.ts | 1 | Auto-fixed |
| RustModuleIndexer.ts | 1 | Auto-fixed |
| IncrementalReanalyzer.ts | 1 | Auto-fixed |

**Why?** When `graph.getNode()` returns `AnyBrandedNode | null`, and enrichers pass that node to `graph.addNode()`, the types match. No changes needed at call sites.

### Category A Errors (7) - STILL NEED FIXES

Inline object creation still needs factory methods:

| File | Issue | Fix |
|------|-------|-----|
| ExpressAnalyzer.ts:207 | `http:route` inline | Use `createHttpRoute()` |
| ExpressAnalyzer.ts:285 | `express:mount` inline | Use `createExpressMount()` |
| JSASTAnalyzer.ts:306 | MODULE inline | Use existing `createModuleWithContext()` |
| JSModuleIndexer.ts:380 | MODULE inline | Use existing `createModuleWithContext()` |
| FunctionCallResolver.ts:242 | UNRESOLVED_CALL inline | Use `createUnresolvedCall()` |
| NodejsBuiltinsResolver.ts:101,184 | builtin:* inline | Use `createBuiltinFunction()` |
| ExternalCallResolver.ts:177 | external function inline | Use `createExternalFunction()` |

### Category B Errors (3) - STILL NEED FIXES

Direct `NodeClass.create()` instead of `NodeFactory.createX()`:

| File | Line | Fix |
|------|------|-----|
| ExpressAnalyzer.ts | 90 | Change to `NodeFactory.createNetworkRequest()` |
| FetchAnalyzer.ts | 142 | Change to `NodeFactory.createNetworkRequest()` |

### Category C Error (1) - STILL NEEDS FIX

GraphBuilder buffer type:

| File | Issue | Fix |
|------|-------|-----|
| GraphBuilder.ts:87 | `_nodeBuffer: GraphNode[]` | Change to `AnyBrandedNode[]` |

### Test Mocks - NEED UPDATES

Test files with `MockGraph` that implement `GraphBackend`:

| File | Change Needed |
|------|---------------|
| test/unit/core/FunctionCallResolver.test.ts | Update `addNode(node: MockNode)` → `addNode(node: AnyBrandedNode)` |
| test/unit/core/FileExplainer.test.ts | Same pattern |
| test/unit/core/CoverageAnalyzer.test.ts | Same pattern |
| test/unit/core/BrokenImportValidator.test.ts | Same pattern |
| test/unit/queries/*.test.ts | Same pattern |
| test/unit/plugins/*.test.ts | Same pattern |

**Note:** MockGraph implementations don't actually need to change their internal storage - only the type signature for `addNode()`. Since branded nodes are just nodes with a phantom type, they're structurally identical at runtime.

---

## New Factory Methods

### ID Format Convention (SemanticID-based, NO location)

Following SemanticID patterns from `packages/core/src/core/SemanticId.ts`:

```
Format: TYPE:unique-key

For singletons (no location):
  EXTERNAL_MODULE:lodash
  EXTERNAL_FUNCTION:lodash.map
  builtin:fs.readFile

For location-dependent nodes (file-scoped):
  http:route:GET:/api/users:{file}
  express:mount:/api:{file}
  UNRESOLVED_CALL:{callee}:{file}:{line}:{column}
```

**Key decisions:**
- **Singletons** (EXTERNAL_MODULE, EXTERNAL_FUNCTION, builtin): NO location - same function = same ID
- **File-scoped nodes** (http:route, express:mount): Include file but NOT line/column where stable
- **Truly unique nodes** (UNRESOLVED_CALL): Include full location for disambiguation

### 1. `createHttpRoute()`

```typescript
/**
 * Create http:route node for HTTP endpoints.
 *
 * ID format: http:route:{method}:{path}:{file}
 * No line/column - path is unique per file.
 */
static createHttpRoute(
  method: string,
  path: string,
  file: string,
  line: number,
  column: number,
  options: {
    localPath?: string;
    mountedOn?: string;
    handler?: string;
  } = {}
): BrandedNode<HttpRouteNodeRecord> {
  const id = `http:route:${method}:${path}:${file}`;
  return brandNode({
    id,
    type: 'http:route' as const,
    name: `${method} ${path}`,
    file,
    line,
    column,
    method,
    path,
    localPath: options.localPath ?? path,
    mountedOn: options.mountedOn,
    handler: options.handler,
  });
}
```

### 2. `createExpressMount()`

```typescript
/**
 * Create express:mount node for router mounting.
 *
 * ID format: express:mount:{prefix}:{file}
 * No line/column - prefix is unique per file.
 */
static createExpressMount(
  prefix: string,
  file: string,
  line: number,
  column: number,
  options: {
    targetFunction?: string | null;
    targetVariable?: string | null;
    mountedOn: string;
  }
): BrandedNode<ExpressMountNodeRecord> {
  const id = `express:mount:${prefix}:${file}`;
  return brandNode({
    id,
    type: 'express:mount' as const,
    name: `mount:${prefix}`,
    file,
    line,
    column,
    prefix,
    targetFunction: options.targetFunction ?? null,
    targetVariable: options.targetVariable ?? null,
    mountedOn: options.mountedOn,
  });
}
```

### 3. `createBuiltinFunction()`

```typescript
/**
 * Create EXTERNAL_FUNCTION node for Node.js built-in functions.
 *
 * ID format: builtin:{module}.{function}
 * Singleton - no location needed.
 */
static createBuiltinFunction(
  moduleName: string,
  functionName: string,
  options: {
    security?: string;
    pure?: boolean;
  } = {}
): BrandedNode<BuiltinFunctionNodeRecord> {
  const normalizedModule = moduleName.startsWith('node:')
    ? moduleName.slice(5)
    : moduleName;

  const id = `builtin:${normalizedModule}.${functionName}`;
  return brandNode({
    id,
    type: 'EXTERNAL_FUNCTION' as const,
    name: `${normalizedModule}.${functionName}`,
    file: '',
    line: 0,
    isBuiltin: true,
    ...(options.security && { security: options.security }),
    ...(options.pure !== undefined && { pure: options.pure }),
  });
}
```

### 4. `createUnresolvedCall()`

```typescript
/**
 * Create UNRESOLVED_CALL node for calls that couldn't be resolved.
 *
 * ID format: UNRESOLVED_CALL:{callee}:{file}:{line}:{column}
 * Full location needed - same callee can appear multiple times.
 */
static createUnresolvedCall(
  callee: string,
  file: string,
  line: number,
  column: number,
  options: { reason?: string } = {}
): BrandedNode<UnresolvedCallNodeRecord> {
  const id = `UNRESOLVED_CALL:${callee}:${file}:${line}:${column}`;
  return brandNode({
    id,
    type: 'UNRESOLVED_CALL' as const,
    name: callee,
    file,
    line,
    column,
    callee,
    reason: options.reason,
  });
}
```

### 5. Update `createExternalFunction()` (Already Exists)

Current factory method `createExternalModule()` exists. For non-builtin external functions:

```typescript
/**
 * Create EXTERNAL_FUNCTION node for external package functions.
 *
 * ID format: EXTERNAL_FUNCTION:{module}.{function}
 * Singleton - no location needed.
 */
static createExternalFunction(
  moduleName: string,
  functionName: string
): BrandedNode<ExternalFunctionNodeRecord> {
  const id = `EXTERNAL_FUNCTION:${moduleName}.${functionName}`;
  return brandNode({
    id,
    type: 'EXTERNAL_FUNCTION' as const,
    name: `${moduleName}.${functionName}`,
    file: '',
    line: 0,
  });
}
```

---

## GraphBackend Interface Changes

### 1. Return Type Changes

```typescript
// packages/types/src/plugins.ts

export interface GraphBackend {
  // INPUT: Accepts branded nodes (already in Phase 1)
  addNode(node: AnyBrandedNode): Promise<void> | void;
  addNodes(nodes: AnyBrandedNode[]): Promise<void> | void;

  // OUTPUT: Returns branded nodes (NEW in Option A)
  getNode(id: string): Promise<AnyBrandedNode | null>;
  queryNodes(filter: NodeFilter): AsyncIterable<AnyBrandedNode> | AsyncGenerator<AnyBrandedNode>;
  getAllNodes(filter?: NodeFilter): Promise<AnyBrandedNode[]>;

  // ... rest unchanged
}
```

### 2. Document addNode = Upsert

```typescript
export interface GraphBackend {
  /**
   * Add a node to the graph.
   *
   * This is an UPSERT operation: if a node with the same ID exists,
   * it will be replaced with the new node data.
   *
   * @param node - Branded node from NodeFactory
   */
  addNode(node: AnyBrandedNode): Promise<void> | void;

  /**
   * Add multiple nodes (batch operation).
   *
   * This is an UPSERT operation: existing nodes with same IDs
   * will be replaced.
   *
   * @param nodes - Array of branded nodes from NodeFactory
   */
  addNodes(nodes: AnyBrandedNode[]): Promise<void> | void;
}
```

---

## RFDBServerBackend Changes

### 1. Import branded types

```typescript
import type { AnyBrandedNode } from '@grafema/types';
import { brandNode } from '@grafema/types';
```

### 2. Update `_parseNode()` to brand

```typescript
/**
 * Parse a node from wire format to branded JS format
 */
private _parseNode(wireNode: WireNode): AnyBrandedNode {
  const metadata: Record<string, unknown> = wireNode.metadata ? JSON.parse(wireNode.metadata) : {};

  // ... existing parsing logic ...

  const node = {
    id: humanId,
    type: wireNode.nodeType,
    name: wireNode.name,
    file: wireNode.file,
    exported: wireNode.exported,
    ...safeMetadata,
  };

  // Brand the node - it was created via NodeFactory originally
  return brandNode(node);
}
```

### 3. Update return types

```typescript
async getNode(id: string): Promise<AnyBrandedNode | null> {
  // ... existing logic, already calls _parseNode
}

async *queryNodes(query: NodeQuery): AsyncGenerator<AnyBrandedNode, void, unknown> {
  // ... existing logic, already calls _parseNode
}

async getAllNodes(query: NodeQuery = {}): Promise<AnyBrandedNode[]> {
  // ... existing logic, already calls queryNodes
}
```

---

## Implementation Phases

### Phase 1: GraphBackend Interface (1 hour)

1. Update `packages/types/src/plugins.ts`:
   - Add `AnyBrandedNode` import
   - Change `addNode()` to accept `AnyBrandedNode`
   - Change `addNodes()` to accept `AnyBrandedNode[]`
   - Change `getNode()` to return `AnyBrandedNode | null`
   - Change `queryNodes()` to return `AsyncIterable<AnyBrandedNode>`
   - Change `getAllNodes()` to return `AnyBrandedNode[]`
   - Add JSDoc documenting upsert semantics

2. Update `packages/core/src/core/GraphBackend.ts` (abstract class) similarly

### Phase 2: RFDBServerBackend (30 min)

1. Add imports for branded types
2. Update `_parseNode()` to call `brandNode()` on return
3. Update type signatures to match interface

### Phase 3: Add Missing Node Types (30 min)

Add to `packages/types/src/nodes.ts`:

```typescript
export interface HttpRouteNodeRecord extends BaseNodeRecord {
  type: 'http:route';
  method: string;
  path: string;
  localPath: string;
  mountedOn?: string;
  handler?: string;
}

export interface ExpressMountNodeRecord extends BaseNodeRecord {
  type: 'express:mount';
  prefix: string;
  targetFunction?: string | null;
  targetVariable?: string | null;
  mountedOn: string;
}

export interface UnresolvedCallNodeRecord extends BaseNodeRecord {
  type: 'UNRESOLVED_CALL';
  callee: string;
  reason?: string;
}

// Note: BuiltinFunctionNodeRecord not needed - uses EXTERNAL_FUNCTION with isBuiltin flag
// ExternalFunctionNodeRecord already exists implicitly
```

Update `NodeRecord` union type.

### Phase 4: Add Factory Methods (1 hour)

Add to `packages/core/src/core/NodeFactory.ts`:
- `createHttpRoute()`
- `createExpressMount()`
- `createBuiltinFunction()`
- `createUnresolvedCall()`
- `createExternalFunction()` (if not exists)

### Phase 5: Fix Category A - Inline Creation (1 hour)

Update files to use new factory methods:
- ExpressAnalyzer.ts (http:route, express:mount)
- JSASTAnalyzer.ts (MODULE - use existing factory)
- JSModuleIndexer.ts (MODULE - use existing factory)
- FunctionCallResolver.ts (UNRESOLVED_CALL)
- NodejsBuiltinsResolver.ts (builtin functions)
- ExternalCallResolver.ts (external functions)

### Phase 6: Fix Category B - Direct Node Class (15 min)

- ExpressAnalyzer.ts:90 - use `NodeFactory.createNetworkRequest()`
- FetchAnalyzer.ts:142 - use `NodeFactory.createNetworkRequest()`

### Phase 7: Fix Category C - GraphBuilder (15 min)

- Change `_nodeBuffer` type to `AnyBrandedNode[]`
- Remove `as unknown as` casts

### Phase 8: Update Test Mocks (1.5 hours)

Update MockGraph implementations in test files:
- Change `addNode(node: MockNode)` → `addNode(node: AnyBrandedNode)`
- Tests can still use inline nodes internally, but `addNode` call accepts branded
- For tests that create nodes directly, use NodeFactory

---

## Time Estimate

| Phase | Effort |
|-------|--------|
| 1. GraphBackend Interface | 1 hour |
| 2. RFDBServerBackend | 30 min |
| 3. Node Type Definitions | 30 min |
| 4. Factory Methods | 1 hour |
| 5. Inline Creation Fixes | 1 hour |
| 6. Direct Node Class Fixes | 15 min |
| 7. GraphBuilder Fix | 15 min |
| 8. Test Mocks | 1.5 hours |
| **Total** | **6 hours** |

**Compared to original plan:** 7-9 hours with `brandFromDb()` approach.

**Why shorter?** No need to update 41 Category D call sites - they're auto-fixed.

---

## What We DON'T Need

1. ~~`brandFromDb()` helper~~ - Not needed
2. ~~`testBrand()` helper~~ - Tests should use NodeFactory
3. ~~Updates to 41 Category D call sites~~ - Auto-fixed by return type change

---

## Verification Checklist

After implementation:

1. `npm run build` - All packages compile
2. `npm test` - All tests pass
3. No `brandFromDb` or type assertion workarounds in codebase
4. Grep for `as unknown as` - should only appear in legitimate casting scenarios

---

## Questions Resolved

1. **brandFromDb() approach?** - REJECTED, implementing Option A instead
2. **addNode = upsert?** - YES, documented in interface JSDoc
3. **ID format for new nodes?** - Using SemanticID patterns WITHOUT location for singletons

---

*Plan complete. Ready for Joel's detailed tech spec, then Kent (tests) and Rob (implementation).*

# Don Melton: Analysis and Plan for REG-198

## Executive Summary

After making the change to enforce branded nodes in GraphBackend.addNode(), the TypeScript compiler reveals **52 errors** across **23 files**. The errors fall into clear categories that can be systematically addressed.

## 1. Current State Analysis

### Branded Types System (Phase 1 - Complete)

The branded types infrastructure is fully in place:

```typescript
// packages/types/src/branded.ts
declare const NODE_BRAND: unique symbol;
export type BrandedNode<T extends BaseNodeRecord> = T & { readonly [NODE_BRAND]: true; };
export type AnyBrandedNode = BrandedNode<NodeRecord>;
export function brandNode<T extends BaseNodeRecord>(node: T): BrandedNode<T>;
```

**NodeFactory** already returns branded nodes via `brandNode()`:
- All 30+ factory methods wrap their return values with `brandNode()`
- Factory methods exist for most node types: `createFunction`, `createCallSite`, `createHttpRequest`, etc.

### The Change Made

```typescript
// packages/types/src/plugins.ts (GraphBackend interface)
- addNode(node: InputNode): Promise<void> | void;
+ addNode(node: AnyBrandedNode): Promise<void> | void;
- addNodes(nodes: InputNode[]): Promise<void> | void;
+ addNodes(nodes: AnyBrandedNode[]): Promise<void> | void;

// packages/core/src/core/GraphBackend.ts (abstract class)
- abstract addNode(node: NodeRecord): Promise<void>;
+ abstract addNode(node: AnyBrandedNode): Promise<void>;
- abstract addNodes(nodes: NodeRecord[]): Promise<void>;
+ abstract addNodes(nodes: AnyBrandedNode[]): Promise<void>;
```

## 2. Actual Errors (Categorized)

### Category A: Inline Object Creation (7 errors)

These create objects inline without using NodeFactory:

| File | Line | Issue |
|------|------|-------|
| `ExpressAnalyzer.ts` | 207 | Creates `http:route` inline |
| `ExpressAnalyzer.ts` | 285 | Creates `express:mount` inline |
| `JSASTAnalyzer.ts` | 306 | Creates MODULE inline |
| `JSModuleIndexer.ts` | 380 | Creates MODULE inline |
| `FunctionCallResolver.ts` | 242 | Creates UNRESOLVED_CALL inline |
| `NodejsBuiltinsResolver.ts` | 101, 184 | Creates builtin:* nodes inline |
| `ExternalCallResolver.ts` | 177 | Creates external function inline |

**Fix needed:** Add missing factory methods to NodeFactory for these node types.

### Category B: Using Node Classes Directly Instead of Factory (3 errors)

These use `NodeClass.create()` directly instead of `NodeFactory.createX()`:

| File | Line | Issue |
|------|------|-------|
| `ExpressAnalyzer.ts` | 90 | `NetworkRequestNode.create()` |
| `FetchAnalyzer.ts` | 142 | `NetworkRequestNode.create()` |

**Fix needed:** Change to `NodeFactory.createNetworkRequest()` (already exists).

### Category C: GraphBuilder Buffer Type (1 error)

```typescript
// GraphBuilder.ts line 87
await graph.addNodes(this._nodeBuffer as unknown as import('@grafema/types').NodeRecord[]);
```

The `_nodeBuffer` is typed as `GraphNode[]` (a permissive interface). The `as unknown as` cast was a workaround.

**Fix needed:** Change buffer type to `AnyBrandedNode[]` and ensure all buffered nodes come from NodeFactory.

### Category D: Passing NodeRecord from Database Queries (41 errors)

Most errors are in analyzers/enrichers that:
1. Query nodes from the graph with `graph.getNode()` or `graph.getAllNodes()`
2. Create new nodes based on those results
3. Pass new nodes to `addNode()` without going through factory

Example pattern (common in ~20+ places):
```typescript
const existingNode = await graph.getNode(someId);
// ... modify or create new node based on existingNode
await graph.addNode(newNode); // ERROR: newNode is NodeRecord, not AnyBrandedNode
```

**Files with this pattern:**
- `RustAnalyzer.ts` (6 errors)
- `ReactAnalyzer.ts` (5 errors)
- `ExpressResponseAnalyzer.ts` (5 errors)
- `SocketIOAnalyzer.ts` (4 errors)
- `ServiceLayerAnalyzer.ts` (4 errors)
- `FetchAnalyzer.ts` (3 errors - beyond NetworkRequest)
- `DatabaseAnalyzer.ts` (3 errors)
- `SystemDbAnalyzer.ts` (2 errors)
- `ExpressRouteAnalyzer.ts` (2 errors)
- `IncrementalAnalysisPlugin.ts` (2 errors)
- `SQLiteAnalyzer.ts` (1 error)
- `MountPointResolver.ts` (1 error)
- `MonorepoServiceDiscovery.ts` (1 error)
- `IncrementalModuleIndexer.ts` (1 error)
- `RustModuleIndexer.ts` (1 error)
- `IncrementalReanalyzer.ts` (1 error)

## 3. Missing Factory Methods

Based on inline object creation, these factory methods are needed:

| Node Type | Factory Method | Used In |
|-----------|---------------|---------|
| `http:route` | `createHttpRoute()` | ExpressAnalyzer |
| `express:mount` | `createExpressMount()` | ExpressAnalyzer |
| `builtin:*` | `createBuiltinFunction()` | NodejsBuiltinsResolver |
| `UNRESOLVED_CALL` | `createUnresolvedCall()` | FunctionCallResolver |
| `external_function` | `createExternalFunction()` | ExternalCallResolver |

**Note:** Some of these may need new node type definitions in `@grafema/types`.

## 4. Implementation Plan

### Phase 1: Infrastructure (2 hours)

1. **Add missing node type definitions** to `@grafema/types/src/nodes.ts`:
   - `HttpRouteNodeRecord`
   - `ExpressMountNodeRecord`
   - `BuiltinFunctionNodeRecord`
   - `UnresolvedCallNodeRecord`
   - `ExternalFunctionNodeRecord`

2. **Add missing factory methods** to `NodeFactory.ts`:
   - `createHttpRoute()`
   - `createExpressMount()`
   - `createBuiltinFunction()`
   - `createUnresolvedCall()`
   - `createExternalFunction()`

### Phase 2: Fix Category B - Direct Node Class Usage (10 min)

Replace direct `NodeClass.create()` calls with `NodeFactory.createX()`:
- `ExpressAnalyzer.ts:90`
- `FetchAnalyzer.ts:142`

### Phase 3: Fix Category A - Inline Object Creation (1 hour)

Update analyzers to use new factory methods:
- `ExpressAnalyzer.ts` - use `createHttpRoute()`, `createExpressMount()`
- `JSASTAnalyzer.ts` - use existing `createModule()` or `createModuleWithContext()`
- `JSModuleIndexer.ts` - use existing `createModule()` or `createModuleWithContext()`
- `FunctionCallResolver.ts` - use `createUnresolvedCall()`
- `NodejsBuiltinsResolver.ts` - use `createBuiltinFunction()`
- `ExternalCallResolver.ts` - use `createExternalFunction()`

### Phase 4: Fix Category C - GraphBuilder Buffer (30 min)

1. Change `GraphNode` interface to extend `AnyBrandedNode` or replace with it
2. Or: Change `_nodeBuffer` type and ensure all buffered nodes are branded

### Phase 5: Fix Category D - NodeRecord from Queries (3-4 hours)

For each analyzer that queries nodes and creates new ones:
1. Identify the pattern (creating new node vs. passing through existing)
2. For new nodes: route through appropriate factory method
3. For pass-through of existing nodes: consider if they need re-branding

**Key insight:** Nodes retrieved from the database were originally created via NodeFactory, so they ARE branded at creation time. The issue is TypeScript loses this type information when going through the database.

**Options:**
1. **Trust the database:** Create a helper `brandFromDb<T>(node: T): BrandedNode<T>` for nodes coming from queries
2. **Re-brand existing nodes:** When passing through, call `brandNode()` on them
3. **Change return types:** Have `graph.getNode()` return `AnyBrandedNode | null`

Option 3 is most correct but requires changes to RFDBServerBackend and tests.

### Phase 6: Update Tests (1-2 hours)

Test files that create inline nodes will need updates:
- Use NodeFactory for test node creation
- Or use a test helper that brands nodes

## 5. Risk Assessment

### Low Risk
- Adding new factory methods is purely additive
- Changing direct `NodeClass.create()` to `NodeFactory.createX()` is mechanical

### Medium Risk
- GraphBuilder buffer type change - needs careful review of all buffer usages
- Database query return type changes - may have ripple effects

### High Risk (Needs Discussion)
- **Category D pattern is systemic** - 41 errors across 16 files
- The fundamental question: Should `graph.getNode()` return branded or unbranded nodes?

## 6. Recommended Approach

Given the scope, I recommend a **two-phase rollout**:

**Phase 2A (This PR):**
1. Add missing factory methods (Phase 1)
2. Fix Categories A, B, C (direct violations)
3. For Category D: Add `brandFromDb()` helper and use it at query sites
4. This gets us to green build while preserving the branded guarantee

**Phase 2B (Follow-up PR):**
1. Consider changing `GraphBackend.getNode()` to return `AnyBrandedNode`
2. This would eliminate the need for `brandFromDb()` calls
3. Requires more extensive changes to RFDBServerBackend

## 7. Estimate

| Phase | Effort |
|-------|--------|
| Phase 1: Infrastructure | 2 hours |
| Phase 2: Direct Node Class | 10 min |
| Phase 3: Inline Creation | 1 hour |
| Phase 4: GraphBuilder | 30 min |
| Phase 5: Category D (with helper) | 2-3 hours |
| Phase 6: Tests | 1-2 hours |
| **Total** | **7-9 hours** |

## 8. Questions for Review

1. **brandFromDb() approach acceptable?** This is a practical solution but technically allows unbranded nodes from external sources to be marked as branded. The alternative is changing all query return types.

2. **New node types needed?** Should `http:route`, `express:mount`, etc. have proper type definitions, or can they remain generic with type strings?

3. **Priority on Category D?** 41 errors is significant. Should we batch them or fix incrementally?

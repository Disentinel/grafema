# Joel Spolsky: Technical Specification for REG-198

## Executive Summary

This spec details the implementation steps to enforce `AnyBrandedNode` in `GraphBackend.addNode()`. Based on Don's analysis of 52 errors across 23 files, I recommend a phased approach that:

1. Adds a `brandFromDb()` helper for database-retrieved nodes (pragmatic solution)
2. Creates missing factory methods for inline node creation
3. Fixes all direct violations systematically

**Total estimate: 7-9 hours** (aligns with Don's assessment)

---

## Decision: `brandFromDb()` Approach

### Analysis of Options

**Option 1: `brandFromDb()` helper** (Don's recommendation)
- **Pros:**
  - Minimal scope - only add calls at 41 sites
  - Preserves existing `getNode()` return type
  - Clear semantic: "I trust this node came from the database"
  - Lower risk - no interface changes
- **Cons:**
  - Technically allows misuse (branding non-DB nodes)
  - 41 call sites to update

**Option 2: Change `getNode()` return type to `AnyBrandedNode | null`**
- **Pros:**
  - Cleaner - no manual branding at query sites
  - Type system enforces correctness
- **Cons:**
  - Changes public interface in `@grafema/types`
  - Requires updates to RFDBServerBackend, all test mocks
  - Ripple effects across codebase
  - Higher risk for this PR

### Recommendation

**Use Option 1 (`brandFromDb()`) for this PR.** It's pragmatic, lower risk, and achieves the goal. Option 2 can be tackled in a follow-up PR (REG-XXX) after this foundation is solid.

### `brandFromDb()` Location

Place in `@grafema/types/src/branded.ts` alongside `brandNode()`:

```typescript
/**
 * Brand a node retrieved from the database.
 *
 * Nodes stored in the database were originally created via NodeFactory,
 * so they ARE branded at creation time. This function restores the brand
 * after TypeScript loses the type information through database round-trip.
 *
 * IMPORTANT: Only use for nodes from graph.getNode() / graph.queryNodes().
 * Do NOT use to bypass NodeFactory for new node creation.
 *
 * @internal Used by enrichment plugins
 */
export function brandFromDb<T extends BaseNodeRecord>(node: T): BrandedNode<T> {
  return node as BrandedNode<T>;
}
```

**Why in branded.ts:** Keeps all branding utilities together. Same module as `brandNode()`.

---

## Implementation Steps

### Phase 1: Infrastructure (2 hours)

#### Step 1.1: Add `brandFromDb()` helper

**File:** `packages/types/src/branded.ts`

Add after `brandNode()` (line 74):

```typescript
/**
 * Brand a node retrieved from the database.
 *
 * Nodes stored in the database were originally created via NodeFactory,
 * so they ARE branded at creation time. This function restores the brand
 * after TypeScript loses the type information through database round-trip.
 *
 * IMPORTANT: Only use for nodes from graph.getNode() / graph.queryNodes().
 * Do NOT use to bypass NodeFactory for new node creation.
 *
 * @internal Used by enrichment plugins
 */
export function brandFromDb<T extends BaseNodeRecord>(node: T): BrandedNode<T> {
  return node as BrandedNode<T>;
}
```

**Export:** Add to `packages/types/src/index.ts`:
```typescript
export { brandNode, brandFromDb, isBrandedNode } from './branded.js';
```

**Test:** `npm run build` in packages/types

#### Step 1.2: Update GraphBackend interface

**File:** `packages/types/src/plugins.ts` (lines 235-239)

Change:
```typescript
export interface GraphBackend {
  addNode(node: InputNode): Promise<void> | void;
  addNodes(nodes: InputNode[]): Promise<void> | void;
```

To:
```typescript
import type { AnyBrandedNode } from './branded.js';

export interface GraphBackend {
  addNode(node: AnyBrandedNode): Promise<void> | void;
  addNodes(nodes: AnyBrandedNode[]): Promise<void> | void;
```

**Also update:** `packages/core/src/core/GraphBackend.ts` (abstract class):
```typescript
abstract addNode(node: AnyBrandedNode): Promise<void>;
abstract addNodes(nodes: AnyBrandedNode[]): Promise<void>;
```

**Test:** `npm run build` - expect 52 errors (this is expected, we fix them next)

#### Step 1.3: Add missing node type definitions

**File:** `packages/types/src/nodes.ts`

Add these interfaces (after line 286, before NodeRecord union):

```typescript
// Express mount node
export interface ExpressMountNodeRecord extends BaseNodeRecord {
  type: 'express:mount';
  prefix: string;
  targetFunction?: string | null;
  targetVariable?: string | null;
  mountedOn: string;
}

// Builtin function node (Node.js builtins)
export interface BuiltinFunctionNodeRecord extends BaseNodeRecord {
  type: 'EXTERNAL_FUNCTION';
  isBuiltin: boolean;
  security?: string;
  pure?: boolean;
}

// Unresolved call node
export interface UnresolvedCallNodeRecord extends BaseNodeRecord {
  type: 'UNRESOLVED_CALL';
  callee: string;
  reason?: string;
}

// External function node (non-builtin external)
export interface ExternalFunctionNodeRecord extends BaseNodeRecord {
  type: 'EXTERNAL_FUNCTION';
}

// External module node
export interface ExternalModuleNodeRecord extends BaseNodeRecord {
  type: 'EXTERNAL_MODULE';
}
```

Update `NodeRecord` union (around line 289):
```typescript
export type NodeRecord =
  | FunctionNodeRecord
  | ClassNodeRecord
  // ... existing types ...
  | ExpressMountNodeRecord
  | BuiltinFunctionNodeRecord
  | UnresolvedCallNodeRecord
  | ExternalFunctionNodeRecord
  | ExternalModuleNodeRecord
  | BaseNodeRecord; // fallback
```

#### Step 1.4: Add missing factory methods

**File:** `packages/core/src/core/NodeFactory.ts`

Add these methods (after `createIssue`, around line 664):

```typescript
/**
 * Create express:mount node
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
) {
  const id = `express:mount#${prefix}#${file}#${line}`;
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

/**
 * Create http:route node
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
) {
  const id = `http:route#${method}:${path}#${file}#${line}`;
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

/**
 * Create EXTERNAL_FUNCTION node for builtins
 */
static createBuiltinFunction(
  moduleName: string,
  functionName: string,
  options: {
    security?: string;
    pure?: boolean;
  } = {}
) {
  const id = `EXTERNAL_FUNCTION:${moduleName}.${functionName}`;
  return brandNode({
    id,
    type: 'EXTERNAL_FUNCTION' as const,
    name: `${moduleName}.${functionName}`,
    file: '',
    line: 0,
    isBuiltin: true,
    ...(options.security && { security: options.security }),
    ...(options.pure !== undefined && { pure: options.pure }),
  });
}

/**
 * Create UNRESOLVED_CALL node
 */
static createUnresolvedCall(
  callee: string,
  file: string,
  line: number,
  column: number,
  options: { reason?: string } = {}
) {
  const id = `UNRESOLVED_CALL#${callee}#${file}#${line}#${column}`;
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

/**
 * Create generic EXTERNAL_FUNCTION node (non-builtin)
 */
static createExternalFunction(
  moduleName: string,
  functionName: string
) {
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

**Test:** `npm run build` in packages/core - still expect errors, but NodeFactory should compile

---

### Phase 2: Fix Category B - Direct Node Class Usage (10 min)

These use `NodeClass.create()` directly instead of `NodeFactory.createX()`.

#### Step 2.1: ExpressAnalyzer.ts line 90

**File:** `packages/core/src/plugins/analysis/ExpressAnalyzer.ts`

Change line 90 from:
```typescript
const networkNode = NetworkRequestNode.create();
await graph.addNode(networkNode);
```

To:
```typescript
const networkNode = NodeFactory.createNetworkRequest();
await graph.addNode(networkNode);
```

Add import at top:
```typescript
import { NodeFactory } from '../../core/NodeFactory.js';
```

Remove unused import:
```typescript
// Remove: import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';
```

#### Step 2.2: FetchAnalyzer.ts line 142

**File:** `packages/core/src/plugins/analysis/FetchAnalyzer.ts`

Find `NetworkRequestNode.create()` and change to `NodeFactory.createNetworkRequest()`.

Add import:
```typescript
import { NodeFactory } from '../../core/NodeFactory.js';
```

**Test after Phase 2:** `npx tsc --noEmit` in packages/core - errors should decrease by 2-3

---

### Phase 3: Fix Category A - Inline Object Creation (1 hour)

#### Step 3.1: ExpressAnalyzer.ts - http:route (lines 207-217)

Change from:
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

To:
```typescript
endpoints.push(
  NodeFactory.createHttpRoute(
    method,
    routePath,
    module.file!,
    getLine(node),
    getColumn(node),
    {
      localPath: routePath,
      mountedOn: objectName,
    }
  )
);
```

#### Step 3.2: ExpressAnalyzer.ts - express:mount (lines 285-295)

Change from:
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

To:
```typescript
mountPoints.push(
  NodeFactory.createExpressMount(
    prefix,
    module.file!,
    getLine(node),
    getColumn(node),
    {
      targetFunction,
      targetVariable,
      mountedOn: objectName,
    }
  )
);
```

#### Step 3.3: ExpressAnalyzer.ts - Update addNode calls

Lines 304 and 326 cast to `unknown as NodeRecord`. Change to direct usage since factory returns branded nodes:

```typescript
// Line 304: was
await graph.addNode(endpoint as unknown as NodeRecord);
// Change to:
await graph.addNode(endpoint);

// Line 326: was
await graph.addNode(mountPoint as unknown as NodeRecord);
// Change to:
await graph.addNode(mountPoint);
```

#### Step 3.4: JSASTAnalyzer.ts - MODULE inline creation

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Find line ~306 where MODULE is created inline. Should use `NodeFactory.createModule()` or `createModuleWithContext()`.

#### Step 3.5: JSModuleIndexer.ts - MODULE inline creation

**File:** `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

Find line ~380 where MODULE is created inline. Use appropriate NodeFactory method.

#### Step 3.6: FunctionCallResolver.ts - UNRESOLVED_CALL

**File:** `packages/core/src/plugins/enrichment/FunctionCallResolver.ts`

Find line ~242 and use `NodeFactory.createUnresolvedCall()`.

#### Step 3.7: NodejsBuiltinsResolver.ts - builtin nodes

**File:** `packages/core/src/plugins/enrichment/NodejsBuiltinsResolver.ts`

Lines 101 and 184 create inline objects. Use `NodeFactory.createBuiltinFunction()` and `NodeFactory.createExternalModule()`.

#### Step 3.8: ExternalCallResolver.ts - external function

**File:** `packages/core/src/plugins/enrichment/ExternalCallResolver.ts`

Line 177 creates external function inline. Use `NodeFactory.createExternalFunction()`.

**Test after Phase 3:** `npx tsc --noEmit` - errors should decrease significantly (7 fewer)

---

### Phase 4: Fix Category C - GraphBuilder Buffer (30 min)

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

#### Step 4.1: Change buffer type

Line 64:
```typescript
// From:
private _nodeBuffer: GraphNode[] = [];

// To:
private _nodeBuffer: AnyBrandedNode[] = [];
```

Add import:
```typescript
import type { AnyBrandedNode } from '@grafema/types';
```

#### Step 4.2: Update _bufferNode signature

```typescript
private _bufferNode(node: AnyBrandedNode): void {
  this._nodeBuffer.push(node);
}
```

#### Step 4.3: Update _flushNodes

Remove the `as unknown as` cast on line 87:
```typescript
// From:
await graph.addNodes(this._nodeBuffer as unknown as import('@grafema/types').NodeRecord[]);

// To:
await graph.addNodes(this._nodeBuffer);
```

#### Step 4.4: Verify all buffered nodes come from NodeFactory

Review all `_bufferNode()` calls in GraphBuilder. They should already use NodeFactory methods. If any create inline objects, convert them.

**Test:** `npx tsc --noEmit` in packages/core

---

### Phase 5: Fix Category D - Database Query Nodes (2-3 hours)

This is the bulk of the work: 41 errors across 16 files. Each site queries nodes from the database and then passes them (or derived nodes) to `addNode()`.

#### Pattern Recognition

Most Category D errors fall into two sub-patterns:

**Pattern D1: Query + Create New Node** (e.g., NodejsBuiltinsResolver)
```typescript
const existingNode = await graph.getNode(id);
if (!existingNode) {
  await graph.addNode({ id, type, name, ... }); // NEW node - use factory
}
```
Fix: Use NodeFactory for the new node creation.

**Pattern D2: Query + Pass Through** (rare in our codebase)
```typescript
const node = await graph.getNode(id);
await graph.addNode(node); // Passing DB node directly
```
Fix: Use `brandFromDb(node)`.

#### Step 5.1: Add brandFromDb import to affected files

For each file with Category D errors, add:
```typescript
import { brandFromDb } from '@grafema/types';
```

#### Step 5.2: Fix each file systematically

**Files to update (in order of error count):**

| File | Errors | Pattern |
|------|--------|---------|
| RustAnalyzer.ts | 6 | D1 |
| ReactAnalyzer.ts | 5 | D1 |
| ExpressResponseAnalyzer.ts | 5 | D1 |
| SocketIOAnalyzer.ts | 4 | D1 |
| ServiceLayerAnalyzer.ts | 4 | D1 |
| FetchAnalyzer.ts | 3 | D1 |
| DatabaseAnalyzer.ts | 3 | D1 |
| SystemDbAnalyzer.ts | 2 | D1 |
| ExpressRouteAnalyzer.ts | 2 | D1 |
| IncrementalAnalysisPlugin.ts | 2 | Mixed |
| SQLiteAnalyzer.ts | 1 | D1 |
| MountPointResolver.ts | 1 | D1 |
| MonorepoServiceDiscovery.ts | 1 | D1 |
| IncrementalModuleIndexer.ts | 1 | D1 |
| RustModuleIndexer.ts | 1 | D1 |
| IncrementalReanalyzer.ts | 1 | D1 |

#### Step 5.3: Example fix for Pattern D1 (NodejsBuiltinsResolver)

**Before (line 101):**
```typescript
const existingNode = await graph.getNode(moduleNodeId);
if (!existingNode) {
  await graph.addNode({
    id: moduleNodeId,
    type: 'EXTERNAL_MODULE',
    name: normalizedSource,
    file: '',
    line: 0
  });
}
```

**After:**
```typescript
const existingNode = await graph.getNode(moduleNodeId);
if (!existingNode) {
  await graph.addNode(
    NodeFactory.createExternalModule(normalizedSource)
  );
}
```

#### Step 5.4: Example fix for Pattern D2 (if any exist)

**Before:**
```typescript
const node = await graph.getNode(id);
if (node) {
  await graph.addNode(node); // Re-adding existing node
}
```

**After:**
```typescript
import { brandFromDb } from '@grafema/types';
// ...
const node = await graph.getNode(id);
if (node) {
  await graph.addNode(brandFromDb(node));
}
```

**Test after each file:** Run `npx tsc --noEmit` to verify error count decreases.

---

### Phase 6: Update Tests (1-2 hours)

#### Step 6.1: Find test files creating inline nodes

```bash
grep -r "addNode({" test/ --include="*.ts" | head -20
```

#### Step 6.2: Create test helper

**File:** `test/helpers/testBrand.ts`

```typescript
import { brandNode } from '@grafema/types';
import type { BaseNodeRecord, BrandedNode } from '@grafema/types';

/**
 * Test helper to brand inline nodes in test files.
 * In production, all nodes should come from NodeFactory.
 * In tests, this helper allows creating simple nodes inline.
 */
export function testBrand<T extends BaseNodeRecord>(node: T): BrandedNode<T> {
  return brandNode(node);
}
```

#### Step 6.3: Update mock graphs in tests

For test files with `MockGraph`, update `addNode` signature:

```typescript
addNode(node: AnyBrandedNode): void {
  this.nodes.set(node.id, node);
}
```

Or use the `testBrand` helper:

```typescript
import { testBrand } from '../../helpers/testBrand.js';

graph.addNode(testBrand({
  id: 'EXTERNAL_MODULE:lodash',
  type: 'EXTERNAL_MODULE',
  name: 'lodash'
}));
```

#### Step 6.4: Run full test suite

```bash
npm test
```

Fix any remaining test failures.

---

## Test Strategy

### After Each Phase

| Phase | Test Command | Expected Result |
|-------|--------------|-----------------|
| 1.1-1.2 | `npm run build -w packages/types` | Success |
| 1.2 | `npx tsc --noEmit -p packages/core` | 52 errors (expected) |
| 1.3-1.4 | `npm run build -w packages/core` | NodeFactory compiles |
| 2 | `npx tsc --noEmit -p packages/core` | ~49-50 errors |
| 3 | `npx tsc --noEmit -p packages/core` | ~42-43 errors |
| 4 | `npx tsc --noEmit -p packages/core` | ~41 errors |
| 5 | `npx tsc --noEmit -p packages/core` | 0 errors |
| 6 | `npm test` | All tests pass |

### Final Verification

1. `npm run build` - All packages compile
2. `npm test` - All tests pass
3. Run Grafema on a sample project:
   ```bash
   node packages/cli/dist/cli.js analyze ../test-project
   ```

---

## Complexity Analysis

### Time Complexity

- **Phase 1 (Infrastructure):** O(1) - Fixed number of additions
- **Phase 2 (Category B):** O(1) - 2 file changes
- **Phase 3 (Category A):** O(1) - 7 file changes
- **Phase 4 (Category C):** O(1) - 1 file change
- **Phase 5 (Category D):** O(n) where n = 41 sites
- **Phase 6 (Tests):** O(t) where t = number of test files with inline nodes

### Space Complexity

No additional runtime memory usage. Changes are purely type-level.

---

## Rollback Plan

If something goes wrong:

1. **Build fails after Phase 1:** Revert `branded.ts` and `plugins.ts` changes
2. **Tests fail after Phase 5:** Check if `brandFromDb()` is missing import
3. **Runtime errors:** Use git to identify which commit introduced the issue

**Git strategy:** Make atomic commits after each sub-phase:
- `feat(types): Add brandFromDb helper`
- `feat(types): Enforce AnyBrandedNode in GraphBackend.addNode`
- `feat(types): Add missing node type definitions`
- `feat(core): Add missing NodeFactory methods`
- `fix(core): Use NodeFactory in ExpressAnalyzer`
- ... etc.

This allows easy bisection if issues arise.

---

## Files to Modify (Complete List)

### @grafema/types
- `packages/types/src/branded.ts` - Add `brandFromDb()`
- `packages/types/src/plugins.ts` - Change `addNode()` signature
- `packages/types/src/nodes.ts` - Add missing node types
- `packages/types/src/index.ts` - Export `brandFromDb`

### @grafema/core
- `packages/core/src/core/NodeFactory.ts` - Add factory methods
- `packages/core/src/core/GraphBackend.ts` - Update abstract method signature
- `packages/core/src/plugins/analysis/ExpressAnalyzer.ts`
- `packages/core/src/plugins/analysis/FetchAnalyzer.ts`
- `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
- `packages/core/src/plugins/indexing/JSModuleIndexer.ts`
- `packages/core/src/plugins/enrichment/FunctionCallResolver.ts`
- `packages/core/src/plugins/enrichment/NodejsBuiltinsResolver.ts`
- `packages/core/src/plugins/enrichment/ExternalCallResolver.ts`
- Plus 16 more files from Category D (see Phase 5.2 table)

### Tests
- `test/helpers/testBrand.ts` (new file)
- Various test files using MockGraph

---

## Open Questions for Review

1. **Factory method names:** Should `createBuiltinFunction` vs `createExternalFunction` be consolidated? They both create `EXTERNAL_FUNCTION` type.

2. **Test helper location:** Is `test/helpers/testBrand.ts` the right place, or should it be in a test utilities package?

3. **Node type definitions:** Some types like `BuiltinFunctionNodeRecord` and `ExternalFunctionNodeRecord` share the same `type: 'EXTERNAL_FUNCTION'`. Should they be merged into one?

---

*Spec complete. Ready for Kent (tests) and Rob (implementation).*

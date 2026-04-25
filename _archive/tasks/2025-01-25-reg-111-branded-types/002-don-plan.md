# Don Melton: High-Level Plan for REG-111

## Analysis Summary

After reviewing the codebase:

1. **NodeFactory** exists at `packages/core/src/core/NodeFactory.ts` with 30+ static methods
2. **Problem confirmed**: ExpressAnalyzer (lines 204-213, 282-283) creates nodes inline, bypassing factory
3. **GraphBackend.addNode** accepts `NodeRecord` — no type narrowing
4. **Type system has gaps**: Three layers (constants, record interfaces, node classes) aren't unified

## Recommended Approach: Branded Types (Option 1)

### Why Branded Types over Private Constructor

1. **Less invasive** — doesn't require changing all node classes to true classes
2. **Compile-time safety** — TypeScript catches violations before runtime
3. **Backward compatible** — existing valid code continues to work
4. **Works with current structure** — NodeFactory already returns record objects

## Implementation Plan

### Step 1: Define Branded Type (types package)

Create `packages/types/src/branded.ts`:

```typescript
declare const NODE_BRAND: unique symbol;
export type BrandedNode<T extends BaseNodeRecord> = T & { readonly [NODE_BRAND]: true };
export type AnyBrandedNode = BrandedNode<NodeRecord>;
```

### Step 2: Update NodeFactory Return Types

Each factory method returns `BrandedNode<SpecificNodeRecord>`:

```typescript
static createFunction(...): BrandedNode<FunctionNodeRecord> {
  const node = { ... };
  return node as BrandedNode<FunctionNodeRecord>;
}
```

### Step 3: Update GraphBackend Interface

Change `addNode` and `addNodes` to accept only branded nodes:

```typescript
abstract addNode(node: AnyBrandedNode): Promise<void>;
abstract addNodes(nodes: AnyBrandedNode[]): Promise<void>;
```

### Step 4: Fix Inline Creation Sites

Migrate ExpressAnalyzer inline creation to NodeFactory methods:
- Add `NodeFactory.createHttpRoute()`
- Add `NodeFactory.createExpressMount()`
- Update ExpressAnalyzer to use factory

### Step 5: Update Tests

Tests that create inline nodes for mocking will need updates:
- Either use NodeFactory
- Or use type assertion with explicit comment for test-only code

## Files to Modify

1. `packages/types/src/branded.ts` — NEW
2. `packages/types/src/index.ts` — export branded types
3. `packages/core/src/core/NodeFactory.ts` — return branded types
4. `packages/core/src/core/GraphBackend.ts` — accept branded types
5. `packages/core/src/plugins/analysis/ExpressAnalyzer.ts` — use factory
6. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` — remove `as unknown as` cast

## Risk Assessment

**Low risk** — This is additive type safety:
- Doesn't change runtime behavior
- Existing NodeFactory calls already comply
- Only inline creation sites need migration

## Alignment with Vision

This enforces the "single source of truth" pattern for node creation, which aligns with Grafema's goal of being a reliable code graph. Type safety at the node creation layer prevents graph corruption from invalid nodes.

## Recommendation

Proceed with implementation. Mini-MLA is appropriate — no architectural concerns.

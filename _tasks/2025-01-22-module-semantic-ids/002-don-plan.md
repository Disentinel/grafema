# Don Melton - Analysis & Plan for REG-126

## Summary of Findings

### 1. Current MODULE ID Generation (Problem)

**ModuleNode.ts** (line 42):
```typescript
id: `MODULE:${contentHash}`
```

Creates hash-based IDs like:
```
MODULE:d35ecb7a760522e501e4ac32019175bf0558879058acfc99d543d0e2e37d11df
```

### 2. Expected Semantic ID Format (From Spec)

Per the Joel specification in `009-joel-semantic-id-revised.md`:
```
MODULE:        {file}->global->MODULE->module
```

Example: `src/handlers/user.js->global->MODULE->module`

This is already tested in `SemanticId.test.js` lines 52-57:
```javascript
it('should generate ID for MODULE node', () => {
  const context = { file: 'src/index.js', scopePath: [] };
  const id = computeSemanticId('MODULE', 'module', context);
  assert.strictEqual(id, 'src/index.js->global->MODULE->module');
});
```

### 3. Multiple ID Formats Currently in Use

THREE different formats being used for MODULE IDs:

1. **ModuleNode.ts**: `MODULE:${contentHash}` - The contract class
2. **JSModuleIndexer.ts**: Uses `ModuleNode` via `NodeFactory.createModule()`, but also directly constructs `MODULE:${fileHash}` for edges
3. **IncrementalModuleIndexer.ts**: `${file}:MODULE:${file}:0` - Legacy colon format

### 4. How Other Nodes Use Semantic IDs

Looking at `ClassNode.ts`, `FunctionNode.ts`, etc. - they follow a dual-API pattern:

```typescript
// LEGACY: line-based IDs for backward compatibility
static create(...) {
  return {
    id: `${file}:CLASS:${name}:${line}`,
    ...
  };
}

// NEW: semantic IDs with context
static createWithContext(name, context, location, options) {
  const id = computeSemanticId(this.TYPE, name, context);
  return {
    id,
    ...
  };
}
```

### 5. Missing from ModuleNode

`ModuleNode` is missing the `createWithContext()` method that other nodes have. It only has the legacy `create()` method with hash-based IDs.

## High-Level Plan

### Phase 1: Update ModuleNode Contract

Add `createWithContext()` to `ModuleNode.ts` following the established pattern.

### Phase 2: Update NodeFactory

Add `createModuleWithContext()` method.

### Phase 3: Update Consumers

1. **JSModuleIndexer.ts** - Use new semantic ID method
2. **IncrementalModuleIndexer.ts** - Use new semantic ID method
3. **VersionManager.ts** - Update MODULE ID format

### Phase 4: Update Edge References

Anywhere that constructs MODULE IDs directly for edges needs updating.

## Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/core/nodes/ModuleNode.ts` | Add `createWithContext()` method |
| `packages/core/src/core/NodeFactory.ts` | Add `createModuleWithContext()` method |
| `packages/core/src/plugins/indexing/JSModuleIndexer.ts` | Use semantic ID for MODULE nodes and edges |
| `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts` | Use semantic ID format |
| `packages/core/src/core/VersionManager.ts` | Update MODULE ID generation |

## Considerations and Risks

### 1. Edge Reference Consistency

**CRITICAL**: When MODULE IDs change, all edge references must also change.

### 2. Database Migration

Per the spec's "Atomic Cleanup Approach" - running `grafema db:clear` before deploying is the cleanest solution.

### 3. Test Updates

The integration test at `SemanticId.test.js` already expects the correct format.

### 4. contentHash Still Needed

The `contentHash` property should remain as a node attribute for change detection - it just shouldn't be part of the ID.

### 5. Unique Identification

With semantic ID format `{file}->global->MODULE->module`, uniqueness is guaranteed by the file path.

## Verdict

This is a straightforward alignment fix. The semantic ID infrastructure already exists and is tested. We just need to:
1. Add `createWithContext()` to ModuleNode (following existing pattern)
2. Update all consumers to use it
3. Ensure edge references use the same format

**This is the RIGHT way to do it** - not a hack, not a workaround, just completing the semantic ID migration.

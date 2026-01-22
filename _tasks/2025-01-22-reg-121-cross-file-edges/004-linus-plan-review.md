# Linus Torvalds - Plan Review

## Verdict: CONDITIONAL APPROVAL

The plan is architecturally correct but technically incomplete.

## The Good

1. **Diagnosis is CORRECT** - Race condition exists in `createImportExportEdges()`
2. **Duplication IS the problem** - Two places create IMPORTS_FROM edges
3. **ImportExportLinker is the right solution** - Builds indexes first, then creates edges

## Issues Found

### Issue 1: bufferImportNodes() Must Stay

GraphBuilder creates TWO types of IMPORTS edges:
- Line 524: `MODULE -> IMPORTS -> EXTERNAL_MODULE` (for npm packages)
- Line 1359: `MODULE -> IMPORTS -> MODULE` (for relative imports)

**bufferImportNodes() should STAY** because:
- EXTERNAL_MODULE nodes are NOT cross-file (virtual singletons)
- Correctly handles IMPORT node creation (intra-file)
- Only relative MODULE -> IMPORTS -> MODULE edges need to move

### Issue 2: CLASS Assignments Need Clarification

`createClassAssignmentEdges()` is problematic for same reason but:
- InstanceOfResolver only handles `INSTANCE_OF` edges, not `ASSIGNED_FROM`
- Need either: extend InstanceOfResolver, OR leave it for now

### Issue 3: Duplicate Check Unnecessary

Joel's proposed duplicate check is inefficient:
```typescript
const existingEdges = await graph.getOutgoingEdges(sourceModule.id, ['IMPORTS']);
```
When all edges come from enrichment, duplicates are architecturally impossible.

## Approved Changes

1. **Remove `createImportExportEdges()`** from GraphBuilder
2. **Keep `bufferImportNodes()` intact** - handles IMPORT nodes + EXTERNAL_MODULE correctly
3. **Add `MODULE -> IMPORTS -> MODULE`** edge creation to ImportExportLinker (no duplicate check needed)

## Recommended Scope

For REG-121, focus ONLY on IMPORTS_FROM edges:
- Fix the import edge race condition
- Leave `createClassAssignmentEdges()` for separate issue (different scope)

This fixes the reported bug without scope creep.

## Risk Assessment

- **LOW**: Import edges should work correctly after fix
- **NONE for CLASS**: Leave existing behavior, create separate issue if needed

# Joel Spolsky - Technical Implementation Plan for REG-121

## Executive Summary

The root cause is a race condition in cross-file edge creation. `GraphBuilder.createImportExportEdges()` queries for target nodes during per-file analysis, but those nodes may not exist yet when files are processed in parallel batches.

**Solution:** Remove redundant cross-file edge creation from `GraphBuilder`. Rely solely on `ImportExportLinker` (enrichment phase) which already creates `IMPORTS_FROM` edges after all files are analyzed.

---

## Detailed Analysis of Current Code

### GraphBuilder.build() - The Problem Location

File: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

```typescript
// FLUSH: Write all nodes first, then edges in single batch calls
const nodesCreated = await this._flushNodes(graph);
const edgesCreated = await this._flushEdges(graph);

// Handle async operations that need graph queries (IMPORTS_FROM edges)
const importExportEdges = await this.createImportExportEdges(module, imports, exports, graph, projectPath);

// Handle async operations for ASSIGNED_FROM with CLASS lookups
const classAssignmentEdges = await this.createClassAssignmentEdges(variableAssignments, graph);
```

**Two problematic methods:**
1. `createImportExportEdges()` - Creates IMPORTS_FROM edges + MODULE->IMPORTS->MODULE edges
2. `createClassAssignmentEdges()` - Creates ASSIGNED_FROM edges for CLASS instantiations

Both methods query the graph for nodes that may not exist yet.

### ImportExportLinker - The Solution Already Exists

File: `packages/core/src/plugins/enrichment/ImportExportLinker.ts`

This enrichment plugin (priority 90) already:
1. Builds an export index: `Map<file, Map<exportKey, exportNode>>`
2. Builds a module lookup: `Map<file, moduleNode>`
3. Processes all IMPORT nodes
4. Creates `IMPORTS_FROM` edges correctly (after all files are analyzed)

**What it's missing:** MODULE -> IMPORTS -> MODULE edges (currently created by GraphBuilder).

---

## Implementation Plan

### Phase 1: Remove Cross-File Edge Creation from GraphBuilder

#### Step 1.1: Remove `createImportExportEdges()` call

In `build()` method, remove the call and update return statement.

#### Step 1.2: Remove `createImportExportEdges()` method entirely

Remove the entire method (~110 lines).

#### Step 1.3: Remove `createClassAssignmentEdges()` call

In `build()` method, remove the call.

#### Step 1.4: Remove `createClassAssignmentEdges()` method entirely

Remove the entire method (~30 lines).

---

### Phase 2: Enhance ImportExportLinker to Create MODULE->IMPORTS->MODULE Edges

Add MODULE -> IMPORTS -> MODULE edge creation in ImportExportLinker after resolving IMPORTS_FROM:

```typescript
// Also create MODULE -> IMPORTS -> MODULE edge
const sourceModule = modulesByFile.get(imp.file!);
const targetModule = modulesByFile.get(targetFile);
if (sourceModule && targetModule) {
  // Create edge only if it doesn't exist (avoid duplicates)
  const existingEdges = await graph.getOutgoingEdges(sourceModule.id, ['IMPORTS']);
  const alreadyExists = existingEdges.some(e => e.dst === targetModule.id);
  if (!alreadyExists) {
    await graph.addEdge({
      type: 'IMPORTS',
      src: sourceModule.id,
      dst: targetModule.id
    });
    edgesCreated++;
  }
}
```

---

### Phase 3: Handle CLASS Assignments

Either create a new `ClassAssignmentResolver` enrichment plugin or verify that `InstanceOfResolver` already handles this case.

---

### Phase 4: Update Tests

1. Existing `ClearAndRebuild.test.js` test should pass after fix
2. Create new test for MODULE -> IMPORTS -> MODULE edges

---

## Execution Order (TDD)

1. Write tests first that verify cross-file edges after clear
2. Remove GraphBuilder cross-file code
3. Enhance ImportExportLinker with MODULE edges
4. Handle CLASS assignments if needed
5. Run full test suite

---

## Edge Cases to Consider

1. **Circular imports:** A -> B -> A - ImportExportLinker handles this
2. **Re-exported modules:** `export { foo } from './bar'` - Already handled
3. **Namespace imports:** `import * as foo from './bar'` - Keep current behavior
4. **Type-only imports:** Should still create IMPORTS_FROM edges

---

## Files to Modify

1. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Remove cross-file methods
2. `packages/core/src/plugins/enrichment/ImportExportLinker.ts` - Add MODULE edges
3. `test/unit/ClearAndRebuild.test.js` - Verification test

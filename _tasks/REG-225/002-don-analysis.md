# REG-225: Don Melton - High-Level Analysis

## Summary

FunctionCallResolver is an enrichment plugin to resolve CALL_SITE -> FUNCTION edges for imported functions. This is a **bug fix**, not a new feature - internal function calls should resolve to their definitions regardless of whether the function is in the same file or imported.

## Current State

### What Works
- GraphBuilder creates CALL_SITE nodes for function calls
- GraphBuilder creates CALLS edges **only for same-file functions** (line 374):
  ```typescript
  const targetFunction = functions.find(f => f.name === targetFunctionName);
  if (targetFunction) {
    this._bufferEdge({ type: 'CALLS', src: callData.id, dst: targetFunction.id });
  }
  ```
- ImportExportLinker creates IMPORTS_FROM edges linking IMPORT -> EXPORT

### What's Missing
When `foo()` is called and `foo` comes from `import { foo } from './utils'`:
1. CALL_SITE exists with name='foo'
2. IMPORT exists with local='foo' (the local binding name)
3. IMPORTS_FROM edge connects IMPORT -> EXPORT
4. **NO CALLS edge** exists from CALL_SITE to the actual FUNCTION

### The Chain to Follow
```
CALL_SITE(name='foo')
  -> find IMPORT(local='foo', same file)
    -> IMPORTS_FROM -> EXPORT(name='foo')
      -> EXPORT.local field matches FUNCTION.name
        -> CREATE CALLS edge
```

**Critical insight**: EXPORT nodes have a `local` field that references the local name of the exported entity. For `export function foo(){}`, the EXPORT has name='foo' and local='foo'. The FUNCTION node has name='foo' in the same file. This is the connection point.

## Files to Create/Modify

### Create: `packages/core/src/plugins/enrichment/FunctionCallResolver.ts`

New enrichment plugin following the established pattern:
- Extends `Plugin` base class
- Metadata: phase='ENRICHMENT', priority=80 (after ImportExportLinker at 90)
- Execute method that processes CALL_SITE nodes

### Create: Test file (TBD by Kent)

Test cases from user request:
- Named imports: `import { foo } from './utils'; foo();`
- Default imports: `import foo from './utils'; foo();`
- Namespace imports: `import * as utils from './utils'; utils.foo();`
- Re-exports: `export { foo } from './other';`

### Modify: `packages/core/src/index.ts`

Export the new plugin.

### Modify: `packages/core/src/Orchestrator.ts` (maybe)

Register the new plugin if not auto-discovered.

## Algorithm Design

### Phase 1: Build Indices

1. **Import Index**: Map<file, Map<localName, ImportNode>>
   - For each IMPORT node, index by (file, local name)
   - Skip external imports (non-relative sources)

2. **Export Index**: Map<file, Map<exportName, ExportNode>>
   - Reuse from ImportExportLinker or rebuild
   - Key by (target file, exported name)

3. **Function Index**: Map<file, Map<functionName, FunctionNode>>
   - Index all FUNCTION nodes by (file, name)

### Phase 2: Process CALL_SITE Nodes

For each CALL_SITE:
1. Check if already has CALLS edge (skip if yes)
2. Check if it's a simple function call (no `object` attribute - not a method call)
3. Look up IMPORT with matching local name in same file
4. If found:
   - Follow IMPORTS_FROM edge to get EXPORT
   - Get EXPORT's `local` field (the local identifier in source file)
   - Look up FUNCTION in source file with that name
   - Create CALLS edge: CALL_SITE -> FUNCTION

### Special Cases

#### Default Imports
`import foo from './utils'` creates:
- IMPORT with importType='default'
- Need to find EXPORT with exportType='default'
- EXPORT.local gives the function name

#### Namespace Imports
`import * as utils from './utils'; utils.foo();`
- This is actually a METHOD_CALL (has `object` attribute)
- FunctionCallResolver may skip these, let MethodCallResolver handle
- OR: detect namespace pattern, resolve utils.foo -> foo in source file

#### Re-exports
`export { foo } from './other'`
- EXPORT has `source` field pointing to './other'
- Need to follow the re-export chain
- May require recursive resolution (could be multiple hops)

## Architecture Concerns

### 1. Priority Ordering
- ImportExportLinker: priority 90 (creates IMPORTS_FROM)
- **FunctionCallResolver: priority 80** (consumes IMPORTS_FROM)
- MethodCallResolver: priority 50 (also creates CALLS edges)

This is correct: higher priority = runs earlier in ENRICHMENT phase.

### 2. Edge Existence Check
Must check `graph.getOutgoingEdges(callSite.id, ['CALLS'])` before creating new edges to avoid duplicates. Same pattern as MethodCallResolver.

### 3. Performance
The task spec requires <100ms for 1000 imports. This means:
- Build indices once: O(n) where n = number of imports/exports/functions
- Process calls: O(m) where m = number of CALL_SITE nodes
- Use O(1) Map lookups, not O(n) array.find()

### 4. Missing IMPORTS_FROM Edges
If ImportExportLinker didn't create IMPORTS_FROM (e.g., file not analyzed yet), we can't resolve. This is expected behavior - enrichment plugins must tolerate incomplete data.

### 5. No EXPORT -> FUNCTION Direct Edge
Currently there's no direct edge from EXPORT to the FUNCTION it exports. The connection is implicit through:
- EXPORT.local = local name in exporting module
- FUNCTION.name = function name
- Same file relationship

This is a potential improvement for a future task, but for now FunctionCallResolver must do the lookup by name.

## Questions for Clarification

1. **Namespace imports**: Should FunctionCallResolver handle `utils.foo()` where `utils` is a namespace import? Or leave to MethodCallResolver?
   - **Recommendation**: Leave to MethodCallResolver for now. It already handles method calls.

2. **Re-export chains**: How deep should we follow? What about circular re-exports?
   - **Recommendation**: Single hop for v1. Create a separate issue for deep re-export resolution if needed.

3. **CommonJS require()**: Explicitly out of scope per task description.

4. **Dynamic imports**: Explicitly out of scope per task description.

## Patterns to Follow

From ImportExportLinker and MethodCallResolver:
- Use `this.log(context)` for structured logging
- Report progress with `onProgress` callback
- Return `createSuccessResult()` with counts and summary
- Build indices first, then process in a single pass
- Skip already-resolved nodes

## Risk Assessment

**Low risk**: This is a targeted enrichment plugin with clear boundaries:
- Only creates CALLS edges
- Only processes CALL_SITE nodes without existing CALLS
- Follows established patterns from existing plugins
- Clear test cases defined

**Potential edge cases**:
- Functions with same name in different scopes (handle via file-level scoping)
- Arrow functions assigned to variables (`const foo = () => {}; export { foo }`)
- Aliased exports (`export { bar as foo }`)

These should be covered by tests but may surface additional complexity.

## Conclusion

The task is well-scoped and follows established patterns. The implementation should be straightforward:
1. Create FunctionCallResolver class following MethodCallResolver pattern
2. Build indices for imports, exports, functions
3. For each unresolved CALL_SITE, trace through IMPORT -> EXPORT -> FUNCTION
4. Create CALLS edge

Estimated effort: Medium (well-defined scope, but needs careful handling of import variants).

Ready for Joel to create detailed technical spec.

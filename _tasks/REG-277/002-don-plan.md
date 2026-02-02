# Don Melton — Tech Lead Analysis for REG-277

## 1. Current Architecture Summary

### Call Resolution Pipeline
The codebase uses **resolver plugins** running in ENRICHMENT phase with priority ordering:

1. **ImportExportLinker** (priority 90) - EARLIEST
   - Creates IMPORTS_FROM edges between IMPORT and EXPORT nodes
   - Handles relative imports only (skips external packages)
   - Builds export index: Map<file, Map<exportKey, ExportNode>>
   - Export keys: "default" | "named:functionName" | "all"

2. **FunctionCallResolver** (priority 80)
   - Creates CALLS edges for imported function calls
   - Only processes relative imports (skips external)
   - Follows IMPORT -> IMPORTS_FROM -> EXPORT chain
   - **Has re-export chain resolution**: resolveExportChain() method
   - Returns null if chain is broken or external (not a known file)

3. **ExternalCallResolver** (priority 70) - LATEST
   - Creates CALLS edges to EXTERNAL_MODULE nodes
   - Only processes external imports (non-relative)
   - Recognizes JS builtins (parseInt, setTimeout, etc.)
   - Creates EXTERNAL_MODULE nodes lazily with packageName as ID

### Edge Structure
- IMPORTS_FROM edges: IMPORT → EXPORT (created by ImportExportLinker)
- CALLS edges:
  - CALL → FUNCTION (internal functions)
  - CALL → EXTERNAL_MODULE (external packages)
  - Metadata: { exportedName: "original_name" } for external calls

### EXPORT Node Structure
```typescript
interface ExportNode {
  id: string;
  type: 'EXPORT';
  name: string;              // Export name visible to importers
  file: string;              // File where export is defined
  line: number;
  exportType?: 'default' | 'named' | 'all';
  local?: string;            // Local name in source file
  source?: string;           // Re-export source (if export { x } from 'pkg')
}
```

**Critical**: The `source` field is populated for re-exports:
- `export { map } from 'lodash'` → source: 'lodash'
- `export * from './utils'` → source: './utils'
- Direct exports (no source field)

## 2. The Problem: Why Re-exported Externals Are Unresolved

```javascript
// utils.js
export { map } from 'lodash';

// main.js
import { map } from './utils';
map(); // UNRESOLVED
```

**What happens:**

1. **ImportExportLinker** creates:
   - IMPORT (main.js, local: 'map', source: './utils') → IMPORTS_FROM → EXPORT (utils.js, name: 'map', source: 'lodash')

2. **FunctionCallResolver** tries to resolve CALL (map):
   - Finds IMPORT with local: 'map' ✓
   - Follows IMPORTS_FROM to EXPORT (utils.js, source: 'lodash') ✓
   - Calls resolveExportChain() which:
     - Checks if exportNode.source exists → YES ('lodash')
     - Tries resolveModulePath(currentDir, 'lodash', knownFiles)
     - 'lodash' is NOT relative → resolveModulePath returns null
     - Returns null, chain broken
   - Cannot find target FUNCTION → SKIPPED

3. **ExternalCallResolver** skips it:
   - IMPORT has relative source './utils' → SKIPPED (only processes external imports)

**Root cause**: resolveExportChain() stops when it encounters an external source because:
- It only looks in knownFiles (local project files)
- External packages are not in knownFiles
- It returns null instead of detecting external re-export

## 3. The Solution: Extend FunctionCallResolver

The fix should happen in **FunctionCallResolver** because:
- It already has the re-export chain resolution logic
- It already knows about relative vs external sources
- It's the right layer: following imports to their sources

### Architecture Decision

**Option A (RECOMMENDED)**: Extend resolveExportChain() to detect external sources

Modify resolveExportChain() to:
1. Before returning null when targetFile not found
2. Check if source is non-relative (external package)
3. If external, return the export node (don't recurse)
4. Add new return type: `{ type: 'local' | 'external', export: ExportNode, packageName?: string }`

Then in Step 4.4 (after resolving chain):
- Check if result is external
- Instead of looking for FUNCTION, create CALLS to EXTERNAL_MODULE
- Use same logic as ExternalCallResolver.extractPackageName()

### Why This Works

1. **Single Responsibility**: FunctionCallResolver stays responsible for "follow the import chain"
2. **No Duplication**: Uses existing resolve logic, just extends it
3. **Handles Nesting**: Works for utils → helpers → lodash chains
4. **Handles Aliases**: Works with named re-exports: export { foo as bar } from 'lodash'
5. **Metadata**: Can pass original exportedName in edge metadata

### Implementation Points

```
FunctionCallResolver.resolveExportChain():
  Change return signature to:
    ExportNode | { type: 'external', packageName: string, exportName: string } | null

  At line 327 (when targetFile not found):
    - Check: if exportNode.source is non-relative
    - If yes:
      - Extract packageName using same logic as ExternalCallResolver
      - Return { type: 'external', packageName, exportName: exportNode.name }
    - If no: return null (broken chain)

FunctionCallResolver.execute() Step 4.4:
  After resolving chain:
    - If result is { type: 'external', packageName, exportName }:
      - Create EXTERNAL_MODULE node (lazy, check if exists first)
      - Create CALLS edge with metadata: { exportedName }
    - If result is local EXPORT node: (existing logic)
      - Follow to FUNCTION and create CALLS
```

## 4. Edge Cases & Risks

### Edge Cases Handled

1. **Nested re-exports**: utils → helpers → lodash
   - resolveExportChain() recursively follows chains
   - Works as long as all intermediate are relative (local files)
   - Stops when hitting external (returns external marker)

2. **Re-exports with aliases**: `export { map as mapping } from 'lodash'`
   - exportNode.name = 'mapping' (visible name)
   - exportNode.local = 'map' (original name)
   - Must preserve and pass original name in metadata

3. **Default re-exports**: `export { default } from 'lodash'`
   - exportNode.name = 'default'
   - Should work with existing key-building logic

4. **All-exports**: `export * from 'lodash'`
   - More complex: need to resolve individual bindings
   - Consider for v0.2 (out of scope for this issue)

### Risks

**Risk 1**: Circular re-exports (edge case)
- Current visited set prevents infinite loops
- Should continue working ✓

**Risk 2**: External source in the middle of chain
- Example: utils → npm_package → other_local
- Current logic stops at external (correct)
- Doesn't try to continue chain ✓

**Risk 3**: Non-existent packages
- Will create EXTERNAL_MODULE node (same as ExternalCallResolver)
- This is consistent behavior ✓

**Risk 4**: Package name extraction
- Reuse ExternalCallResolver.extractPackageName()
- Handles scoped packages (@scope/pkg)
- Handles subpath imports (lodash/map)
- Should be robust ✓

## 5. What Should NOT Change

- ImportExportLinker: No changes needed (already creates correct IMPORTS_FROM)
- ExternalCallResolver: No changes (handles direct external imports)
- Export node creation: No changes (already has source field)
- Re-export chain detection: Only extends, doesn't change existing logic

## 6. Testing Strategy

**Unit tests** needed in FunctionCallResolver.test.js:

1. Simple re-export from external
   - utils.js: `export { map } from 'lodash'`
   - main.js: `import { map } from './utils'; map();`
   - Assert: CALLS edge to EXTERNAL_MODULE:lodash

2. Aliased re-export
   - utils.js: `export { map as mapping } from 'lodash'`
   - main.js: `import { mapping } from './utils'; mapping();`
   - Assert: CALLS edge with exportedName: 'map'

3. Nested re-exports (local → local → external)
   - a.js → b.js → lodash
   - Assert: resolves through chain

4. Circular re-exports
   - a.js exports from b.js, b.js exports from a.js
   - Assert: returns null (broken), no edge created

5. Mixed resolution
   - Some calls resolve to functions, some to external modules
   - Assert: both edge types created correctly

## 7. High-Level Recommendation

**"This is the right place, done the right way."**

The solution is architecturally sound because:
1. **Follows existing patterns**: Uses same export chain resolution
2. **Single responsibility**: FunctionCallResolver handles import chains
3. **No cross-layer violation**: Doesn't require ExternalCallResolver to know about local imports
4. **Minimal code changes**: ~50 lines in one method
5. **No technical debt**: Solves the root problem, not a workaround

The risk is low because:
- Existing cycle detection prevents infinite loops
- External package detection is already proven (ExternalCallResolver)
- Graph structure allows lazy EXTERNAL_MODULE creation
- Metadata pattern is established

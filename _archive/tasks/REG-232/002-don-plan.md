# REG-232: Don Melton - High-Level Plan

## Analysis

### Current Architecture

FunctionCallResolver is a v1 implementation from REG-225 that creates CALLS edges for imported function calls. The resolution algorithm follows a chain:

```
CALL (in consumer.js)
  -> find IMPORT (in consumer.js, matching local name)
  -> follow IMPORTS_FROM edge -> EXPORT
  -> find FUNCTION via EXPORT.local
  -> create CALL -> CALLS -> FUNCTION edge
```

**Key data structures:**
- `importIndex`: Map<file:local, ImportNode> - O(1) lookup for imports by file and local name
- `functionIndex`: Map<file, Map<name, FunctionNode>> - O(1) lookup for functions by file and name

### Where Re-exports Are Skipped

In `FunctionCallResolver.execute()`, lines 120-125:

```typescript
// Step 4.3: Handle re-exports (EXPORT with source field)
// For v1: skip complex re-exports
if (exportNode.source) {
  skipped.reExports++;
  continue;
}
```

This is the **exact** location that needs modification.

### What a Re-export Looks Like in the Graph

```javascript
// index.js
export { foo } from './other';
```

Creates an EXPORT node:
```typescript
{
  id: 'index.js:EXPORT:foo:1',
  type: 'EXPORT',
  name: 'foo',
  file: '/project/index.js',
  exportType: 'named',
  local: 'foo',
  source: './other'  // <-- Re-export indicator
}
```

The `source` field indicates this is a re-export. The actual FUNCTION is in the source file.

## The Problem

When we have:
```javascript
// other.js
export function foo() {}

// index.js (barrel file)
export { foo } from './other';

// consumer.js
import { foo } from './index';
foo();  // <- This call is NOT resolved
```

Current behavior:
1. CALL `foo` in consumer.js
2. Find IMPORT pointing to `./index`
3. Follow IMPORTS_FROM -> EXPORT in index.js
4. EXPORT has `source: './other'` -> **SKIP**

## Solution Architecture

### Core Insight

The re-export chain is essentially a linked list:
```
EXPORT (with source) -> next EXPORT (with source) -> ... -> final EXPORT (no source) -> FUNCTION
```

We need to **follow this chain** until we reach an EXPORT without a `source` field.

### Resolution Algorithm

```
function resolveReExportChain(exportNode, visited = Set()) {
  // Circular check
  if (visited.has(exportNode.id)) {
    return null  // Circular re-export detected
  }
  visited.add(exportNode.id)

  // Base case: not a re-export
  if (!exportNode.source) {
    return exportNode
  }

  // Recursive case: follow re-export
  sourceFile = resolveSourcePath(exportNode.file, exportNode.source)
  nextExport = findExportInFile(sourceFile, exportNode.local)

  if (!nextExport) {
    return null  // Broken chain
  }

  return resolveReExportChain(nextExport, visited)
}
```

### Required Components

1. **Export Index Enhancement**
   - Current: No pre-built index (we query graph ad-hoc via IMPORTS_FROM)
   - Needed: Build export index similar to ImportExportLinker:
     ```typescript
     exportIndex: Map<file, Map<exportKey, ExportNode>>
     ```
   - Why: Efficient O(1) lookup when following re-export chains

2. **File Path Resolution**
   - Reuse pattern from ImportExportLinker (lines 101-122)
   - Try extensions: `['', '.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts']`
   - Handle both relative paths (`./other`) and directory imports

3. **Chain Resolution with Cycle Detection**
   - Track visited exports via Set<exportId>
   - Return null on cycle detection (graceful skip)
   - Limit chain depth (e.g., 10 hops) as safety net

4. **Integration Point**
   - Replace current skip logic (line 120-125) with chain resolution
   - If chain resolves: find FUNCTION and create edge
   - If chain fails (cycle, missing export): skip gracefully

## Architectural Concerns

### 1. Dependency on REG-225

REG-232 is a direct extension of FunctionCallResolver from REG-225. The implementation branch exists but is not yet merged to main.

**Decision required:** Should REG-232 wait for REG-225 merge, or should we base REG-232 on the REG-225 branch?

**Recommendation:** Wait for REG-225 merge. This is cleaner and avoids complex rebasing later.

### 2. Performance Considerations

Re-export chains add traversal complexity. For each call site with a re-export:
- Previous: O(1) - single edge lookup
- New: O(k) where k = chain length

Mitigations:
- Pre-build export index (O(n) once, O(1) lookups)
- Chain depth limit (e.g., 10)
- Typical barrel files have 1-2 hop chains

### 3. Edge Cases to Handle

| Case | Example | Expected Behavior |
|------|---------|-------------------|
| Single-hop | `export { foo } from './a'` | Resolve to FUNCTION in `./a` |
| Multi-hop | `export { foo } from './a'` -> `export { foo } from './b'` | Follow full chain |
| Circular | A re-exports from B, B re-exports from A | Detect, skip gracefully |
| Mixed (re-export then local) | `export { foo } from './a'` where `./a` has local export | Resolve correctly |
| Missing target | Source file doesn't exist or doesn't export name | Skip gracefully |
| Type re-exports | `export type { Foo } from './types'` | Skip (not function calls) |
| Default re-export | `export { default } from './a'` | Handle like named |

### 4. Code Reuse Opportunity

Both ImportExportLinker and FunctionCallResolver need:
- File path resolution with extension fallback
- Export index building

Consider extracting shared utilities:
```typescript
// packages/core/src/plugins/enrichment/utils/path-resolver.ts
export function resolveModulePath(currentDir: string, specifier: string, index: Map<string, any>): string | null

// packages/core/src/plugins/enrichment/utils/export-index.ts
export async function buildExportIndex(graph: Graph): Promise<Map<string, Map<string, ExportNode>>>
```

**However:** For this task, inline implementation is acceptable. Refactoring to shared utils is a separate concern (potential tech debt item).

## Implementation Plan

### Phase 1: Pre-requisites
- [ ] Wait for REG-225 merge (or base on REG-225 branch if approved)

### Phase 2: Test-First (Kent)
- [ ] Add test: single-hop re-export resolution
- [ ] Add test: multi-hop re-export chain (2-3 hops)
- [ ] Add test: circular re-export detection
- [ ] Add test: broken chain (missing export in chain)
- [ ] Add test: mixed chain (re-export then local export)

### Phase 3: Implementation (Rob)
- [ ] Build export index in `execute()` (before resolution loop)
- [ ] Extract `resolveExportChain()` method
- [ ] Add `resolveSourcePath()` helper (from ImportExportLinker pattern)
- [ ] Replace skip logic with chain resolution
- [ ] Update skip counters (differentiate resolved vs failed chains)

### Phase 4: Verification
- [ ] All existing tests still pass
- [ ] New re-export tests pass
- [ ] Performance check (not significantly slower)

## Alignment with Project Vision

This feature directly supports Grafema's vision: **AI should query the graph, not read code.**

Without re-export support:
- AI sees a function call
- Graph says "no CALLS edge"
- AI must read source files to follow re-export chains manually
- **This is a product gap**

With re-export support:
- AI queries: "What does this function call resolve to?"
- Graph provides: direct CALLS edge to target FUNCTION
- AI doesn't need to read source files
- **Graph is the source of truth**

Barrel files (`index.js` that re-exports from multiple modules) are common in:
- React component libraries
- Utility collections
- Any well-organized JavaScript codebase

Not supporting re-exports makes Grafema significantly less useful for real-world codebases.

## Decision Points for Review

1. **Branching strategy:** Wait for REG-225 or base on REG-225 branch?
2. **Shared utilities:** Inline now, refactor later? Or extract upfront?
3. **Chain depth limit:** 10 hops? 20? Configurable?
4. **Logging granularity:** Log each chain hop for debugging? Or just final result?

## Recommendation

**Proceed with implementation** after REG-225 is merged. The architecture is sound, the feature is well-scoped, and it directly addresses a product gap.

Priority: **High** - This blocks value tracing through barrel files, which are extremely common in JavaScript ecosystems.

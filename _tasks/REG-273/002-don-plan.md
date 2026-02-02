# Don Melton - High-Level Plan for REG-273

## Summary

**What we're doing:** Fix a bug where side-effect-only imports (`import './polyfill.js'`) are completely ignored by GraphBuilder, AND add semantic information to distinguish them from regular imports.

**Why it matters:** Side-effect imports are critical (polyfills, CSS, initialization) and should never be flagged as unused. The graph must represent them correctly.

**Scope:** Mini-MLA task - clear scope, local changes to 2 files + tests.

## Architectural Analysis

Side-effect-only imports are a fundamental semantic distinction in JavaScript/TypeScript:
```javascript
import './polyfill.js';      // Side-effect only - executes module code
import { foo } from './lib'; // Value binding - imports named export
```

These have different semantics and must be distinguished in the graph.

### Design Question: How do we represent side-effect imports?

**Current state:**
- `ImportExportVisitor` collects imports with `specifiers: []` for side-effect imports
- `GraphBuilder.bufferImportNodes()` only processes imports that have specifiers
- Side-effect imports are **completely ignored** - no nodes created

**The problem:**
```typescript
// In GraphBuilder.bufferImportNodes()
for (const spec of specifiers) {  // <-- Empty array for side-effect imports!
  const importNode = ImportNode.create(...)
}
```

When `specifiers.length === 0`, the loop doesn't run. Side-effect imports are lost.

**Decision:**
1. Add `sideEffect: boolean` field to ImportNode
2. When `specifiers.length === 0`, create a single IMPORT node for the side-effect
3. Use module source as the name (since there's no local binding)

### Design Question: What should the semantic ID be for side-effect imports?

Side-effect imports have no local binding name. Options:

**Option A:** Use source as name
- ID: `{file}:IMPORT:{source}:{source}`
- Example: `/app/index.js:IMPORT:./polyfill.js:./polyfill.js`
- Pro: Follows existing pattern
- Con: Redundant, looks weird

**Option B:** Use special marker
- ID: `{file}:IMPORT:{source}:$side-effect`
- Pro: Clear intent
- Con: Special case in ID format

**Option C:** Use empty string or '*'
- ID: `{file}:IMPORT:{source}:*`
- Pro: Similar to namespace imports
- Con: Conflicts with actual namespace imports

**Decision: Option A** - Use source as name. It's redundant but follows the existing semantic ID pattern consistently. The `sideEffect: true` field makes the intent clear.

### Design Question: Should dead code analysis exclude side-effect imports?

**Answer:** YES, absolutely. Side-effect imports are executed for their side effects:
- Polyfills that modify global objects
- CSS imports in bundlers
- Registration code (e.g., custom elements)
- Module initialization code

They should NEVER be flagged as unused, even if no bindings are used.

However, `TypeScriptDeadCodeValidator` currently only checks interfaces/enums/types. There's no general "unused import" detection yet. This is future work, but we must ensure the infrastructure is ready.

### Alignment with Project Vision

This strongly aligns with Grafema's vision:
- **AI should query graph, not read code**: Without this flag, AI can't distinguish critical side-effect imports from regular imports
- **Legacy codebase support**: Side-effect imports are common in real codebases (polyfills, CSS, etc.)
- **Correct semantics**: The graph should represent code semantics accurately

## Implementation Strategy

### Phase 1: Extend ImportNode contract
- Add `sideEffect: boolean` to ImportNodeRecord
- Update OPTIONAL fields list
- Default to `false` for backward compatibility

### Phase 2: Update ImportExportVisitor (NO CHANGE NEEDED)
- ImportExportVisitor already captures side-effect imports correctly
- `specifiers: []` is the signal

### Phase 3: Fix GraphBuilder.bufferImportNodes()
**This is where the bug lives.**

Current code:
```typescript
for (const imp of imports) {
  for (const spec of specifiers) {  // <-- Loop never runs when empty!
    const importNode = ImportNode.create(...)
  }
}
```

Fixed code:
```typescript
for (const imp of imports) {
  if (specifiers.length === 0) {
    // Side-effect import: no bindings, just execution
    const importNode = ImportNode.create(
      source,         // name = source (no local binding)
      module.file,
      line,
      column || 0,
      source,
      {
        imported: '*',     // Convention: no specific export
        local: source,     // Convention: no local name
        sideEffect: true
      }
    );
    // Buffer node and edges...
  } else {
    // Regular imports with bindings
    for (const spec of specifiers) {
      const importNode = ImportNode.create(...)
      // ... existing code
    }
  }
}
```

### Phase 4: Tests
1. **Side-effect import creates node:**
   - `import './polyfill.js'` creates IMPORT node with `sideEffect: true`
2. **Regular imports have sideEffect: false:**
   - `import { foo } from './lib'` has `sideEffect: false` (default)
3. **Graph structure:**
   - MODULE -> CONTAINS -> IMPORT for side-effect imports
   - EXTERNAL_MODULE created for external packages
4. **Multiple side-effect imports:**
   - Each creates separate IMPORT node

## Critical Files

1. **packages/core/src/core/nodes/ImportNode.ts**
   - Add `sideEffect?: boolean` to ImportNodeRecord
   - Add to OPTIONAL fields

2. **packages/core/src/plugins/analysis/ast/GraphBuilder.ts**
   - Fix `bufferImportNodes()` to handle `specifiers.length === 0`

3. **test/unit/GraphBuilderImport.test.js**
   - Add test cases for side-effect imports

## Risk Assessment

**Low risk:**
- Extends existing functionality without changing behavior of regular imports
- Backward compatible: `sideEffect` field is optional, defaults to `false`
- No changes to AST visitor (already working correctly)

**Watch out for:**
- Edge cases: side-effect imports from relative paths vs external packages
- Ensure EXTERNAL_MODULE nodes created for external side-effect imports
- Ensure MODULE -> CONTAINS edges created correctly

## Architectural Correctness

**Is this the RIGHT solution?**

YES. This is architecturally correct because:

1. **Semantic accuracy**: Side-effect imports ARE different from value imports. The graph should reflect this.

2. **Minimal change**: We're fixing a bug (side-effect imports lost) AND adding semantic information in one change.

3. **Future-proof**: When dead code analysis expands to check imports, the `sideEffect` flag will be essential.

4. **No workarounds**: We're not patching around the problem - we're fixing the root cause (empty specifiers loop) and adding proper semantic information.

This is a small, clean change that makes the graph more correct. Exactly what we want.

## Key Takeaways for Implementation Team

**For Joel (Tech Plan):**
- Focus on the `bufferImportNodes()` method - that's where the fix goes
- Need to handle `specifiers.length === 0` case explicitly
- Semantic ID decision: use source as name (redundant but consistent)

**For Kent (Tests):**
- Main test: side-effect import creates IMPORT node with `sideEffect: true`
- Test graph structure: MODULE -> CONTAINS -> IMPORT edge exists
- Test EXTERNAL_MODULE creation for external side-effect imports
- Test multiple side-effect imports in same file

**For Rob (Implementation):**
- Two-file change: ImportNode.ts + GraphBuilder.ts
- ImportNode.ts: Add optional `sideEffect?: boolean` field to OPTIONAL array
- GraphBuilder.ts: Add `if (specifiers.length === 0)` branch before the loop
- Match existing code style for EXTERNAL_MODULE and edge creation

**For Reviews:**
- Verify no behavior change to regular imports
- Verify side-effect imports now appear in graph
- Verify semantic ID format is consistent
- Verify backward compatibility (optional field)

## Next Steps

1. Joel expands this into detailed technical plan
2. Linus reviews Joel's plan
3. Iterate until approved
4. Kent → Rob → Reviews → Done

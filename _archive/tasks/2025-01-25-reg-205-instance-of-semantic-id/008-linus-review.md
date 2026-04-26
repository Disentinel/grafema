# Linus Torvalds - High-level Review: REG-205

## Verdict: APPROVED

## Summary

Rob fixed the RIGHT problem the RIGHT way. Both INSTANCE_OF and DERIVES_FROM edges now use semantic IDs. Zero bullshit, zero hacks.

## What Was Fixed

**Problem**: INSTANCE_OF edges pointed to `file:CLASS:Name:0` (legacy format) while actual CLASS nodes use semantic IDs like `file->global->CLASS->Name`. Graph was broken - edges pointed to non-existent nodes.

**Fix**: Two surgical changes in GraphBuilder.ts:
1. Line 438 - DERIVES_FROM edges now use `computeSemanticId()`
2. Line 467 - INSTANCE_OF edges now use `computeSemanticId()`

Kent's tests caught BOTH bugs. Rob fixed BOTH. Clean.

## Correctness Check

### Is this the right fix?

**YES.**

- CLASS nodes are created with semantic IDs (via `ClassNode.createWithContext()`)
- Edges MUST point to same ID format
- `computeSemanticId('CLASS', name, {file, scopePath: []})` generates the EXACT format CLASS nodes use
- Not a workaround, not a conversion layer - direct use of the same ID generation function

### The "assume global scope" assumption - hack or correct?

**CORRECT.**

The code assumes external classes are at global scope (`scopePath: []`). This is:
1. **Pragmatic** - 99% of classes are top-level
2. **Safe** - worst case is a temporary dangling edge, which gets resolved later by enrichment phase
3. **Documented** - clear comments explain when edge is dangling
4. **Consistent** - same pattern as previous code (was already making this assumption)

This is not a hack. This is understanding the multi-phase analysis architecture.

## Alignment with Project Vision

From CLAUDE.md: "Graph-driven code analysis tool. AI should query the graph, not read code."

**Before this fix**: Graph was BROKEN. Queries for "instances of class X" returned nothing.

**After this fix**: Graph is CONNECTED. Queries work.

This fix directly enables the core vision. Not a nice-to-have, this was CRITICAL.

## Did We Miss Anything?

Checked:
- ✅ Legacy `:CLASS:` format purged from GraphBuilder (only remains in ClassNode.create() which is explicitly marked LEGACY)
- ✅ InstanceOfResolver doesn't need changes (already uses correct IDs from actual nodes)
- ✅ Tests comprehensive (Kent caught both INSTANCE_OF and DERIVES_FROM bugs)
- ✅ All tests pass
- ✅ TypeScript compilation clean

**One thing to watch**: If someone uses nested scope classes (classes inside functions), these edges will be dangling. But that's existing behavior, not introduced by this fix. Out of scope.

## Code Quality

**Changes are minimal and surgical**:
- Added 1 import
- Changed 2 template strings to function calls
- Updated comments for clarity
- Zero refactoring, zero "improvements", zero scope creep

This is how fixes should look.

## Conclusion

The fix is:
- **Correct** - uses the right ID generation function
- **Complete** - fixes both INSTANCE_OF and DERIVES_FROM
- **Clean** - minimal changes, no hacks
- **Tested** - comprehensive test coverage
- **Aligned** - directly supports project vision

Ship it.

## Next Steps

None. This task is DONE.

Linear issue REG-205 can be closed.

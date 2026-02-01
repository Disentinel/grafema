# Linus Torvalds — High-Level Review for REG-277

## The Question: Did We Do The Right Thing?

**YES.** This is exactly what should have been done.

## Alignment with Project Vision

The issue was clear: re-exported external modules weren't being resolved. The solution extends the existing `resolveExportChain()` mechanism to detect when a chain terminates in an external module.

**What's right about this approach:**

1. **Minimal Change**: Only FunctionCallResolver was modified. No changes to ImportExportLinker or ExternalCallResolver.

2. **Follows Existing Patterns**: The external module handling mirrors what ExternalCallResolver does - same node ID format (`EXTERNAL_MODULE:packageName`), same metadata structure (`{ exportedName }`).

3. **Lazy Node Creation**: EXTERNAL_MODULE nodes are created only when needed. This is consistent with ExternalCallResolver's behavior.

4. **Single Responsibility Preserved**: FunctionCallResolver still does "follow the import chain" - it just now understands that chains can end in external modules, not just local functions.

## Did We Cut Corners?

**No.**

The implementation:
- Uses proper type discrimination (not any/unknown casts)
- Has cycle detection (visited set)
- Has depth limit (prevents stack overflow)
- Handles all edge cases (scoped packages, aliases, defaults)

## What Wasn't Done (And Shouldn't Be)

1. **`export * from 'lodash'`** — This would require tracking which names are actually imported from the namespace re-export. Out of scope, correctly deferred.

2. **Shared utility extraction** — The `extractPackageName()` duplication is acceptable. DRY isn't about eliminating all duplication; it's about eliminating duplication that would cause maintenance issues. This won't.

## Test Quality

Tests actually test what they claim:
- "should resolve call to simple re-export" → sets up re-export chain, asserts CALLS edge created to EXTERNAL_MODULE
- "should preserve existing behavior" → regression test ensures we didn't break local re-export resolution

## Acceptance Criteria Check

From the issue:
- [x] Re-exported external calls create CALLS to EXTERNAL_MODULE
- [x] Edge metadata includes original exportedName
- [x] Works for nested re-exports (utils -> helpers -> lodash)

All criteria met.

## Final Verdict: APPROVED ✓

This is a clean, focused implementation that extends existing behavior correctly. No hacks, no shortcuts, no architectural violations.

Ready for merge.

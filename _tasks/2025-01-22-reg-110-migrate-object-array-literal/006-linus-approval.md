# Linus Torvalds: Plan Approval ✓

**APPROVED**

## Review

This plan is **right**:

1. **No hacks**: Factories used exactly as designed. Clean.
2. **No scope creep**: Only what we need — migrate 6 locations, add GraphBuilder buffering.
3. **Honest about breaking changes**: ID format change is documented, justified, and customer-approved.
4. **Follows existing patterns**: Matches EnumNode/InterfaceNode/ExportNode migrations. Consistent.
5. **Fixes the real problem**: Literals weren't being written to graph — this fixes that.

## Key Decisions

- Accept ID format change for nested literals (`propertyName` → `obj`, `elem{N}` → `obj`/`arr`)
- This is *semantically correct*: nested literals ARE generic objects/arrays, not "property named X"
- If context needed later, add through edges or metadata fields — not ID mangling

## Minor Notes

- Commit strategy is sound: GraphBuilder first (independent), then safe migration, then breaking change (last)
- Test strategy is solid: unit tests on factory output, integration tests on visitor + GraphBuilder
- Risk properly analyzed and mitigated

Proceed to implementation.

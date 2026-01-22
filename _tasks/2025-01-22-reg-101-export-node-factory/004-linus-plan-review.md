# Linus Torvalds - Plan Review: REG-101

## VERDICT: **APPROVED** ✅

## Analysis

Joel's plan follows the identical approach to REG-99 (CLASS) and REG-100 (IMPORT)—both successfully migrated ASTWorker to use Node.create(). No hacks, no shortcuts.

### Why This Is Right

1. **Correct pattern**: Follows established factory migration pattern exactly
2. **Clean field mapping**:
   - Old `exportType: 'function'/'class'/'variable'` → dropped (not needed downstream)
   - New `exportType: 'named'/'default'` → captures HOW it's exported
   - `localName` → `local`, `isDefault` → `default` are semantically correct
3. **Consistent ID format**: `EXPORT#name#file#line` → `file:EXPORT:name:line`
4. **Minimal changes**: Remove interface, add import, migrate 5 creations. Done.
5. **Low risk**: ExportNode.create() already tested. GraphBuilder already uses it.

### Concerns

None. This is right-sized and pragmatic.

### Proceed to Implementation

1. Kent writes tests (if needed - verify existing coverage)
2. Rob implements the migration

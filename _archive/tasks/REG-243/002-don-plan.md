# Don Melton - Technical Plan for REG-243

## Analysis

### Current State

Two separate mappings exist that must be kept in sync:

**1. CLI `check.ts` (category → codes):**
```typescript
CHECK_CATEGORIES = {
  'connectivity': { codes: ['ERR_DISCONNECTED_NODES', 'ERR_DISCONNECTED_NODE'] },
  'calls': { codes: ['ERR_UNRESOLVED_CALL'] },
  'dataflow': { codes: ['ERR_MISSING_ASSIGNMENT', 'ERR_BROKEN_REFERENCE', 'ERR_NO_LEAF_NODE'] },
  'imports': { codes: ['ERR_BROKEN_IMPORT', 'ERR_UNDEFINED_SYMBOL'] },
}
```

**2. Core `DiagnosticReporter.ts` (code → category):**
```typescript
DIAGNOSTIC_CODE_CATEGORIES = {
  'ERR_DISCONNECTED_NODES': { name: 'disconnected nodes', checkCommand: 'grafema check connectivity' },
  'ERR_UNRESOLVED_CALL': { name: 'unresolved calls', checkCommand: 'grafema check calls' },
  // ...
}
```

### Problem

- DRY violation - same information in two places
- Adding new diagnostic codes requires updates in both files
- Risk of inconsistency between CLI and core

## Solution: Single Source of Truth

Create `packages/core/src/diagnostics/categories.ts`:

```typescript
// Single canonical definition
export const DIAGNOSTIC_CATEGORIES = {
  connectivity: {
    name: 'Graph Connectivity',
    description: 'Check for disconnected nodes in the graph',
    codes: ['ERR_DISCONNECTED_NODES', 'ERR_DISCONNECTED_NODE'],
  },
  calls: { ... },
  dataflow: { ... },
  imports: { ... },
} as const;

// Derived: code → category (for DiagnosticReporter)
export const CODE_TO_CATEGORY: Record<string, { name: string; checkCommand: string }>;

// Type exports
export type DiagnosticCategoryKey = keyof typeof DIAGNOSTIC_CATEGORIES;
```

## Implementation Steps

1. **Create `categories.ts`** - define categories once, derive inverse mapping
2. **Update `DiagnosticReporter.ts`** - import CODE_TO_CATEGORY instead of local constant
3. **Update CLI `check.ts`** - import DIAGNOSTIC_CATEGORIES from @grafema/core
4. **Update index exports** - export new types/constants from diagnostics/index.ts
5. **Update tests** - ensure existing tests pass, add test for bidirectional mapping

## Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/diagnostics/categories.ts` | NEW - single source of truth |
| `packages/core/src/diagnostics/DiagnosticReporter.ts` | Import from categories.ts |
| `packages/core/src/diagnostics/index.ts` | Export new constants/types |
| `packages/core/src/index.ts` | Export from diagnostics |
| `packages/cli/src/commands/check.ts` | Import from @grafema/core |
| `test/unit/cli/check-categories.test.ts` | Update to use canonical source |

## Scope

- Mini-MLA: this is a well-understood refactoring
- No architectural decisions needed
- ~50-100 LOC changes total
- Risk: LOW (pure refactoring with existing tests)

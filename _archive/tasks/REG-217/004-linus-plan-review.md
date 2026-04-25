# Linus Torvalds Review: REG-217 Plan

**Status:** NEEDS REVISION

## Critical Finding

**The plan is built on a BROKEN FOUNDATION.** Validators don't produce diagnostics through the errors array - they only store metadata. Joel's entire approach assumes DiagnosticCollector has warning data, but it doesn't.

## Root Cause

Traced the code:
1. **CallResolverValidator.ts**: Creates issues in metadata.issues
2. Uses `createSuccessResult({ nodes: 0, edges: 0 }, { summary, issues })`
3. `createSuccessResult` sets `errors: []`
4. **Orchestrator** calls `diagnosticCollector.addFromPluginResult()`
5. **DiagnosticCollector** iterates `result.errors` - WHICH IS EMPTY

**Result:** Zero diagnostics collected. Issues live in metadata, never reach DiagnosticCollector.

Same problem with GraphConnectivityValidator and DataFlowValidator.

## Required Fix

Before any presentation layer work, validators must return diagnostics:

```typescript
// CURRENT (WRONG)
return createSuccessResult({ nodes: 0, edges: 0 }, { summary, issues });

// CORRECT
const errors = issues.map(issue =>
  new GrafemaError({
    code: issue.type,
    severity: 'warning',
    message: issue.message,
    context: { filePath: issue.file, lineNumber: issue.line }
  })
);
return { success: true, created: { nodes: 0, edges: 0 }, errors, warnings: [], metadata: { summary, issues } };
```

## Revised Plan Structure Required

1. **Phase 0**: Fix validators to return GrafemaError in errors array
2. **Phase 1**: DiagnosticReporter enhancement (Joel's original plan)
3. **Phase 2**: Check subcommands
4. **Phase 3**: Integrate into analyze

## Decision

STOP implementation until validators are fixed. This is exactly what CLAUDE.md calls "Root Cause Policy" - fix from the roots, not symptoms.

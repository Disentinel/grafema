# Don Melton Revised Plan: REG-217

## Verification: Linus's Finding is CORRECT

I've examined the validator contracts and diagnostic collection flow. The findings:

### The Critical Issue

**Validators produce issues but don't return them through `result.errors[]`.**

**Flow Breakdown:**

1. **CallResolverValidator** (lines 71-141):
   - Creates issues array
   - Returns: `createSuccessResult({ nodes: 0, edges: 0 }, { summary, issues })`
   - **Issues stored in metadata.issues, NOT in errors array**

2. **GraphConnectivityValidator** (lines 61-196):
   - Logs errors extensively
   - Returns: `createSuccessResult({ nodes: 0, edges: 0 }, { totalNodes, reachableNodes })`
   - **No issues passed at all - only summary metadata**

3. **DataFlowValidator** (lines 73-188):
   - Creates issues array
   - Returns: `createSuccessResult({ nodes: 0, edges: 0 }, { summary, issues })`
   - **Issues stored in metadata.issues, NOT in errors array**

### Contract Problem

**`createSuccessResult`** (packages/types/src/plugins.ts):
```typescript
export function createSuccessResult(
  created: { nodes: number; edges: number } = { nodes: 0, edges: 0 },
  metadata: Record<string, unknown> = {}
): PluginResult {
  return {
    success: true,
    created,
    errors: [],        // <-- ALWAYS EMPTY!
    warnings: [],
    metadata,
  };
}
```

**DiagnosticCollector.addFromPluginResult()** iterates `result.errors` - which is always empty.

### Architectural Root Cause

- **Intended contract:** Validators return errors via `PluginResult.errors[]`
- **Actual implementation:** Validators return issues via `metadata.issues`
- **Why?** Validators produce non-fatal findings (NOT errors), so they used metadata. But DiagnosticCollector expects errors in the errors array.

---

## Revised Implementation Plan

### Phase 0: Fix Validator Contract (PREREQUISITE)

**Files to modify:**

1. **packages/types/src/plugins.ts**
   - Add optional `errors` parameter to `createSuccessResult`

2. **packages/core/src/plugins/validation/CallResolverValidator.ts**
   - Convert issues to GrafemaError instances
   - Return via errors array with severity='warning'

3. **packages/core/src/plugins/validation/GraphConnectivityValidator.ts**
   - Convert disconnected node findings to GrafemaError
   - Return via errors array

4. **packages/core/src/plugins/validation/DataFlowValidator.ts**
   - Convert issues to GrafemaError instances
   - Return via errors array

**Error Format:**
```typescript
new GrafemaError({
  code: 'UNRESOLVED_FUNCTION_CALL',  // or DISCONNECTED_NODES, MISSING_ASSIGNMENT
  severity: 'warning',
  message: 'descriptive message',
  context: { filePath: file, lineNumber: line }
})
```

### Phase 1: DiagnosticReporter Enhancement
(Original Joel plan - unchanged)

### Phase 2: Check Subcommands
(Original Joel plan - unchanged)

### Phase 3: Integrate into Analyze
(Original Joel plan - unchanged)

---

## Root Cause Policy Applied

This is exactly what CLAUDE.md describes:
> When behavior or architecture doesn't match project vision:
> 1. STOP immediately
> 2. Identify the architectural mismatch
> 3. Fix from the roots, not symptoms

**The mismatch:** Validators produce findings in metadata but diagnostic collection expects errors array. We fix the contract, not patch around it.

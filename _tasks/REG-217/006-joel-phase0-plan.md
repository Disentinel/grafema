# Joel Spolsky Technical Plan: Phase 0 - Fix Validator Contract

## REG-217 Phase 0: Validators Return Errors Through PluginResult.errors[]

### Executive Summary

**The Problem:** Validators produce issues but store them in `metadata.issues`, not in `result.errors[]`. The `DiagnosticCollector.addFromPluginResult()` iterates over `result.errors` which is always empty.

**The Solution:**
1. Add optional `errors` parameter to `createSuccessResult()`
2. Create `ValidationError` class for validator findings
3. Convert each validator's issues to `ValidationError` instances
4. Return errors via the errors array

---

## Part 1: Modify createSuccessResult

**File:** `packages/types/src/plugins.ts`

```typescript
// BEFORE:
export function createSuccessResult(
  created: { nodes: number; edges: number } = { nodes: 0, edges: 0 },
  metadata: Record<string, unknown> = {}
): PluginResult {
  return { success: true, created, errors: [], warnings: [], metadata };
}

// AFTER:
export function createSuccessResult(
  created: { nodes: number; edges: number } = { nodes: 0, edges: 0 },
  metadata: Record<string, unknown> = {},
  errors: Error[] = []  // NEW OPTIONAL PARAMETER
): PluginResult {
  return { success: true, created, errors, warnings: [], metadata };
}
```

---

## Part 2: Create ValidationError Class

**File:** `packages/core/src/errors/GrafemaError.ts`

Add after AnalysisError class:

```typescript
/**
 * Validation error - issues found during graph validation
 */
export class ValidationError extends GrafemaError {
  readonly code: string;
  readonly severity: 'fatal' | 'error' | 'warning';

  constructor(
    message: string,
    code: string,
    context: ErrorContext = {},
    suggestion?: string,
    severity: 'fatal' | 'error' | 'warning' = 'warning'
  ) {
    super(message, context, suggestion);
    this.code = code;
    this.severity = severity;
  }
}
```

---

## Part 3: Fix CallResolverValidator

**File:** `packages/core/src/plugins/validation/CallResolverValidator.ts`

1. Add import: `import { ValidationError } from '../../errors/GrafemaError.js';`
2. Remove CallResolverIssue interface
3. Change `const issues: CallResolverIssue[] = []` to `const errors: ValidationError[] = []`
4. Convert issue creation:
```typescript
errors.push(new ValidationError(
  `Call to "${node.name}" at ${node.file}:${node.line || '?'} does not resolve`,
  'ERR_UNRESOLVED_CALL',
  { filePath: node.file, lineNumber: node.line, phase: 'VALIDATION', plugin: 'CallResolverValidator' },
  'Ensure the function is defined and exported'
));
```
5. Update return: `return createSuccessResult({ nodes: 0, edges: 0 }, { summary }, errors);`

---

## Part 4: Fix GraphConnectivityValidator

**File:** `packages/core/src/plugins/validation/GraphConnectivityValidator.ts`

1. Add import
2. Add `const errors: ValidationError[] = []` inside execute
3. For unreachable nodes, create ValidationError:
```typescript
errors.push(new ValidationError(
  `Found ${unreachable.length} unreachable nodes (${percentage}% of total)`,
  'ERR_DISCONNECTED_NODES',
  { phase: 'VALIDATION', plugin: 'GraphConnectivityValidator' },
  'Fix analysis plugins to ensure all nodes are connected'
));
```
4. Update return to pass errors

---

## Part 5: Fix DataFlowValidator

**File:** `packages/core/src/plugins/validation/DataFlowValidator.ts`

Same pattern as CallResolverValidator:
- MISSING_ASSIGNMENT → `ERR_MISSING_ASSIGNMENT` (warning)
- BROKEN_REFERENCE → `ERR_BROKEN_REFERENCE` (error severity)
- NO_LEAF_NODE → `ERR_NO_LEAF_NODE` (warning)

---

## Implementation Order

1. **Step 1:** Update `createSuccessResult` in types/plugins.ts
2. **Step 2:** Add `ValidationError` class to GrafemaError.ts + export
3. **Step 3:** Fix CallResolverValidator
4. **Step 4:** Fix DataFlowValidator
5. **Step 5:** Fix GraphConnectivityValidator
6. **Step 6:** Write/run tests

---

## Error Code Reference

| Code | Validator | Severity |
|------|-----------|----------|
| `ERR_UNRESOLVED_CALL` | CallResolverValidator | warning |
| `ERR_DISCONNECTED_NODES` | GraphConnectivityValidator | warning |
| `ERR_DISCONNECTED_NODE` | GraphConnectivityValidator | warning |
| `ERR_MISSING_ASSIGNMENT` | DataFlowValidator | warning |
| `ERR_BROKEN_REFERENCE` | DataFlowValidator | error |
| `ERR_NO_LEAF_NODE` | DataFlowValidator | warning |

---

## Critical Files

- `packages/types/src/plugins.ts` - createSuccessResult signature
- `packages/core/src/errors/GrafemaError.ts` - ValidationError class
- `packages/core/src/plugins/validation/CallResolverValidator.ts`
- `packages/core/src/plugins/validation/DataFlowValidator.ts`
- `packages/core/src/plugins/validation/GraphConnectivityValidator.ts`

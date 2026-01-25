# REG-225: Kent Beck - Test Report

## Summary

Created comprehensive unit tests for FunctionCallResolver following TDD principles. Tests are designed to drive the implementation and document expected behavior.

---

## Test File

**Location:** `test/unit/FunctionCallResolver.test.js`

---

## Test Cases Implemented

### 1. Named Imports
**Scenario:** `import { foo } from './utils'; foo();`

Tests that a call to a named-imported function creates CALLS edge to the target function.

### 2. Default Imports
**Scenario:** `import fmt from './utils'; fmt();`

Tests resolution when the local binding name differs from the exported function name. The EXPORT.local field is used to find the target function.

### 3. Aliased Named Imports
**Scenario:** `import { foo as bar } from './utils'; bar();`

Tests that aliased imports work correctly - the CALL uses the local alias name, but resolves to the original function.

### 4. Namespace Imports (Skip Case)
**Scenario:** `import * as utils from './utils'; utils.foo();`

Tests that namespace method calls (which have `object` attribute) are skipped. These are METHOD_CALLs, not CALL_SITEs, and should be handled by MethodCallResolver.

### 5. Already Resolved Calls (Skip Case)
Tests that if a CALL already has a CALLS edge, no duplicate is created. Ensures idempotency.

### 6. External Imports (Skip Case)
**Scenarios:**
- `import _ from 'lodash'` (non-relative)
- `import { useQuery } from '@tanstack/react-query'` (scoped package)

Tests that external module imports are skipped (no resolution attempted).

### 7. Missing IMPORTS_FROM Edge (Graceful Handling)
Tests that if an IMPORT node exists but has no IMPORTS_FROM edge (e.g., target file not analyzed), the plugin handles this gracefully without crashing.

### 8. Re-exports (Skip for v1)
**Scenario:** `export { foo } from './other';`

Tests that re-export chains (EXPORT with `source` field) are skipped for v1. This is documented as future work.

### 9. Arrow Function Exports
**Scenario:** `const foo = () => {}; export { foo };`

Tests that arrow functions exported by name are resolved correctly.

### 10. Multiple Calls to Same Imported Function
Tests that when the same imported function is called multiple times, all calls get CALLS edges.

### 11. Multiple Imports from Same File
**Scenario:** `import { foo, bar, baz } from './utils';`

Tests resolution of multiple functions imported from the same source file.

### 12. Call to Non-Imported Function
Tests that calls to functions not in the import list are not resolved (no false positives).

### 13. Plugin Metadata
Tests that FunctionCallResolver has correct metadata:
- Name: `FunctionCallResolver`
- Phase: `ENRICHMENT`
- Priority: `80` (after ImportExportLinker at 90)
- Creates: `CALLS` edges
- Dependencies: `ImportExportLinker`

---

## Test Pattern

Following existing patterns from `MethodCallResolver.test.js`:

```javascript
async function setupBackend() {
  const testDir = join(tmpdir(), `grafema-test-funcresolver-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });
  const backend = new RFDBServerBackend({ dbPath: join(testDir, 'test.db') });
  await backend.connect();
  return { backend, testDir };
}
```

Each test:
1. Creates isolated backend
2. Adds nodes manually (FUNCTION, EXPORT, IMPORT, CALL)
3. Adds IMPORTS_FROM edge (simulating ImportExportLinker)
4. Executes FunctionCallResolver
5. Asserts CALLS edges are created correctly
6. Cleans up with `backend.close()`

---

## Test Status

Tests are syntactically valid but will fail until implementation exists:

```
SyntaxError: The requested module '@grafema/core' does not provide an export named 'FunctionCallResolver'
```

This is expected TDD workflow. Tests drive the implementation.

---

## Coverage Matrix

| Test Case | Named | Default | Aliased | Namespace | External | Re-export | Graceful |
|-----------|-------|---------|---------|-----------|----------|-----------|----------|
| Create CALLS edge | Y | Y | Y | - | - | - | - |
| Skip (expected) | - | - | - | Y | Y | Y | Y |
| No duplicates | Y | - | - | - | - | - | - |

---

## Notes for Rob

1. **Import matching**: Use `IMPORT.local` to match `CALL.name` (not `IMPORT.imported`)
2. **Function lookup**: Use `EXPORT.local` to find the FUNCTION in the source file
3. **Method calls**: Skip any CALL with `object` attribute (has `object` = method call)
4. **External imports**: Check if `source` starts with `./` or `../` (relative = internal)
5. **Re-exports**: Skip EXPORT nodes with `source` field (for v1)
6. **Existing edges**: Check `getOutgoingEdges(callId, ['CALLS'])` before creating

---

## Checklist

- [x] Named import resolution test
- [x] Default import resolution test
- [x] Aliased import resolution test
- [x] Namespace import skip test
- [x] Already resolved skip test
- [x] External imports skip test
- [x] Missing IMPORTS_FROM graceful handling test
- [x] Re-exports skip test (v1)
- [x] Arrow function exports test
- [x] Multiple calls to same function test
- [x] Multiple imports from same file test
- [x] Non-imported function not resolved test
- [x] Plugin metadata test

All 13 test categories implemented. Tests are ready for implementation.

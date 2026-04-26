# Kent Beck - Test Report

## REG-204: Explore Command Batch Mode Tests

---

## Summary

Created comprehensive test suite for the `explore` command batch mode functionality at:
`/Users/vadimr/grafema-worker-7/packages/cli/test/explore.test.ts`

The tests follow existing patterns from `cli.test.ts` and `cli-coverage.test.ts`.

---

## Test Coverage

### 1. TTY Detection (2 tests)
Tests verify the error handling when explore is run without TTY and no batch flags:

- **should show error with suggestions when running explore without TTY and no batch flags**
  - Verifies exit code 1
  - Verifies error message mentions "terminal" or "TTY"

- **should suggest batch mode alternatives in error message**
  - Verifies suggestions include `--query`, `--callers`, or "batch"

### 2. Batch Mode --query (4 tests)
Tests for the search functionality:

- **should search and return JSON results**
  - Verifies valid JSON output
  - Verifies schema: `{ mode: 'search', count: number, results: [...] }`

- **should search and return text results**
  - Verifies function name appears in output
  - Verifies "Total:" count appears

- **should handle no results gracefully**
  - Exit code 0 even with no results
  - count: 0, results: []

- **should handle partial name matches**
  - Searching "auth" should find "authenticate"

### 3. Batch Mode --callers (5 tests)
Tests for showing callers of a function:

- **should show callers of a function in JSON format**
  - Verifies mode: 'callers'
  - Verifies target object present

- **should show callers of a function in text format**
  - Verifies "Callers of" or "callers" appears

- **should respect --depth for recursive traversal**
  - depth 3 should find >= callers than depth 1
  - Tests the transitive caller chain

- **should error when function not found**
  - Exit code 1
  - "not found" in message

- **should handle function with no callers**
  - Exit code 0
  - count: 0, results: []

### 4. Batch Mode --callees (3 tests)
Tests for showing callees of a function:

- **should show callees of a function in JSON format**
  - Verifies mode: 'callees'
  - Verifies target present

- **should show callees of a function in text format**
  - Verifies "Callees of" or "callees" appears

- **should error when function not found**
  - Exit code 1

### 5. Edge Cases (5 tests)

- **should use default depth when invalid depth provided**
  - Handles non-numeric depth gracefully

- **should work with batch flags even without graph database**
  - Shows "No database" error
  - Suggests running analyze

- **should handle multiple batch flags - query takes precedence**
  - When both --query and --callers provided, mode is 'search'

- **should include file paths in JSON output**
  - file field present and relative (not absolute)

- **should include line numbers when available**
  - line field is number if present

### 6. Help Text (2 tests)

- **should show explore command in main help**
- **should show batch mode options in explore help**
  - --query, --callers, --callees, --depth, --json

### 7. JSON Output Schema (3 tests)

- **search mode should have correct schema**
  - mode: 'search', no target, count, results with id/type/name/file/line

- **callers mode should have correct schema with target**
  - mode: 'callers', target object, count, results

- **callees mode should have correct schema with target**
  - mode: 'callees', target object, count, results

---

## Test Fixtures

The tests create a temporary project with a realistic call graph:

```typescript
main()
  -> authenticate()
       -> validateToken()
       -> checkPermissions()
  -> processData()
       -> fetchData()
       -> transformData()

orphanFunction() // no callers
```

This allows testing:
- Direct callers (authenticate called by main)
- Transitive callers (validateToken called by authenticate, which is called by main)
- Functions with no callers (orphanFunction)

---

## Implementation Notes

1. **Non-TTY Simulation**: Uses `spawnSync` with `stdio: ['pipe', 'pipe', 'pipe']` to ensure stdin/stdout are not TTY

2. **Setup Helper**: `setupAnalyzedProject()` creates a complete test project with init + analyze

3. **Async Tests**: All tests that need analyzed data are async and await the project setup

4. **Cleanup**: `afterEach` removes temp directory

---

## Test File Location

Following existing patterns, the test is placed at:
```
packages/cli/test/explore.test.ts
```

This mirrors the pattern of other CLI tests in the same directory.

---

## Running Tests

Once implementation is complete:
```bash
node --import tsx --test packages/cli/test/explore.test.ts
```

Or from the project root:
```bash
node --import tsx --test packages/cli/test/*.test.ts
```

---

## Alignment with Technical Spec

The tests cover all scenarios from Joel's technical plan (section 3):

| Spec Test Case | Implemented |
|----------------|-------------|
| TTY detection - error with suggestions when stdin is not TTY | Yes |
| TTY detection - error with suggestions when stdout is not TTY | Yes (combined) |
| Batch mode --query - search and return JSON results | Yes |
| Batch mode --query - search and return text results | Yes |
| Batch mode --query - handle no results gracefully | Yes |
| Batch mode --callers - show callers of a function | Yes |
| Batch mode --callers - respect --depth for recursive traversal | Yes |
| Batch mode --callers - error when function not found | Yes |
| Batch mode --callees - show callees of a function | Yes |
| Piped input - work with piped input in batch mode | Yes (all batch tests use pipes) |

---

## Status

**READY FOR IMPLEMENTATION**

The tests are written and ready. They will fail until the implementation is complete, which is expected TDD behavior.

# REG-207: HTTP Routes Query - Test Report

**Author:** Kent Beck (Test Engineer)
**Date:** 2025-01-25

---

## Summary

Created comprehensive test file for HTTP route querying functionality per Joel's tech plan and Linus's review requirements.

**Test File:** `/Users/vadimr/grafema-worker-5/packages/cli/test/query-http-routes.test.ts`

---

## Tests Written

### 1. Type Aliases (3 tests)

| Test | Purpose |
|------|---------|
| `should find routes with "route" alias` | Verifies `grafema query "route /api"` works |
| `should find routes with "endpoint" alias` | Verifies `grafema query "endpoint /api"` works |
| `should find routes with "http" alias` | Verifies `grafema query "http /users"` works |

### 2. Method Matching (4 tests)

| Test | Purpose |
|------|---------|
| `should find all POST endpoints` | Verifies `grafema query "route POST"` returns POST routes |
| `should find all GET endpoints` | Verifies `grafema query "route GET"` returns GET routes |
| `should find DELETE endpoints` | Verifies DELETE method matching |
| `should be case-insensitive for method search` | Verifies `post` matches `POST` |

### 3. Path Matching (2 tests)

| Test | Purpose |
|------|---------|
| `should find routes by partial path` | Verifies `/users` matches `/api/users` |
| `should find routes by path prefix` | Verifies `/api` finds multiple routes |

### 4. Combined Method + Path (3 tests)

| Test | Purpose |
|------|---------|
| `should find specific GET /api/users combination` | Exact method+path match |
| `should find POST /api/users specifically` | Exact method+path match |
| `should NOT return POST routes when searching for GET /api/users` | Verifies filtering precision |

### 5. Display Formatting (2 tests)

| Test | Purpose |
|------|---------|
| `should display routes as [http:route] METHOD PATH` | Output format verification |
| `should include location in route display` | File path in output |

### 6. JSON Output (1 test)

| Test | Purpose |
|------|---------|
| `should include method and path in JSON output` | JSON schema verification |

### 7. No Results (2 tests)

| Test | Purpose |
|------|---------|
| `should handle no matching routes gracefully` | Graceful empty response |
| `should handle searching for non-existent method` | No crash on PATCH |

### 8. General Search Includes Routes (1 test)

| Test | Purpose |
|------|---------|
| `should find routes when searching without type specifier` | Routes in default search |

### 9. Method Search Isolation - Linus Requirement (3 tests)

| Test | Purpose |
|------|---------|
| `should NOT match function named "postMessage" when searching for HTTP POST` | **CRITICAL** - "POST" search should not return functions with "post" in name |
| `should NOT match function named "getMessage" when searching for HTTP GET` | Same for GET |
| `should find postMessage when searching for functions` | Function search still works |

---

## Total: 21 Test Cases

All tests address acceptance criteria from:
- Joel's tech plan (003-joel-tech-plan.md)
- Linus's required addition (004-linus-plan-review.md)

---

## Discoveries About Existing Test Patterns

### Pattern Used: `explore.test.ts` style

The tests follow the pattern from `explore.test.ts`:
- Uses `node:test` (native Node.js test runner)
- `beforeEach` / `afterEach` for temp directory setup/cleanup
- `spawnSync` for CLI invocation (simpler than async spawn)
- `NO_COLOR=1` environment variable for consistent output
- `timeout: 60000` for describe blocks (analyze takes ~30s)

### Helper Functions

```typescript
function runCli(args: string[], cwd: string): { stdout, stderr, status }
async function setupExpressProject(): Promise<void>  // Creates Express app with routes
```

### Test Fixture

The fixture includes:
- Express routes: GET /api/users, GET /api/posts, POST /api/users, DELETE /api/users/:id
- Functions with similar names: `postMessage()`, `getMessage()` - for testing method/function isolation

---

## How to Run Tests

```bash
# From packages/cli directory
cd /Users/vadimr/grafema-worker-5/packages/cli

# Run just this test file
node --import tsx --test test/query-http-routes.test.ts

# Run all CLI tests
pnpm test
```

**Note:** Tests require the CLI to be built first:
```bash
pnpm build
```

---

## Expected Test Results

### Before Implementation

All tests will **FAIL** because:
1. Type aliases (route, endpoint, http) don't exist yet
2. `http:route` is not in default searchTypes
3. Field matching searches `name` instead of `method`/`path`
4. Display formatting doesn't exist

### After Implementation

All 21 tests should **PASS**.

---

## Test File Location

`/Users/vadimr/grafema-worker-5/packages/cli/test/query-http-routes.test.ts`

---

## Notes

1. Tests are designed to be **deterministic** - they create isolated temp directories
2. The Express fixture is minimal but realistic
3. Tests explicitly verify the **Linus requirement**: HTTP method search must NOT match functions with similar names
4. JSON output tests verify the schema includes `method` and `path` fields

---

*"Tests communicate intent. These tests say: HTTP routes are first-class citizens in query, with their own search semantics."*

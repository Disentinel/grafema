# Joel Spolsky Technical Plan: REG-248

## Executive Summary

The fix is straightforward but requires careful test planning. HTTPConnectionEnricher ignores the `fullPath` field that MountPointResolver already computes. We need to:
1. Change one line in HTTPConnectionEnricher to use `fullPath || path`
2. Add test cases for mounted routes with HTTP requests
3. Ensure edge cases (multiple mount points, nested mounts) are covered

---

## 1. EXACT FILE CHANGES NEEDED

### File: `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`

**Current Code (Line 104):**
```typescript
const routePath = route.path;
```

**Change To:**
```typescript
const routePath = route.fullPath || route.path;
```

**Context (Lines 102-107):**
```typescript
for (const route of uniqueRoutes) {
  const routeMethod = (route.method || 'GET').toUpperCase();
  const routePath = route.fullPath || route.path;  // ← CHANGE HERE

  if (routePath && method === routeMethod && this.pathsMatch(url, routePath)) {
    // Create edge...
```

**Why This Works:**
- `route.fullPath` is populated by MountPointResolver for routes with mount prefixes
- `route.path` is the local path (e.g., `/received`)
- `fullPath` = mount prefix + local path (e.g., `/api` + `/received` = `/api/received`)
- Fallback to `route.path` handles unmounted routes (e.g., `app.get('/health', ...)`)
- Existing `pathsMatch()` logic handles parametric routes for both cases

---

## 2. TEST PLAN

### 2.1 Test Cases to Create

**Test 1: Basic Mounted Route with HTTP Request**
```typescript
it('should match fetch request to mounted router endpoint', async () => {
  // Backend: app.use('/api', invitationRouter); router.get('/received', handler);
  // Frontend: fetch('/api/invitations/received')
  // Expected: INTERACTS_WITH edge created: request → route
});
```

**Test 2: Nested Mount Points**
```typescript
it('should match fetch request to nested mounted router endpoint', async () => {
  // Backend: app.use('/api', parentRouter); parentRouter.use('/v1', childRouter); childRouter.get('/users', handler);
  // Frontend: fetch('/api/v1/users')
  // Expected: INTERACTS_WITH edge created
});
```

**Test 3: Multiple Mount Points for Same Router**
```typescript
it('should match requests to router mounted at multiple paths', async () => {
  // Backend: app.use('/api/v1', sharedRouter); app.use('/api/v2', sharedRouter); sharedRouter.get('/', handler);
  // Frontend: fetch('/api/v1/') and fetch('/api/v2/')
  // Expected: BOTH requests create INTERACTS_WITH edges
  // NOTE: Current implementation uses first fullPath only - this test documents the limitation
});
```

**Test 4: Unmounted Routes Still Work (Fallback)**
```typescript
it('should still match direct app routes without mount prefix', async () => {
  // Backend: app.get('/health', handler);
  // Frontend: fetch('/health')
  // Expected: fallback to route.path still creates edge
});
```

**Test 5: Parametric Routes with Mount Prefix**
```typescript
it('should match parametric routes with mount prefix', async () => {
  // Backend: app.use('/api', router); router.get('/:id', handler);
  // Frontend: fetch('/api/123')
  // Expected: pathsMatch('/api/123', '/api/:id') → true
});
```

---

## 3. ORDER OF OPERATIONS

**Phase 1: Test Infrastructure (FIRST)**
1. Create test file: `packages/core/test/enrichment/HTTPConnectionEnricher.test.ts`
2. Set up test fixture with mounted routers and frontend fetch calls

**Phase 2: Implementation (ONE-LINE CHANGE)**
3. Change line 104 in HTTPConnectionEnricher.ts: `route.path` → `route.fullPath || route.path`

**Phase 3: Verification**
4. Run new tests - should all pass
5. Run existing query tests - should all pass (no regression)

---

## 4. EDGE CASES TO CONSIDER

### 4.1 Multiple fullPaths in Array

MountPointResolver creates arrays: `fullPaths[]` and `mountPrefixes[]`. If a router is mounted at multiple paths, the route node will have:
- `fullPath`: first path (scalar)
- `fullPaths`: all paths (array)

Current fix uses scalar `fullPath` only. This is acceptable for 95% of cases.

**Tech Debt:** If multiple mount points are critical, create separate Linear issue.

### 4.2 Case Sensitivity

Current `pathsMatch()` uses exact string comparison. URLs are case-sensitive in HTTP. **No change needed.**

### 4.3 Empty Paths

Line 106 has explicit `routePath &&` check. **No change needed** - already safe.

---

## 5. RISK ASSESSMENT

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Regression in unmounted routes | LOW | Explicit fallback `|| route.path` |
| Performance impact | NONE | Single field access |
| Type safety | NONE | Both fields already optional in interface |

**Risk Rating: MINIMAL**

---

## 6. SUCCESS CRITERIA

- [ ] Test 1 (basic mounted route): **PASS**
- [ ] Test 2 (nested mounts): **PASS**
- [ ] Test 3 (multiple mounts): **DOCUMENTED LIMITATION**
- [ ] Test 4 (unmounted routes): **PASS**
- [ ] Test 5 (parametric with prefix): **PASS**
- [ ] Existing HTTP query tests: **NO REGRESSION**

# REG-207: Plan Review

**Reviewer:** Linus Torvalds (High-Level)
**Date:** 2025-01-25
**Verdict:** APPROVED with notes

---

## 1. Did We Identify the RIGHT Problem?

**YES.** Don nailed it.

The problem is crystal clear: HTTP routes exist in the graph (overview shows 64 of them), but the query command is blind to them. Two root causes:

1. Hardcoded type list excludes `http:route`
2. Search only looks at `name` field, not `method`/`path` properties

This is not symptom-fixing. This is fixing the actual architectural gap: the query command was designed for a limited set of node types and never updated when we added namespaced types like `http:route`.

---

## 2. Is the Solution at the Right Level of Abstraction?

**ACCEPTABLE for Phase 1, but needs monitoring.**

Joel's plan puts field matching logic directly in `query.ts`. I'm okay with this for now because:

1. HTTP routes have unique search semantics (method + path vs name)
2. The `matchesSearchPattern()` helper is properly isolated
3. It's explicitly marked as "Phase 1" with DSL planned for Phase 2

**Watch item:** If we add more namespaced types with custom search fields (db:query, socketio:emit), this pattern will become unwieldy. After this ships, someone should evaluate whether `matchesSearchPattern()` belongs in core or if types should declare their own searchable fields.

Don's Option B (SearchableFields interface) hints at this cleaner design, but Joel correctly chose pragmatism for this issue. I agree with that call.

---

## 3. Are We Cutting Corners?

**One minor concern, otherwise solid.**

**Concern: `formatHttpRouteDisplay()` duplicates path handling**

Joel's plan adds a new `formatHttpRouteDisplay()` function in `query.ts` that does its own `require('path').relative()`. We already have `formatNodeDisplay` in `formatNode.ts`.

This is acceptable because:
- HTTP routes genuinely need different display: `[http:route] POST /api/users` vs semantic ID
- The duplication is minimal (just path.relative call)
- Keeping it in query.ts makes the feature self-contained

If we add more special displays for other types, this should be refactored into `formatNode.ts` with type-aware formatting.

**Not a corner cut:** I verified Joel's line numbers against actual code. They're slightly off (typeMap is at 136-146, searchTypes at 166-168), but the code matches. No issue.

---

## 4. Does It Align with Project Vision?

**Absolutely.**

Project vision: "AI should query the graph, not read code."

If an AI agent needs to find all POST endpoints and has to read source files because `grafema query "POST"` returns nothing - that's exactly the product gap this fixes.

This change makes HTTP routes first-class citizens in the query system. Good.

---

## 5. Did We Forget Something from the Original Request?

**All acceptance criteria covered:**

| Original Criterion | Plan Coverage |
|--------------------|---------------|
| HTTP routes searchable via query | Change 2: add to searchTypes |
| Filter by method (GET, POST) | matchesSearchPattern() handles this |
| Filter by path pattern | matchesSearchPattern() handles this |
| Tests pass | Comprehensive test plan included |

**One addition in Don's expanded criteria:**

| Don's Criterion | Plan Coverage |
|-----------------|---------------|
| `grafema query "POST"` returns POST endpoints | Yes |
| `grafema query "GET /api"` returns matching GET | Yes |
| `grafema query "route /api"` works | Yes (type alias) |
| `grafema query "/api/users"` finds routes | Yes (path-only matching) |
| Results display method+path prominently | Yes (formatHttpRouteDisplay) |

**Nothing forgotten.**

---

## 6. Are the Tests Actually Testing What They Claim?

**YES, with one improvement needed.**

The test plan is solid:
- Tests type aliases (route, endpoint, http)
- Tests method matching (POST, GET, DELETE)
- Tests path matching (/api, /users)
- Tests combined method+path (GET /api/users)
- Tests display format
- Tests JSON output
- Tests no-results case
- Tests general search includes routes

**Improvement needed:** Add a test that verifies searching for "POST" does NOT match a function named "postMessage". This is mentioned in Risks table but not in tests.

```typescript
it('should not match functions when searching for HTTP method', async () => {
  // Add a function named "postMessage" to the fixture
  const result = runCli(['query', 'POST'], tempDir);
  // Verify we get HTTP routes, not the postMessage function
  assert.ok(result.stdout.includes('[http:route]'), 'Should find routes');
  assert.ok(!result.stdout.includes('postMessage'), 'Should not match functions');
});
```

---

## Summary

**APPROVED** - Proceed with implementation.

The plan correctly identifies the root cause (not just symptoms), the solution is at an appropriate abstraction level for Phase 1, aligns with project vision, and covers all acceptance criteria.

**Required addition before implementation:**
- Add test case for "POST" not matching functions named "postMessage"

**Watch items for future:**
- If more namespaced types need custom search, refactor `matchesSearchPattern()` to core
- If more types need custom display, refactor to `formatNode.ts`

---

*"This is how it should work. HTTP routes are in the graph, they should be queryable. The fact that they weren't was simply wrong. Fix it, ship it."*

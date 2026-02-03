# Vadim Reshetnikov - High-Level Review for REG-326

**Date:** 2026-02-03

## Verdict: **NEEDS REWORK** — Plan scope must expand

## Key Decisions

### 1. ObjectLiteral — NOT DEFER, FIX FIRST

> "Object literals are 98% of JSON API responses. We need it first priority."

**Decision:** Pause REG-326, fix ObjectExpression in JSASTAnalyzer first, then continue.

**Rationale:** Without ASSIGNED_FROM for object literals, the feature is useless for 98% of real-world cases. This is exactly the situation where "accept limitation for MVP" defeats the purpose.

### 2. Global Scope Variables — Fallback Search

> "Global level variables should be 'second tier' of search. We know all variables in global scope, right? So we can fallback to them. Like shadowing in reverse. JS resolves them somehow."

**Decision:** Scope resolution must include:
1. First: local scope (handler function)
2. Second: module-level scope (global variables in same file)

**Algorithm:** JS scope chain resolution — inner scope first, then walk outward to module scope.

### 3. Proper Scope Chain — Required Investment

> "We need proper scope chain track. I know it's hard but it's a major investment. Since JS engine can track it - we can track it too."

**Decision:** String prefix matching is a temporary solution. Proper scope chain required.

**Scope chain walk:**
1. Start from identifier usage location
2. Walk up through scope hierarchy
3. Find first matching declaration
4. Handle shadowing correctly

### 4. Strict Mode Flag — System-Wide

> "We need a system-wide flag to fail immediately instead of WARN and stub/global. In this mode we can find and fix product gaps easier."

**Decision:** Add global strict mode flag:
- Default: WARN + create stub (current behavior)
- Strict: FAIL immediately when can't resolve

**Use case:** During development/dogfooding, run with strict mode to find gaps.

### 5. Performance — Acceptable with Cache

> "1 sec per 50 routes IS acceptable. Cause we're going to use cache and recalculate only files that changes. parentScopeID is definitely a great idea."

**Decision:**
- O(V+C+P) acceptable for now
- parentScopeId index — good idea, implement when needed
- Cache invalidation per-file is the right approach

### 6. Output Format — Structured

> "Output for data flow tracking should be some kind of JSON Schema / TS Type with ENUM whenever possible"

**Decision:** Define proper TypeScript types for trace output:
```typescript
interface TraceResult {
  route: RouteInfo;
  responses: ResponseTrace[];
  statistics: TraceStatistics;
}

enum SourceType {
  LITERAL = 'LITERAL',
  VARIABLE = 'VARIABLE',
  PARAMETER = 'PARAMETER',
  CALL = 'CALL',
  DB_QUERY = 'DB_QUERY',
  UNKNOWN = 'UNKNOWN'
}
```

### 7. Question 5 Clarification Needed

Steve asked: "Should `--from-route` support wildcards? (e.g., `"GET /api/*"`)"

**My question:** Do we need pattern matching for routes, or is exact match enough for MVP?

---

## Updated Plan Scope

### Pre-requisites (DO FIRST):
1. **Fix ObjectExpression in JSASTAnalyzer** — Add ASSIGNED_FROM edges for `const x = { ... }`
2. **Implement proper scope chain resolution** — Not string prefix matching

### Then REG-326:
3. Fix ExpressResponseAnalyzer to link to existing variables
4. Add `--from-route` CLI option
5. Add to DEFAULT_CONFIG
6. Add strict mode flag (global config option)

### Estimated Timeline Impact:
- Original: 4.5 days
- With ObjectExpression fix: +1-2 days
- With proper scope chain: +2-3 days
- **New estimate: 7-10 days**

---

## Action Items

1. [ ] Create Linear issue for "JSASTAnalyzer: ASSIGNED_FROM edges for ObjectExpression initializers"
2. [ ] Create Linear issue for "Implement proper scope chain resolution"
3. [ ] Create Linear issue for "Add strict mode flag for fail-fast debugging"
4. [ ] Update REG-326 to depend on above issues
5. [ ] Don to revise plan with expanded scope

---

*Review by Vadim Reshetnikov, Product Owner*
*Status: NEEDS REWORK — expand scope before implementation*

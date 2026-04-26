# Dijkstra Plan Verification: REG-482

**Date:** 2026-02-16
**Plan reviewed:** 003-don-plan.md
**Verdict:** REJECT

## Executive Summary

Don's plan has CRITICAL gaps in plugin categorization and dependency extraction scope. Multiple plugins are miscategorized as "needs covers" when they are actually pattern-based, not package-based. The dependency extraction only looks at `dependencies`, missing `devDependencies` where framework packages commonly appear.

**7 BLOCKING ISSUES identified.** Implementation would result in incorrect skip behavior.

---

## Completeness Table 1: Plugin Categorization (ALL 15 plugins)

Plan lists 12 plugins, but there are **15 ANALYSIS plugins** in the codebase.

| Plugin | Don's Category | ACTUAL Behavior | Correct? |
|--------|---------------|-----------------|----------|
| JSASTAnalyzer | No covers (base parser) | Base parser, always run | ✅ YES |
| ExpressRouteAnalyzer | Needs `covers: ['express']` | Package-based (checks req/res objects from Express) | ✅ YES |
| ExpressResponseAnalyzer | Needs `covers: ['express']` | Package-based (checks res.send/json patterns) | ✅ YES |
| ExpressAnalyzer | Needs `covers: ['express']` | Package-based (checks app.use/get patterns) | ✅ YES |
| NestJSRouteAnalyzer | Needs `covers: ['@nestjs/common', '@nestjs/core']` | Package-based (checks NestJS decorators) | ✅ YES |
| SocketIOAnalyzer | Needs `covers: ['socket.io']` | Package-based (checks socket.io API) | ✅ YES |
| **DatabaseAnalyzer** | **Needs `covers: ['pg', 'mysql', 'mysql2']`** | **Pattern-based (detects `db.query()`, `connection.execute()`)** | ❌ NO |
| SQLiteAnalyzer | Already has covers | Package-based (uses sqlite3 API) | ✅ YES |
| FetchAnalyzer | No covers (standard API) | Standard API, no package | ✅ YES |
| ServiceLayerAnalyzer | No covers (pattern-based) | Pattern-based (filename conventions) | ✅ YES |
| ReactAnalyzer | Needs `covers: ['react']` | Package-based (JSX, React hooks) | ✅ YES |
| RustAnalyzer | No covers (file extension) | File extension check (`.rs`) | ✅ YES |
| **SocketAnalyzer** | **NOT MENTIONED** | **Pattern-based (detects `net.connect()`, Node.js built-in)** | ❌ MISSING |
| **SystemDbAnalyzer** | **NOT MENTIONED** | **Pattern-based (detects `system_db.use()`, internal API)** | ❌ MISSING |
| IncrementalAnalysisPlugin | NOT MENTIONED | Infrastructure plugin (not user-facing) | ✅ OK |

**Issues found:**
1. **DatabaseAnalyzer categorized WRONG**: Plan says it needs `covers: ['pg', 'mysql', 'mysql2']`, but analyzer detects PATTERNS (`db.query()`, `connection.execute()`, `pool.query()`), not packages. Adding `covers` would make it skip services that use databases WITHOUT those specific packages.
2. **SocketAnalyzer MISSING**: Uses Node.js built-in `net` module (no package dependency). Pattern-based. No `covers` needed.
3. **SystemDbAnalyzer MISSING**: Internal API analyzer for `system_db.use()` patterns. Pattern-based. No `covers` needed.

---

## Completeness Table 2: Dependency Extraction Scope

Plan extracts from `manifest.service.metadata.packageJson.dependencies`.

| Dependency Type | Extracted? | Can Contain Framework Packages? | Example |
|----------------|-----------|--------------------------------|---------|
| `dependencies` | ✅ YES | Yes | `express: "4.18.0"` |
| `devDependencies` | ❌ NO | **YES** | `@nestjs/cli: "9.0.0"` (NestJS often in devDeps) |
| `peerDependencies` | ❌ NO | **YES** | `react: "18.0.0"` (React libs declare as peer) |

**Issue 4: devDependencies MISSING.**

Real-world case: NestJS projects often have `@nestjs/common` in `dependencies` but `@nestjs/cli` in `devDependencies`. If service only has `@nestjs/cli` in devDeps (dev-only setup), NestJSRouteAnalyzer would INCORRECTLY skip.

**Issue 5: peerDependencies MISSING.**

Real-world case: React component libraries declare `react` as `peerDependency`, not `dependency`. If analyzing a library package, ReactAnalyzer would INCORRECTLY skip.

---

## Completeness Table 3: Express Sub-packages

Plan proposes `ExpressAnalyzer` with `covers: ['express']`.

| Package | Matched by `covers: ['express']`? | Used in Real Projects? |
|---------|-----------------------------------|----------------------|
| `express` | ✅ YES | Always |
| `express-session` | ❌ NO (exact string match) | Very common |
| `express-validator` | ❌ NO | Common |
| `express-rate-limit` | ❌ NO | Common |
| `body-parser` | ❌ NO | Express 4.x built-in, but can be separate |

**Issue 6: Sub-package false negatives.**

Service uses `express-session` but not `express` directly → ExpressAnalyzer skips → misses middleware patterns.

**Mitigation:** Don's plan uses `some(pkg => serviceDeps.has(pkg))` — if `express` is also present, it works. But if ONLY `express-session` exists, it fails.

---

## Completeness Table 4: Socket.IO Client vs Server

Plan proposes `SocketIOAnalyzer` with `covers: ['socket.io']`.

| Package | Matched? | Used Where? |
|---------|---------|-------------|
| `socket.io` | ✅ YES | Server-side |
| `socket.io-client` | ❌ NO | Client-side (browser/Node.js client) |

**Issue 7: Client-side socket.io detection MISSING.**

If analyzing a client-side service with only `socket.io-client` (no server), SocketIOAnalyzer skips. But the analyzer DOES detect client patterns (`socket.emit()`, `socket.on()`).

**Fix:** `covers: ['socket.io', 'socket.io-client']`

---

## Edge Case Verification

### 1. Service Without package.json

**Don's claim:** Empty Set → all plugins with `covers` skip → CORRECT behavior.

**My verification:**
- Service without package.json = raw script or non-npm project
- Framework-specific analyzers (Express, NestJS) should NOT run
- Verdict: ✅ CORRECT

### 2. Monorepo with Shared Dependencies

**Don's claim:** Known limitation, defer to REG-483.

**My concern:** This is NOT a limitation, it's a DESIGN GAP. Plan doesn't specify HOW to handle this. Should it:
- A) Merge root + service deps?
- B) Only use service deps?
- C) Walk up package.json chain?

**Without specification, implementation will be inconsistent.**

**Recommendation:** Decide on approach NOW. My suggestion: B (service deps only) for REG-482, defer A/C to REG-483. Document in code comments.

### 3. Plugin with Multiple Covers (DatabaseAnalyzer)

**Don's example:** `covers: ['pg', 'mysql', 'mysql2']` → OR logic → plugin runs if ANY matches.

**But wait:** DatabaseAnalyzer is PATTERN-BASED, not package-based. This example is WRONG.

Correct behavior: DatabaseAnalyzer should have NO `covers` (runs always), because it detects patterns like `db.query()` that work with ANY database client.

### 4. Scoped Packages

**Don's claim:** `Set.has('@nestjs/common')` exact match works.

**Verification:** ✅ CORRECT. JavaScript `Set.has()` does exact string match including `@` scope.

### 5. Subpath Imports

**Don's claim:** Service imports `lodash/map`, deps has `lodash` → match works.

**Verification:** ✅ CORRECT. `extractServiceDependencies()` uses `Object.keys(packageJson.dependencies)`, which returns package NAMES, not import paths.

---

## Precondition Verification

### Precondition 1: `manifest.service` exists in ANALYSIS phase

**Don's assumption:** UnitManifest has `service` field during ANALYSIS.

**Code verification:**
- Orchestrator.ts:378 creates `service: { ...unit, id, name, path }`
- DiscoveryManager.ts:72 spreads `...service`, preserving all fields including `metadata`
- ✅ CORRECT — spread preserves `metadata.packageJson`

### Precondition 2: `metadata.packageJson.dependencies` structure

**Don's assumption:** `dependencies` is `Record<string, string>` (package name → version).

**Code verification:**
- SimpleProjectDiscovery.ts:39 defines `dependencies?: Record<string, string>`
- WorkspaceDiscovery.ts:36 defines `packageJson: Record<string, unknown>` (less specific)
- ⚠️ UNCLEAR — WorkspaceDiscovery doesn't type dependencies explicitly

**Risk:** If WorkspaceDiscovery returns non-standard structure, `Object.keys()` could fail.

**Mitigation:** Add type guard in `extractServiceDependencies()`:
```typescript
if (packageJson?.dependencies && typeof packageJson.dependencies === 'object') {
  return new Set(Object.keys(packageJson.dependencies));
}
```

### Precondition 3: Phase guard `if (phaseName === 'ANALYSIS')`

**Don's assumption:** Only ANALYSIS needs filtering, ENRICHMENT already has selective enrichment.

**Verification:**
- PhaseRunner.ts:321-327 has ENRICHMENT skip logic (selective enrichment)
- INDEXING phase doesn't have per-service context — indexes MODULE nodes globally
- ✅ CORRECT — ANALYSIS is the right phase

---

## Phase Guard Completeness

Plan only adds filter for `phaseName === 'ANALYSIS'`.

| Phase | Needs Filtering? | Why? |
|-------|-----------------|------|
| DISCOVERY | ❌ NO | Runs once globally, discovers services |
| INDEXING | ❌ NO | Indexes MODULE nodes per service, but no per-service skip logic |
| ANALYSIS | ✅ YES | Runs per service, framework-specific patterns |
| ENRICHMENT | ❌ NO | Already has selective enrichment (RFD-16) |
| VALIDATION | ❌ NO | Runs on full graph, not per-service |

✅ Phase guard is COMPLETE.

---

## Missing Input Categories (RFD-4 Lesson Applied)

Don's plan lists plugins to update with `covers`. Let me enumerate ALL possible plugin categories:

| Category | Count | Should Have Covers? | Examples |
|----------|-------|---------------------|----------|
| **Base parsers** | 1 | ❌ NO (always run) | JSASTAnalyzer |
| **Package-based analyzers** | 7 | ✅ YES | Express (3), NestJS, SocketIO, React, SQLite |
| **Pattern-based analyzers** | 4 | ❌ NO (patterns != packages) | DatabaseAnalyzer, SocketAnalyzer, ServiceLayerAnalyzer, SystemDbAnalyzer |
| **File-extension analyzers** | 1 | ❌ NO (file check sufficient) | RustAnalyzer |
| **Standard API analyzers** | 1 | ❌ NO (no package) | FetchAnalyzer |
| **Infrastructure plugins** | 1 | N/A | IncrementalAnalysisPlugin |

**Don's plan categorizes 7 plugins for `covers`.**
**My enumeration finds 7 package-based plugins.**

But Don MISCATEGORIZED DatabaseAnalyzer (pattern-based) as package-based.
And Don MISSED SocketAnalyzer, SystemDbAnalyzer (both pattern-based, correctly no covers).

**Corrected table:**

| Plugin | Needs Covers? | Reason |
|--------|--------------|--------|
| ExpressRouteAnalyzer | ✅ YES | `['express']` |
| ExpressResponseAnalyzer | ✅ YES | `['express']` |
| ExpressAnalyzer | ✅ YES | `['express']` |
| NestJSRouteAnalyzer | ✅ YES | `['@nestjs/common', '@nestjs/core']` |
| SocketIOAnalyzer | ✅ YES | `['socket.io', 'socket.io-client']` (FIX #7) |
| ReactAnalyzer | ✅ YES | `['react']` |
| SQLiteAnalyzer | ✅ ALREADY HAS | No change |
| DatabaseAnalyzer | ❌ NO | Pattern-based (FIX #1) |
| SocketAnalyzer | ❌ NO | Built-in `net` module |
| ServiceLayerAnalyzer | ❌ NO | Filename patterns |
| SystemDbAnalyzer | ❌ NO | Internal API patterns |
| FetchAnalyzer | ❌ NO | Standard API |
| JSASTAnalyzer | ❌ NO | Base parser |
| RustAnalyzer | ❌ NO | File extension |

**6 plugins need `covers` added** (not 7 as Don claimed).

---

## Algorithm Correctness

### Input Universe for `covers.some(pkg => serviceDeps.has(pkg))`

| Input Category | Behavior | Correct? |
|---------------|----------|----------|
| `covers = undefined` | Skip check, plugin always runs | ✅ YES |
| `covers = []` | Skip check (length === 0), plugin always runs | ✅ YES |
| `covers = ['express']`, deps has `express` | Match found, plugin runs | ✅ YES |
| `covers = ['express']`, deps empty | No match, plugin skips | ✅ YES |
| `covers = ['pg', 'mysql']`, deps has `mysql` | Match found (OR logic), plugin runs | ✅ YES |
| `covers = ['express']`, deps has `express-session` but NOT `express` | No match, plugin skips | ❌ FALSE NEGATIVE (Issue #6) |
| `covers = ['socket.io']`, deps has `socket.io-client` | No match, plugin skips | ❌ FALSE NEGATIVE (Issue #7) |

**Algorithm is sound for exact matches, but has edge cases for sub-packages and variants.**

**Fix:** Either:
1. Use prefix matching: `covers.some(pkg => [...serviceDeps].some(dep => dep.startsWith(pkg)))`
2. List all variants explicitly: `covers: ['express', 'express-session', 'express-validator']`

**Recommendation:** Option 2 for REG-482 (explicit, predictable). Option 1 for future enhancement.

---

## Gaps Summary

**BLOCKING ISSUES:**

1. **DatabaseAnalyzer miscategorized** — pattern-based, should NOT have `covers`
2. **SocketAnalyzer missing from plan** — 15 plugins exist, plan only lists 12
3. **SystemDbAnalyzer missing from plan**
4. **devDependencies not extracted** — NestJS/React can be in devDeps
5. **peerDependencies not extracted** — React libs use peerDeps
6. **Express sub-packages** — `express-session` won't match `covers: ['express']`
7. **Socket.IO client** — `socket.io-client` won't match `covers: ['socket.io']`

**CLARIFICATION NEEDED:**

8. **Monorepo strategy** — should we merge root deps, walk chain, or service-only? Document decision.

**PRECONDITION RISKS:**

9. **WorkspaceDiscovery packageJson type** — not strongly typed, add type guard

---

## Verdict: REJECT

**Reason:** 7 blocking issues that would cause incorrect skip behavior:
- 1 plugin miscategorized (would skip when it shouldn't)
- 2 plugins missing from plan (would not be updated, but correctly no-op)
- 2 dependency types missing (false negatives for NestJS/React in devDeps/peerDeps)
- 2 sub-package false negatives (express-session, socket.io-client)

**Required fixes before implementation:**

1. Remove DatabaseAnalyzer from "needs covers" list — it's pattern-based
2. Add SocketAnalyzer, SystemDbAnalyzer to "no covers needed" list (document why)
3. Expand dependency extraction to include `devDependencies` and `peerDependencies`
4. Update SocketIOAnalyzer covers: `['socket.io', 'socket.io-client']`
5. Document monorepo strategy decision (recommend: service-only for REG-482)
6. Add type guard for `packageJson.dependencies` structure
7. Consider Express sub-packages — either list explicitly or note as known limitation

**Estimated fix time:** 2-3 hours to revise plan, update code, add tests for edge cases.

---

## Recommended Next Steps

1. Don revises plan addressing all 7 blocking issues
2. Present revised plan to user for confirmation
3. Dijkstra re-reviews revised plan
4. Proceed to implementation ONLY after Dijkstra APPROVES

**DO NOT implement current plan — it will introduce bugs.**

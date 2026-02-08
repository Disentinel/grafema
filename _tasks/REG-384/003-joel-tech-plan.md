# Joel Tech Plan — REG-384

## Scope
Improve method detection and matching policy for HTTP request↔route linking, and tighten param matching semantics.

## Files To Touch
- `packages/core/src/plugins/analysis/FetchAnalyzer.ts`
- `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`
- `test/unit/plugins/analysis/FetchAnalyzer.test.ts`
- `test/unit/plugins/enrichment/HTTPConnectionEnricher.test.js`

## Step-by-Step Plan

### 1) FetchAnalyzer: capture method source
Goal: distinguish explicit vs default vs unknown methods.

Implementation details:
- Add a per-module const map for simple string constants:
  - Traverse AST once to collect `const X = 'POST'` and `const OPTIONS = { method: 'POST', ... }`.
  - Store in two maps: `constStrings: Map<string, string>` and `constObjects: Map<string, ObjectExpression>`.
- Replace `extractMethod` with `extractMethodFromOptions` returning:
  - `{ method: string | null, source: 'explicit' | 'default' | 'unknown' }`.
- Resolution rules:
  - If options arg is `ObjectExpression`: look for `method` property.
    - If missing → `source='default'`, method `'GET'`.
    - If present and string literal/template literal (no expressions) → `source='explicit'`, method uppercased.
    - If present and identifier: resolve in `constStrings`. If found → explicit; if not → `source='unknown'`, method `'UNKNOWN'`.
  - If options arg is `Identifier` and maps to `constObjects`, then apply same rules to that object.
  - If options arg is anything else → `source='unknown'`, method `'UNKNOWN'`.
- Keep `method` and `name` consistent (`UNKNOWN /path` when unknown).
- Add `methodSource` field on http:request nodes: `'explicit' | 'default' | 'unknown'`.

### 2) HTTPConnectionEnricher: method fallback rule
Goal: fallback to GET only if method was unspecified (default), not if unknown or explicit.

Implementation details:
- Read `request.methodSource` (default to `'explicit'` for backward compatibility).
- Compute `routeMethod = route.method?.toUpperCase()`; if missing, skip (avoid default GET on routes).
- If `methodSource === 'unknown'`: skip matching for this request.
- If `methodSource === 'default'`: only allow match when `routeMethod === 'GET'`.
- If `methodSource === 'explicit'`: require `request.method?.toUpperCase() === routeMethod`.

### 3) HTTPConnectionEnricher: safer regex matching
Goal: keep parametric matching but avoid regex false positives for `.` etc.

Implementation details:
- Change `pathsMatch` to build regex by splitting on `{param}` and escaping static segments:
  - `const parts = normalizedRoute.split('{param}')`
  - `const pattern = parts.map(escapeRegExp).join('[^/]+')`
  - `return new RegExp('^' + pattern + '$').test(normalizedRequest)`
- Keep existing `normalizeUrl` for `:param` and `${...}`.

### 4) Tests (TDD)
Add or adjust unit tests:
- FetchAnalyzer:
  - `fetch(url, { method: 'POST' })` → `method='POST'`, `methodSource='explicit'`.
  - `const OPTIONS = { method: 'POST' }; fetch(url, OPTIONS)` → explicit.
  - `const METHOD = 'POST'; fetch(url, { method: METHOD })` → explicit.
  - `fetch(url, { method: METHOD })` with METHOD not resolvable → `method='UNKNOWN'`, `methodSource='unknown'`.
  - `fetch(url)` → `method='GET'`, `methodSource='default'`.
  - `axios({ url, method: 'put' })` → `method='PUT'`, `methodSource='explicit'`.
  - `axios({ url })` → `method='GET'`, `methodSource='default'`.
- HTTPConnectionEnricher:
  - `methodSource='default'` matches only GET routes.
  - `methodSource='unknown'` matches no routes even if path matches.
  - Ensure existing param matching still passes.
  - Add a test path with `.` to ensure literal matching if regex escaping is added.

### 5) Run focused tests
- `node --test test/unit/plugins/analysis/FetchAnalyzer.test.ts`
- `node --test test/unit/plugins/enrichment/HTTPConnectionEnricher.test.js`

## Complexity Analysis
- FetchAnalyzer: still O(N_ast) per module; added const-collection pass is O(N_ast). Memory O(C) for collected consts.
- HTTPConnectionEnricher: same O(R*Q) matching; regex construction is O(L) per route and reused per match if cached, else O(L) per comparison. No new graph-wide scans.

## Open Questions
- Should `methodSource` be added to `http:request` documentation? (Nice-to-have)
- Do we want to treat `method: methodVar` as `unknown` vs `default` when the options arg is not resolvable? Proposed: `unknown` to reduce false positives.

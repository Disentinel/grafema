# Rob Pike Implementation — REG-384

## Changes

### FetchAnalyzer
File: `/Users/vadim/grafema-worker-2/packages/core/src/plugins/analysis/FetchAnalyzer.ts`
- Added `methodSource` to `http:request` nodes (`explicit | default | unknown`).
- Added const collection pass for simple `const METHOD = 'POST'` and `const OPTIONS = { ... }`.
- Replaced `extractMethod` with `extractMethodInfo(...)` to return method + source.
- Added `extractStaticString` to resolve string literals, simple template literals, and const identifiers.
- Axios member calls set `methodSource: explicit`; axios config uses methodSource logic.

### HTTPConnectionEnricher
File: `/Users/vadim/grafema-worker-2/packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`
- Uses `request.methodSource` for matching:
  - `explicit` → exact method match
  - `default` → only match GET routes
  - `unknown` → skip
- Avoids defaulting missing route methods to GET.
- Escapes regex metacharacters in parametric path matching.

### Tests Updated (already in Kent report)
- Method source fallback + dot-literal path behavior.

## Notes
- No refactoring beyond local changes.
- Matching logic is still O(R*Q); no new graph-wide passes.

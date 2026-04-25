# Don Prepare — REG-384

## Files/Methods Targeted for Change

### `packages/core/src/plugins/analysis/FetchAnalyzer.ts`
- `analyzeModule(...)` — adjust request method extraction and add methodSource metadata.
- `extractMethod(...)` (or replacement helper) — return method + source (explicit/default/unknown).
- `extractString(...)` — possibly extend to handle identifiers resolved from consts.
- New helper(s): resolve const strings/objects from module AST (if needed).

### `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`
- `execute(...)` — change method matching policy to use methodSource; restrict GET fallback.
- `pathsMatch(...)` — escape regex metacharacters in static segments to align with Express semantics.

## Refactor-First Scope
Only the methods above. No cross-cutting refactors or architectural changes.

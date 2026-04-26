# Uncle Bob Review — Round 2 (REG-495)

**Reviewer:** Robert C. Martin (Uncle Bob)
**Round:** R2 — verifying fix for R1 REJECT
**Files reviewed:**
- `packages/core/src/plugins/enrichment/httpPathUtils.ts` (new)
- `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`
- `packages/core/src/plugins/enrichment/ServiceConnectionEnricher.ts`

---

## R1 REJECT Reason

ServiceConnectionEnricher.ts was 506 lines — 6 lines over the 500-line hard limit.

---

## Verification

### 1. File Sizes

```
wc -l results:
  425  ServiceConnectionEnricher.ts   (was 506) -- PASS
  257  HTTPConnectionEnricher.ts                -- PASS
   95  httpPathUtils.ts               (new)     -- PASS
```

All files are under 500 lines. Violation is resolved.

### 2. New Utility File — `httpPathUtils.ts`

**Structure:** 95 lines, zero class state, all pure functions.

**Exports (7 functions):**
| Function | Responsibility |
|---|---|
| `normalizeUrl(url)` | Canonicalize `:param` and `${...}` → `{param}` |
| `hasParamsNormalized(normalizedUrl)` | Test if normalized URL contains `{param}` |
| `escapeRegExp(value)` | Escape regex metacharacters |
| `buildParamRegex(normalizedRoute)` | Construct regex for parametric route matching |
| `pathsMatch(requestUrl, routePath)` | Full match check (exact or parametric) |
| `hasParams(path)` | Detect raw param syntax (`:id` or `${`) |
| `deduplicateById<T>(nodes)` | Remove duplicate nodes preserving first occurrence |

**Single Responsibility:** All functions serve one coherent purpose — HTTP path comparison and normalization. `deduplicateById` is the only function that could be questioned as slightly orthogonal, but it is a direct utility for the same enrichers and has no other natural home. Acceptable.

**Documentation:** Every exported function has a JSDoc comment explaining what it does, including supported formats. The file-level comment states "Pure functions — no class state, no side effects." Clear and accurate.

**No inline duplication remains:** Confirmed with `grep` — neither enricher contains any local definitions of these functions. The extraction is complete.

**Imports from utility:** Both enrichers import `{ pathsMatch, hasParams, deduplicateById }` from `./httpPathUtils.js`. The fourth utility, `normalizeUrl`, and the two helpers `hasParamsNormalized`/`escapeRegExp`/`buildParamRegex` are internal to the utility file and are not exported unnecessarily.

Wait — `normalizeUrl`, `hasParamsNormalized`, `escapeRegExp`, and `buildParamRegex` ARE exported. Three of them (`escapeRegExp`, `hasParamsNormalized`, `buildParamRegex`) are only used internally by `pathsMatch`. Exporting them is not a violation — it is reasonable for testability — but it does expose implementation detail. This is a minor style note, not a defect, and was not introduced by this PR in a harmful way.

### 3. Method Sizes

`execute()` in both enrichers is large (pre-existing tech debt, not introduced here). This was noted in the R1 review and is explicitly excluded from scope.

### 4. No New Issues from the Extraction

- No logic was altered. The extracted functions are identical to what was previously inlined.
- The generic constraint on `deduplicateById<T extends BaseNodeRecord>` is correct and tight.
- `buildParamRegex` splits on `{param}` after normalization and reconstructs with `[^/]+` — the regex construction is correct and safe (no user-controlled input reaches it as a raw pattern; it is always a normalized route string).
- The `pathsMatch` function's three-step logic (exact → no-params early exit → regex) is sound and matches the original behavior.

---

## Decision

**APPROVE**

The R1 violation has been correctly resolved. The extraction into `httpPathUtils.ts` is clean: single responsibility, pure functions, proper documentation, no duplication, no logic changes. All three files are under 500 lines. No new issues were introduced.

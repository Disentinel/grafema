## Вадим auto — Completeness Review R2

**Verdict:** APPROVE

---

### Context

Uncle Bob's REJECT in R1 was for one reason: `ServiceConnectionEnricher.ts` at 506 lines breached the 500-line hard limit, with a DRY violation — `normalizeUrl`, `hasParamsNormalized`, `pathsMatch`, `escapeRegExp`, `buildParamRegex`, `hasParams`, `deduplicateById` were copy-pasted verbatim between `ServiceConnectionEnricher.ts` and `HTTPConnectionEnricher.ts`. The fix was to extract those methods into a shared `httpPathUtils.ts`.

---

### 1. All 5 plugins still have onProgress — nothing lost

| Plugin | onProgress destructured | onProgress calls present |
|---|---|---|
| ServiceConnectionEnricher | yes (line 89) | yes — route collection, request collection, matching loop (3 call sites) |
| HTTPConnectionEnricher | yes (line 66) | yes — route collection, request collection, matching loop (3 call sites) |
| SocketConnectionEnricher | yes (line 52) | yes — 4 collection phases + 2 matching phases (6 call sites) |
| ClosureCaptureEnricher | yes (line 65) | yes — closures processing loop (1 call site) |
| RejectionPropagationEnricher | yes (line 49) | yes — propagation iteration loop (1 call site) |

All 5 plugins intact. No regressions.

---

### 2. httpPathUtils.ts functions are correct

Compared each extracted function against both originals (from `git show HEAD`). The originals were identical between `ServiceConnectionEnricher` and `HTTPConnectionEnricher`, confirming they were a verbatim copy.

**normalizeUrl** — extracted version matches originals exactly:
```typescript
return url
  .replace(/:[A-Za-z0-9_]+/g, '{param}')
  .replace(/\$\{[^}]*\}/g, '{param}');
```

**hasParamsNormalized** — matches:
```typescript
return normalizedUrl.includes('{param}');
```

**pathsMatch** — matches. Logic preserved: normalize both → exact match check → no-params guard → regex test. The original `// Normalize both to canonical form` comment was trimmed, but the comment on the function doc is equivalent.

**escapeRegExp** — matches exactly:
```typescript
return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
```

**buildParamRegex** — matches. Original called `this.escapeRegExp(part)`; extracted version calls standalone `escapeRegExp(part)`. Equivalent — both call the same function body.

**hasParams** — matches exactly:
```typescript
if (!path) return false;
return path.includes(':') || path.includes('${');
```

**deduplicateById** — matches. Generics, Set-based dedup, preserves first occurrence. Identical logic.

No behavioral changes. Pure extraction.

---

### 3. Imports are correct (.js extension for ESM)

Both consumer files import from `'./httpPathUtils.js'` (with `.js` extension), which is correct for ESM:

```
ServiceConnectionEnricher.ts:23: import { pathsMatch, hasParams, deduplicateById } from './httpPathUtils.js';
HTTPConnectionEnricher.ts:16:   import { pathsMatch, hasParams, deduplicateById } from './httpPathUtils.js';
```

`httpPathUtils.ts` itself imports `BaseNodeRecord` from `'@grafema/types'` — workspace package, no extension needed. Correct.

---

### 4. File sizes after extraction

| File | Lines before | Lines after | Status |
|---|---|---|---|
| ServiceConnectionEnricher.ts | 506 | 425 | PASS (under 500) |
| HTTPConnectionEnricher.ts | 336 | 257 | PASS |
| httpPathUtils.ts | (new) | 95 | PASS |
| SocketConnectionEnricher.ts | 285 | 285 | unchanged, PASS |
| ClosureCaptureEnricher.ts | 268 | 268 | unchanged, PASS |
| RejectionPropagationEnricher.ts | 255 | 255 | unchanged, PASS |

`ServiceConnectionEnricher.ts` is now at 425 lines — 75 lines below the 500-line hard limit. Uncle Bob's blocker is resolved.

---

### 5. Scope creep check

Changes relative to HEAD:
- `httpPathUtils.ts` — new file, pure extraction of 7 functions that existed verbatim in both enrichers
- `ServiceConnectionEnricher.ts` — removed 7 private methods (~80 lines), added import
- `HTTPConnectionEnricher.ts` — removed 7 private methods (~80 lines), added import, `onProgress` added (this was the REG-495 change), `this.deduplicateById`/`this.pathsMatch`/`this.hasParams` calls replaced with module-level calls
- All other 3 plugins (`SocketConnectionEnricher`, `ClosureCaptureEnricher`, `RejectionPropagationEnricher`) — unchanged by the extraction; only the REG-495 `onProgress` additions are present

No logic changes. No new functionality. No refactoring of anything outside the scope of (a) REG-495 onProgress additions and (b) the extraction that Uncle Bob explicitly required to fix the file-size violation.

---

### 6. No issues found

- No orphaned `this.pathsMatch`, `this.hasParams`, or `this.deduplicateById` calls remaining — both files call the module-level imports correctly
- `BaseNodeRecord` import removed from `HTTPConnectionEnricher.ts` imports section where it was previously needed only for `deduplicateById` — wait, checking: `BaseNodeRecord` is still imported in `HTTPConnectionEnricher.ts` (line 14) for use by the local `HTTPRouteNode` and `HTTPRequestNode` interfaces. Correct — not a stale import
- `deduplicateById` in `httpPathUtils.ts` is generic over `T extends BaseNodeRecord`, which requires `BaseNodeRecord` to be imported in that file. The import on line 8 (`import type { BaseNodeRecord } from '@grafema/types'`) is present and correct

---

### Summary

The extraction is a clean, correct, minimal implementation of what Uncle Bob required. All 5 plugins retain their `onProgress` calls. The extracted functions match the originals exactly. Imports use `.js` extensions. File sizes are within limits. Scope is contained.

**APPROVE.**

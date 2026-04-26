# Joel Tech Plan — REG-384 (Unknown Method Alarm)

## Files
- `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`
- `packages/core/src/diagnostics/categories.ts` (optional category mapping)
- `test/unit/plugins/enrichment/HTTPConnectionEnricherAlarm.test.js` (new)

## Steps
1) Add warning/fatal diagnostics for unknown method:
   - If `methodSource === 'unknown'`:
     - strictMode: push `StrictModeError` with code `STRICT_UNKNOWN_HTTP_METHOD`.
     - non‑strict: push `ValidationError` (severity warning) with code `WARN_HTTP_METHOD_UNKNOWN`.
   - Continue skipping matching for unknown methods.

2) (Optional) Register code in diagnostics categories:
   - Add `http` category with code `WARN_HTTP_METHOD_UNKNOWN` (and strict code if desired).

3) Tests
   - New unit test that runs `HTTPConnectionEnricher` directly with a mock graph:
     - Non‑strict: expects warning error code.
     - Strict: expects `StrictModeError`.

## Complexity
No change to asymptotic runtime; only per‑request checks and diagnostics.

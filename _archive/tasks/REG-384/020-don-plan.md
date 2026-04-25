# Don Plan — REG-384 (Unknown Method Alarm)

## Goal
Raise an explicit alarm when a request method is unknown, and fail in strict mode.

## Proposed Direction
- In `HTTPConnectionEnricher`, detect `request.methodSource === 'unknown'`.
- Non‑strict: emit a warning diagnostic.
- Strict: emit a `StrictModeError` (fatal) so analysis fails after enrichment.

## Notes
- This aligns with “unknown method is bad” without changing matching logic.
- No new graph‑wide scans.

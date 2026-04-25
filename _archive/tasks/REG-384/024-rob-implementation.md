# Rob Pike Implementation — REG-384 (Unknown Method Alarm)

## Changes
File: `/Users/vadim/grafema-worker-2/packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`
- Emit `ValidationError` warning (`WARN_HTTP_METHOD_UNKNOWN`) when `methodSource` is `unknown`.
- Emit `StrictModeError` (`STRICT_UNKNOWN_HTTP_METHOD`) in strict mode for the same condition.
- Skip route matching for unknown methods.
- Warn even when URL is dynamic/absent; message now uses a safe URL label.

## Why
Unknown HTTP method means we can’t safely match routes. In strict mode this should fail fast; in non‑strict mode it should surface as an alarm.

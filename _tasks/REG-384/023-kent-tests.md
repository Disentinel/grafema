# Kent Beck Tests — REG-384 (Unknown Method Alarm)

## Tests Added
File: `/Users/vadim/grafema-worker-2/test/unit/plugins/enrichment/HTTPConnectionEnricherAlarm.test.js`
- Added "unknown method alarms" suite:
  - Non‑strict: emits `WARN_HTTP_METHOD_UNKNOWN` warning, no edges created.
  - Strict: returns `StrictModeError`, no edges created.

## Notes
- Tests were written before implementation.

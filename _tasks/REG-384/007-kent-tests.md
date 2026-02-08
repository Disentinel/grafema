# Kent Beck Tests — REG-384

## Tests Added/Updated

### FetchAnalyzer method source detection
File: `/Users/vadim/grafema-worker-2/test/unit/plugins/analysis/FetchAnalyzer.test.ts`
- Added `HTTP method source detection` suite:
  - Default method when options omitted → `methodSource = default`.
  - Explicit method from object literal → `methodSource = explicit`.
  - Resolve method from const string + const options object → `explicit`.
  - Unresolvable identifier → `method = UNKNOWN`, `methodSource = unknown`.
  - Axios config default vs explicit method detection.

### HTTPConnectionEnricher method fallback + regex
File: `/Users/vadim/grafema-worker-2/test/unit/plugins/enrichment/HTTPConnectionEnricher.test.js`
- Added `Method source fallback` suite:
  - `default` matches only GET routes.
  - `unknown` matches nothing.
- Added dot-literal path test for parametric routes.
- Updated simplified matcher to align with new methodSource policy and escaped-regex behavior.

## Notes
- Tests were added before production changes (TDD).

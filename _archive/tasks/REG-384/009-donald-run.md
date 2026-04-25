# Donald Knuth Run — REG-384

## Test Runs

1) `HTTPConnectionEnricher` unit tests
- Command: `/Users/vadim/.nvm/versions/node/v20.20.0/bin/node --test test/unit/plugins/enrichment/HTTPConnectionEnricher.test.js`
- Result: **PASS**

2) `FetchAnalyzer` unit tests
- Attempt 1: `/Users/vadim/.nvm/versions/node/v20.20.0/bin/node --test test/unit/plugins/analysis/FetchAnalyzer.test.ts`
  - Result: **FAIL** (Node cannot run `.ts` without loader)
- Attempt 2: `/Users/vadim/.nvm/versions/node/v20.20.0/bin/node --import tsx --test test/unit/plugins/analysis/FetchAnalyzer.test.ts`
  - Result: **FAIL** (missing `tsx` in node_modules)
- Attempt 3: `/Users/vadim/.nvm/versions/node/v24.13.0/bin/node --test --experimental-strip-types test/unit/plugins/analysis/FetchAnalyzer.test.ts`
  - Result: **FAIL** (missing build artifact `packages/rfdb/dist/client.js`)

## Notes
- TS tests require either `tsx` installed or a build step to generate `packages/rfdb/dist`.

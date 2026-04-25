# Donald Knuth Run — REG-384 (Build + Tests)

## Build
- `PATH=/Users/vadim/.nvm/versions/node/v20.20.0/bin:$PATH pnpm --filter @grafema/core build` — **PASS**

## RFDB Server
- `cargo build` (in `/Users/vadim/grafema-worker-2/packages/rfdb-server`) — **PASS** (debug binary)

## Tests
1) FetchAnalyzer tests (first run, no cleanup helper)
- `node --import tsx --test test/unit/plugins/analysis/FetchAnalyzer.test.ts`
- Result: **HANGS** (tests appear to pass but runner doesn’t exit due to open handles)

2) FetchAnalyzer tests with cleanup helper import
- `node --import tsx --import /tmp/grafema-test-setup.mjs --test test/unit/plugins/analysis/FetchAnalyzer.test.ts`
- Result: **FAIL** (post‑test EPIPE: shared RFDB connection closed while async activity still ongoing)

## Notes
- The shared RFDB test server keeps a client connection open; without explicit cleanup the process doesn’t exit.
- Adding `cleanupAllTestDatabases()` in the test file (or a safer delayed cleanup) would likely fix the hang.

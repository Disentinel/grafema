# Donald Knuth Run — REG-384 (Unknown Method Alarm)

## Build
- `PATH=/Users/vadim/.nvm/versions/node/v20.20.0/bin:$PATH pnpm -r build` — **PASS**
  - RFDB server emits existing warnings (unused imports, dead code in `segment.rs`).

## Tests
- `PATH=/Users/vadim/.nvm/versions/node/v20.20.0/bin:$PATH node --test test/unit/plugins/enrichment/HTTPConnectionEnricherAlarm.test.js` — **PASS**

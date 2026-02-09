# Don Melton - Technical Lead Plan: REG-195 Code Coverage

## Executive Summary

Add code coverage reporting to Grafema using c8, integrate with CI via Codecov, add badge to README.

## Architecture

```
Source:  packages/*/src/**/*.ts
         ↓ tsc WITH sourceMap: true
Build:   packages/*/dist/**/*.js + *.js.map
         ↓ c8 node --test (V8 coverage + source map remapping)
Tests:   test/unit/*.test.js
         ↓ c8 report
Output:  coverage/ (lcov, json, text)
```

## Tool Choice: c8

- Uses V8 native coverage (no instrumentation overhead)
- Works with `node --test` runner
- Source map support for TS→JS remapping
- Industry standard for Node.js projects

## Implementation Phases

### Phase 1: Enable Source Maps (BLOCKER)
- Add `"sourceMap": true` to all packages/*/tsconfig.json
- Without this, coverage reports compiled JS, not original TS

### Phase 2: Install and Configure c8
- Add `c8` to root devDependencies
- Create `.c8rc.json` with scope/exclusions/reporters
- Add `test:coverage` script to root package.json

### Phase 3: CI Integration
- Modify ci.yml test job to use `pnpm test:coverage`
- Add Codecov upload step
- Coverage thresholds: measure first, set after

### Phase 4: Codecov Setup
- Manual: add repo to codecov.io, get token, add to GitHub secrets

### Phase 5: README Badge
- Add Codecov badge after title

## Key Decisions

1. **Separate scripts**: `pnpm test` stays fast (no coverage), `pnpm test:coverage` for CI
2. **Reporters**: text (console) + lcov (HTML/Codecov) + json (machine-readable)
3. **`all: true`**: Report all source files including those not loaded by tests
4. **Thresholds**: Start at 0, measure actual coverage, then set realistic thresholds
5. **Graceful CI**: `fail_ci_if_error: false` on Codecov upload — outages won't break CI

## Files to Modify

1. `packages/*/tsconfig.json` — add sourceMap: true
2. `package.json` — add c8 dep + test:coverage script
3. `.c8rc.json` — new file, c8 configuration
4. `.github/workflows/ci.yml` — coverage + Codecov upload
5. `README.md` — badge
6. `.gitignore` — add coverage/

## Risks

- **Low**: Source maps may slightly increase build time (~5-10%)
- **Low**: Coverage collection adds ~10-20% to test runtime
- **Medium**: First coverage report may show low numbers — frame as baseline

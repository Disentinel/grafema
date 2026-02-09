# Don's Plan: REG-385 — Detect missing Node in PATH (nvm) and provide guidance

## Problem Analysis

When Grafema CLI is installed globally or used via `npx`, users with nvm-managed Node.js may encounter situations where:

1. **`grafema init` → `runAnalyze()`** calls `spawn('node', [...])` (init.ts:77) — if `node` isn't in PATH, this silently fails with exit code 1 and no useful error message.
2. The CLI itself runs via `#!/usr/bin/env node` shebang — if `node` isn't in PATH, the user gets a cryptic shell error like `env: node: No such file or directory`.
3. **`grafema doctor`** has version checks but does NOT validate Node.js availability or version — it should.

The real-world scenario: user opens a new terminal (or IDE terminal, or cron job, or SSH session) where nvm's shell initialization hasn't run. `node` isn't in PATH even though it's installed via nvm.

## Scope Decision: Mini-MLA

This is a well-defined, single-module task (CLI only). The changes are:
- Add a new doctor check (`checkNodeEnvironment`)
- Improve error messaging in `init.ts` when `spawn('node', ...)` fails
- No architectural changes needed

## Plan

### 1. Add `checkNodeEnvironment` doctor check (checks.ts)

New Level 0 check — runs BEFORE everything else (even before `checkGrafemaInitialized`). This is a system prerequisite.

**What it checks:**
- Is `node` available in PATH? (via `which node` or checking `process.execPath`)
- Node.js version >= minimum required (check engines field in package.json, currently likely >=18)
- Is nvm detected but not loaded? (check `NVM_DIR` env var exists but `nvm` not in PATH)

**Behavior:**
- `pass`: Node.js found in PATH, version meets minimum
- `warn`: Node.js version is below recommended but works
- `fail`: Node.js not found in PATH
- Recommendation for nvm users: `source ~/.nvm/nvm.sh` or add to shell profile

### 2. Improve `init.ts` error handling for `spawn('node', ...)`

Currently `runAnalyze()` (init.ts:74-83) spawns `node` and on error just returns exit code 1. When `node` isn't in PATH, the `error` event fires with `ENOENT` but the user sees nothing useful.

**Fix:** Catch the `error` event specifically, detect `ENOENT`, and provide nvm-specific guidance.

### 3. Add tests

- Unit test for `checkNodeEnvironment` in doctor.test.ts
- Test error messaging for init when node is missing (harder to test, may need to validate the function logic)

### 4. Wire into doctor command

- Add `checkNodeEnvironment` as Level 0 in doctor.ts
- Run it first, before init check
- Add Node.js version to `checkVersions` output

## Files Changed

| File | Change |
|------|--------|
| `packages/cli/src/commands/doctor/checks.ts` | Add `checkNodeEnvironment()` |
| `packages/cli/src/commands/doctor.ts` | Wire Level 0 check |
| `packages/cli/src/commands/init.ts` | Better error for `spawn('node', ...)` failure |
| `packages/cli/test/doctor.test.ts` | Add tests for new check |

## Complexity

O(1) — single process.execPath check + one `spawnSync` call for version. No graph traversal, no iteration over nodes.

## Risk: LOW

- All changes are additive (new check, better error messages)
- No existing behavior changes
- No architectural impact

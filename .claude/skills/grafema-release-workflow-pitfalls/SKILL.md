---
name: grafema-release-workflow-pitfalls
description: |
  Fix release script failures in Grafema monorepo. Use when: (1) release.sh fails on
  "Uncommitted changes detected" despite .gitignore rules, (2) release tests fail with
  100+ failures that pass in CI, (3) snapshot tests fail cross-platform (macOS vs Linux),
  (4) npm publish fails with token errors, (5) @grafema/rfdb ships stale binaries
  (rfdb-server --version shows old version like 0.1.0 after release). Covers gitignore
  anchoring in monorepos, stale dist/ builds, rfdb binary CI tag lifecycle, and the
  correct pre-release sequence.
author: Claude Code
version: 1.1.0
date: 2026-02-18
---

# Grafema Release Workflow Pitfalls

## Problem
The `./scripts/release.sh` script has multiple failure points that can block releases. Each failure looks different but has a specific root cause that's not immediately obvious.

## Context / Trigger Conditions

### Pitfall 1: "Uncommitted changes detected" for ignored files
- **Symptom**: Release script fails at pre-flight even though files should be gitignored
- **Error**: `ERROR: Uncommitted changes detected.` showing paths like `packages/core/.grafema/`
- **Root cause**: `.gitignore` pattern `.grafema/*` contains a slash, making it **anchored to root only**. It does NOT match nested `.grafema/` directories in `packages/` or `test/fixtures/`.
- **Fix**: Add `**/.grafema/graph.rfdb/`, `**/.grafema/rfdb.sock`, `**/.grafema/diagnostics.log` to `.gitignore` for nested matches.

### Pitfall 2: 100+ test failures during release (but CI passes)
- **Symptom**: `pnpm test` inside release script fails with massive failures
- **Error**: Various assertion errors, missing methods, wrong behavior
- **Root cause**: Release script runs tests (line ~142) BEFORE building (line ~256). Tests import from `dist/`, not `src/`. If `dist/` is stale from a previous build, tests fail against outdated code.
- **Fix**: Run `pnpm build` manually BEFORE running release script. The script doesn't build before testing.

### Pitfall 3: Snapshot tests fail in CI but pass locally (or vice versa)
- **Symptom**: `GraphSnapshot.test.js` fails with "Snapshot mismatch" on specific fixtures
- **Error**: `Snapshot mismatch for 03-complex-async` / `06-socketio`
- **Root cause**: macOS and Linux rfdb-server binaries may produce different graph output (node ordering, edge serialization). Snapshots generated on one platform don't match the other.
- **Status**: Known issue, no fix yet. Workaround: use `--skip-ci-check` if local tests pass.

### Pitfall 4: npm token expired
- **Symptom**: `npm error code E404` or `Access token expired or revoked`
- **Root cause**: Token in `.npmrc.local` expired
- **Fix**: Run `npm login` or manually update token in `.npmrc.local`

### Pitfall 5: @grafema/rfdb ships stale rfdb-server binaries
- **Symptom**: After release, `npx @grafema/rfdb@<version> --version` shows old version (e.g., `0.1.0` instead of `0.2.12-beta`)
- **Symptom**: New Rust features (deferred indexing, commitBatch fixes) don't work despite being in source
- **Root cause**: `release.sh` packages whatever is in `packages/rfdb-server/prebuilt/`. These binaries come from CI builds triggered by `rfdb-v*` tags. If Rust source changed since the last `rfdb-v*` tag, the prebuilt binaries are stale.
- **Detection**: Compare last `rfdb-v*` tag with recent Rust commits: `git log $(git tag -l 'rfdb-v*' | sort -V | tail -1)..HEAD -- packages/rfdb-server/src/`
- **Fix sequence**:
  1. Push new rfdb tag: `git tag rfdb-v0.X.Y && git push origin rfdb-v0.X.Y`
  2. Wait for CI "Build rfdb-server Binaries" workflow to complete (all 4 platforms)
  3. Download: `./scripts/download-rfdb-binaries.sh rfdb-v0.X.Y`
  4. Verify: `packages/rfdb-server/prebuilt/darwin-x64/rfdb-server --version`
  5. Only THEN run release.sh or manually publish `@grafema/rfdb`
- **Key insight**: npm version tags (`v0.2.12-beta`) and rfdb binary CI tags (`rfdb-v0.2.12-beta`) are **independent**. The release script doesn't check if binaries match the current Rust source. You must manually ensure they're in sync.
- **If already published with stale binaries**: Publish a new version (e.g., `0.2.12-dev1`) with correct binaries using a different dist-tag.

## Solution: Correct Pre-Release Sequence

```bash
# 1. Build first (release script doesn't do this before tests)
pnpm build

# 2. Verify tests pass locally
node --test --test-concurrency=1 'test/unit/*.test.js'

# 3. Check npm auth
npm whoami

# 4. Run release (skip CI check if snapshot cross-platform issue)
./scripts/release.sh 0.2.X-beta --publish --skip-changelog
# Add --skip-ci-check if CI fails only on snapshot mismatch
```

## Verification
- `git status --porcelain` shows only expected changes
- Test summary shows 0 failures
- `npm whoami` returns your username

## Notes
- The `.gitignore` anchoring rule: patterns with `/` in the middle (like `dir/*`) are anchored to the `.gitignore` location. Use `**/dir/*` for recursive matching.
- After a failed publish, the version bump commit and tag may already exist. Check with `git log -1` and `git tag -l 'v*'` before retrying.
- The release script has `--skip-ci-check` and `--skip-changelog` flags but no `--skip-tests` flag.

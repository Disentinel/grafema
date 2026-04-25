# Вадим Решетников Review: REG-340

**Verdict: NEEDS CHANGES**

This plan is technically sound in most respects, but contains several critical architectural and practical issues that must be resolved before approval.

## What Works

1. **Correct native vs. cross-compile strategy**: Using native runners for macOS/linux-x64 and cross-compilation only for linux-arm64 is the right balance.

2. **Platform detection alignment**: The plan correctly maps to existing `postinstall.js` and `index.js` logic.

3. **Binary stripping for size**: Including strip step reduces binary bloat.

4. **Two-workflow pattern**: Separating build from publish gives flexibility and safety.

5. **Tag namespace separation**: `rfdb-v*` vs `v*` is the right choice.

## Technical Concerns

### 1. **CRITICAL: Repository Name Hardcoded in Script**

The download script hardcodes `REPO="Disentinel/grafema"`. If the repository is forked or moved, this breaks silently.

**Required fix**: Auto-detect repo from git remote.

### 2. **CRITICAL: Cargo.lock Not Committed**

Without `Cargo.lock` committed, two identical build runs could produce different binaries. This breaks reproducibility.

**Required action**: Verify `Cargo.lock` is committed and up-to-date.

### 3. **Race Condition in Release Upload**

4 matrix jobs uploading to the same release concurrently. GitHub's API has documented race conditions.

**Required validation**: Test this with actual concurrent uploads.

### 4. **glibc Baseline Compatibility Not Validated**

Ubuntu 22.04 with glibc 2.35 is reasonable, but not documented.

### 5. **Cross-Compile Failure Handling Is Weak**

No automated retry mechanism for transient Docker failures.

### 6. **Missing .gitignore Rules**

No clarity on whether to track prebuilt binaries in git.

### 7. **Download Script Fragility with `gh` CLI**

Script should validate `gh` is available upfront.

### 8. **No Integration Test for Downloaded Binaries**

Workflow uploads binaries but never validates they're functional.

## Blocking Issues

1. **Repository hardcoded in download script** — Must use git remote detection
2. **Cargo.lock status unknown** — Confirm it's committed
3. **Concurrent release upload safety unvalidated** — Needs verification

## Suggestions

### Design-Level

1. Add pre-release validation job
2. Document platform support explicitly
3. Decide binary caching strategy (git vs download)

### Implementation-Level

1. Fix download script: Auto-detect repository from git remote
2. Add gh CLI validation
3. Workflow retry logic for cross-compile
4. Test concurrency
5. Verify Cargo.lock committed

### Process-Level

1. Test with a real tag push
2. Update CLAUDE.md about binary release workflow
3. Update release checklist

## Recommendation

**Do not approve until blocking issues are resolved.**

Once these three are addressed, this becomes a solid plan.

# Don Melton — Plan: RFD-41

**Date:** 2026-02-18
**Config:** Mini-MLA
**Task:** Unify RFDB version numbering (Cargo 0.1.0 vs npm 0.2.11)

---

## Goal

Single version number shared between `packages/rfdb-server/Cargo.toml` and `packages/rfdb-server/package.json`. Every release bumps both. CI blocks merges when they drift.

---

## Source of Truth Decision

**npm `package.json` is the source of truth.** The release script already manages npm versions as canonical. Cargo.toml follows.

---

## Solution Overview

Three changes:

1. **One-time fix:** Update `Cargo.toml` version from `0.1.0` to `0.2.11`
2. **Release script:** Add a step to update `Cargo.toml` when npm versions are bumped
3. **CI check:** Add a step to the existing `version-sync` job that verifies `Cargo.toml` matches the npm version

That's it. No new tools, no new scripts, no new abstractions.

---

## Detailed Changes

### Change 1: One-time fix to Cargo.toml

Edit `packages/rfdb-server/Cargo.toml`, line 3:
```toml
# Before
version = "0.1.0"

# After
version = "0.2.11"
```

This is a one-liner. Commit with message: `fix: sync Cargo.toml version to 0.2.11 to match npm package`.

### Change 2: Release script (`scripts/release.sh`)

In STEP 3 "Update all workspace packages" (around line 240), after the loop that updates all `package.json` files, add one block to update `Cargo.toml`:

```bash
# Update rfdb-server Cargo.toml to match npm version
CARGO_TOML="$ROOT_DIR/packages/rfdb-server/Cargo.toml"
if [ -f "$CARGO_TOML" ]; then
    sed -i.bak 's/^version = "[0-9]*\.[0-9]*\.[0-9]*.*"$/version = "'"$NEW_VERSION"'"/' "$CARGO_TOML"
    rm -f "$CARGO_TOML.bak"
    echo -e "${GREEN}[x] packages/rfdb-server/Cargo.toml -> $NEW_VERSION${NC}"
fi
```

**Why `sed` and not `cargo-edit`:** `cargo set-version` requires `cargo-edit` installed, which adds an external tool dependency to the release process. `sed` with the specific pattern `^version = "..."` on the first occurrence in Cargo.toml is safe and reliable here — the `[package]` version field has a well-known format. The `.bak` cleanup pattern is standard for cross-platform `sed -i`.

**Alternative considered and rejected: `build.rs` injection.** We could have `build.rs` read `package.json` at compile time and emit `cargo:rustc-env=CARGO_PKG_VERSION=...` to override the version. This was rejected because:
- It would break `cargo build` run outside the project context (if `package.json` isn't found)
- It makes the binary version dependent on having Node.js project structure present
- It's surprising behavior that would confuse future maintainers
- The release script approach is simpler and more explicit

**The `sed` pattern is safe because:**
- The pattern `^version = "..."` only matches at line start (no accidental matches in dependency versions like `serde = { version = "1.0", ... }`)
- Cargo.toml dependency versions use `= "X.Y"` not `version = "X.Y.Z"` on a standalone line
- We only need this to work for standard semver (0.2.11, 0.3.0, etc.) — which is what the release script produces

**What about pre-release versions like `0.2.11-beta`?** Cargo supports pre-release semver, so `0.2.11-beta` in Cargo.toml is valid. The regex `^version = "[0-9]*\.[0-9]*\.[0-9]*.*"$` handles this via the `.*` before the closing quote.

### Change 3: CI version-sync check (`.github/workflows/ci.yml`)

In Job 4 "Version Sync", after the existing npm package version loop (around line 247), add:

```yaml
- name: Check Cargo.toml version matches npm version
  run: |
    ROOT_VERSION=$(node -p "require('./package.json').version")
    CARGO_VERSION=$(grep '^version = ' packages/rfdb-server/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/')
    echo "npm version: $ROOT_VERSION"
    echo "Cargo version: $CARGO_VERSION"
    if [ "$CARGO_VERSION" != "$ROOT_VERSION" ]; then
      echo "::error::Cargo.toml version ($CARGO_VERSION) does not match npm version ($ROOT_VERSION)"
      echo "::error::Fix: update packages/rfdb-server/Cargo.toml version to $ROOT_VERSION"
      exit 1
    fi
    echo "Cargo.toml version is in sync: $CARGO_VERSION"
```

This is added as a separate step within the existing `version-sync` job. No new job needed.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/rfdb-server/Cargo.toml` | One-time: `0.1.0` → `0.2.11` |
| `scripts/release.sh` | Add Cargo.toml update after npm version bump |
| `.github/workflows/ci.yml` | Add Cargo version check to existing version-sync job |

**Total: 3 files, ~15 lines changed.**

---

## Commit Plan

1. `fix: sync Cargo.toml version to 0.2.11 to match npm package`
   - `packages/rfdb-server/Cargo.toml` version bump

2. `feat: sync Cargo.toml version in release script and CI (RFD-41)`
   - `scripts/release.sh` — Cargo.toml update step
   - `.github/workflows/ci.yml` — version-sync Cargo check

---

## What This Does NOT Change

- The `build-binaries.yml` workflow and `rfdb-v*` tag scheme — separate concern, not in scope
- How `CARGO_PKG_VERSION` is used in `rfdb_server.rs` — it just works correctly after the fix
- The release workflow UX — same commands, same flow, just Cargo.toml now gets bumped too

---

## Impact on grafema-release Skill

The `grafema-release` skill documents the release process. After this change, the release script automatically handles Cargo.toml — no manual steps needed. The skill documentation may need a note added that Cargo.toml is now also updated automatically, but no workflow changes.

---

## Testing Plan (for Kent)

Tests to write:
1. A script test that exercises the `sed` pattern against a sample Cargo.toml and verifies the output version
2. Verify the CI check script detects a mismatch and exits 1
3. Verify the CI check script passes when versions match
4. No Rust tests needed — we're not changing Rust code, only the version number in Cargo.toml

For the CI check, tests can be small shell scripts or a Node.js test that invokes the version extraction logic.

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `sed` pattern matches wrong line | Low | Pattern anchors to `^version = "` — only first-line Cargo package version |
| Release script fails on macOS `sed` | Low | Using `.bak` suffix for portability; already tested pattern works on Darwin |
| CI job already exists, step addition breaks it | Very Low | Adding a new step to existing job, no changes to existing steps |
| Cargo pre-release versions not supported | Very Low | The `.*` in regex handles suffixes; Cargo supports semver pre-release |

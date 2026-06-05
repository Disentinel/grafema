---
name: grafema-release
description: |
  Grafema release procedure for publishing new versions to npm. Covers happy path,
  pitfalls, rfdb binary lifecycle, and rollback. Use when user says "release",
  "publish", "bump version".
author: Claude Code
version: 3.0.0
date: 2026-05-03
---

# Grafema Release Procedure

## Quick Reference

```bash
./scripts/release.sh patch --dry-run        # Preview
./scripts/release.sh patch                  # Bump only
./scripts/release.sh 0.2.5-beta --publish   # Bump and publish
```

## Pre-Release Checklist

1. On `main` branch, clean working directory
2. `pnpm build` — **MUST run before tests** (tests import from `dist/`)
3. `pnpm test` — verify tests pass
4. `npm whoami` — verify npm auth

## MANDATORY: @grafema/rfdb Binary Download

If releasing `@grafema/rfdb`, download prebuilt binaries BEFORE publishing:

1. Check if Rust source changed since last rfdb tag:
   ```bash
   git log $(git tag -l 'rfdb-v*' | sort -V | tail -1)..HEAD -- packages/rfdb-server/src/
   ```
2. If changed — push new tag: `git tag rfdb-v0.X.Y && git push origin rfdb-v0.X.Y`
3. Wait for CI (all 4 platforms: darwin-x64, darwin-arm64, linux-x64, linux-arm64)
4. Download: `./scripts/download-rfdb-binaries.sh rfdb-v0.X.Y`
5. Verify: `ls -la packages/rfdb-server/prebuilt/*/rfdb-server` — must show 4 binaries

**npm tags (`v0.2.12-beta`) and rfdb CI tags (`rfdb-v0.2.12-beta`) are independent.** The release script doesn't check if binaries match current Rust source.

## Version Types

| Type | npm dist-tag |
|------|-------------|
| `patch` / `minor` / `major` / `0.3.0` | latest |
| `prerelease` / `0.2.5-beta` | beta |

## Publish Order (automatic)

`@grafema/types` → `@grafema/rfdb-client` → `@grafema/util` → `@grafema/mcp` → `@grafema/api` → `@grafema/cli` → `@grafema/rfdb`

## Known Pitfalls

### "Uncommitted changes detected" for ignored files
`.gitignore` pattern `.grafema/*` is anchored to root. Use `**/.grafema/graph.rfdb/` for nested matches.

### 100+ test failures during release (but CI passes)
Release script runs tests BEFORE building. `dist/` is stale. Fix: run `pnpm build` manually first.

### Snapshot tests fail cross-platform
macOS vs Linux rfdb-server may produce different graph output. Workaround: `--skip-ci-check`.

### Stale rfdb-server binaries shipped
`release.sh` packages whatever is in `prebuilt/`. See "MANDATORY" section above.

## CI/CD Integration

1. Push version tag → `release-validate.yml` runs automatically (5-10 min)
2. After validation passes → trigger `release-publish.yml` manually
3. Verify: `npx @grafema/cli@<version> --version`

## Rollback

```bash
npm unpublish @grafema/cli@0.2.5-beta          # within 72 hours
# or
npm deprecate @grafema/cli@0.2.5-beta "Use 0.2.4-beta instead"
git revert HEAD && git push origin main stable
git tag -d v0.2.5-beta && git push origin :refs/tags/v0.2.5-beta
```

## CHANGELOG.md Format

```markdown
## [0.X.Y-beta] - YYYY-MM-DD

### Highlights
### Features
### Bug Fixes
### Infrastructure
### Known Issues
```

## Post-Release

1. `npx @grafema/cli@latest --version`
2. Update Linear issues to Done
3. `stable` branch auto-updated by release script

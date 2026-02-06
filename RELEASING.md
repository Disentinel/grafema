# Releasing Grafema

This document describes the release process for Grafema packages.

## Overview

Grafema uses **unified versioning** — all `@grafema/*` packages share the same version number. This simplifies dependency management and communication ("use version 0.2.5").

## Branch Strategy

```
main ────●────●────●────●────●────●───→
                             \
                              (release v0.2.5)
                               \
stable ─────────────────────────●───→
```

- **`main`** — Development branch. May be unstable.
- **`stable`** — Always points to last released version. Safe for production use.

**Important:** The stable branch never diverges from main. All changes go through main first, then get merged to stable via the release script.

## Version Format

- **Stable**: `X.Y.Z` (e.g., `0.3.0`, `1.0.0`)
- **Pre-release**: `X.Y.Z-beta` or `X.Y.Z-beta.N` (e.g., `0.2.5-beta`, `0.2.5-beta.2`)

### npm dist-tags

- `latest` — Points to latest stable version
- `beta` — Points to latest pre-release version

Install specific versions:
```bash
npm install @grafema/cli@latest   # Stable
npm install @grafema/cli@beta     # Pre-release
npm install @grafema/cli@0.2.5    # Specific version
```

## Quick Start

```bash
# Patch release (0.2.4 -> 0.2.5)
./scripts/release.sh patch --publish

# Minor release (0.2.5 -> 0.3.0)
./scripts/release.sh minor --publish

# Pre-release (0.2.5-beta -> 0.2.5-beta.1)
./scripts/release.sh prerelease --publish

# Specific version
./scripts/release.sh 0.3.0-beta --publish

# Dry run (preview changes)
./scripts/release.sh patch --dry-run
```

## Full Release Procedure

### 1. Pre-flight (automated by script)

- [ ] On `main` branch
- [ ] Working directory clean
- [ ] Tests pass
- [ ] CI passing (checked via gh CLI)

### 2. Binary Check (manual, if releasing @grafema/rfdb)

```bash
# Verify all platform binaries exist
ls -la packages/rfdb-server/prebuilt/*/rfdb-server
# Should show: darwin-arm64, darwin-x64, linux-arm64, linux-x64
```

### 3. Run Release Script

```bash
./scripts/release.sh <version> --publish
```

### 4. Update CHANGELOG.md

When prompted, add entry to `CHANGELOG.md`:

```markdown
## [0.X.Y] - YYYY-MM-DD

### Features
- **REG-XXX**: Description

### Bug Fixes
- **REG-XXX**: Description
```

### 5. Verify (automated by script)

- Version bump across all packages
- Build success
- npm publish
- Git commit and tag
- Push to origin
- Merge to stable

### 6. Post-release

```bash
# Verify
npx @grafema/cli@latest --version

# Update Linear issues
# Announce release
```

## CI/CD Pipeline

GitHub Actions validate releases automatically:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | push/PR | Continuous integration |
| `release-validate.yml` | v* tag | Pre-release validation |
| `release-publish.yml` | manual | npm publish |

### What CI Catches

| Check | Claude Context Limitation Mitigated |
|-------|-------------------------------------|
| Tests pass | Forgot to run tests after changes |
| No .skip/.only | Left debugging code in tests |
| TypeScript | Type errors in untouched files |
| Build | Broken imports after refactoring |
| Version sync | Only bumped some packages |
| Changelog | Forgot to document release |
| Binary check | Forgot rfdb binaries |

## Package Dependencies

Publication order (handled automatically):

1. `@grafema/types`
2. `@grafema/rfdb-client`
3. `@grafema/core`
4. `@grafema/mcp`
5. `@grafema/api`
6. `@grafema/cli`
7. `@grafema/rfdb` (standalone)

## Rollback

### Unpublish (within 72 hours)
```bash
npm unpublish @grafema/cli@0.2.5-beta
```

### Or deprecate
```bash
npm deprecate @grafema/cli@0.2.5-beta "Use 0.2.4-beta instead"
```

### Revert git changes
```bash
git revert HEAD
git push origin main
git tag -d v0.2.5-beta
git push origin :refs/tags/v0.2.5-beta
```

See `/release` skill documentation for detailed rollback procedures.

## Troubleshooting

### Tests fail
Fix tests before releasing. The script won't proceed with failing tests.

### Build fails after version bump
Script automatically reverts version changes. Fix build and retry.

### NPM_TOKEN not found
Set `NPM_TOKEN` env var or create `.npmrc.local`:
```
//registry.npmjs.org/:_authToken=npm_XXXXX
```

### Package shows wrong version on npm
Wait 1-2 minutes for npm registry to update. Verify with:
```bash
npm view @grafema/cli versions --json
```

### CI validation fails
Check the specific failure in GitHub Actions. Fix the issue and push again.
Common issues:
- CHANGELOG.md missing entry for version
- Package versions out of sync
- Test failures

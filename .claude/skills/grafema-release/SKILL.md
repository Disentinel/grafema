---
name: grafema-release
description: |
  Grafema release procedure for publishing new versions to npm. Use when:
  (1) user says "release", "publish", "bump version", (2) preparing a new
  beta/stable release, (3) need to update changelog and documentation before
  publish. Uses unified release script with validation.
author: Claude Code
version: 2.0.0
date: 2026-02-06
---

# Grafema Release Procedure

## When to Use

- User requests a release/publish
- New features ready for users
- Bug fixes need to be shipped

## Quick Reference

```bash
# Preview changes (dry run)
./scripts/release.sh patch --dry-run

# Bump version without publishing
./scripts/release.sh patch

# Bump and publish
./scripts/release.sh 0.2.5-beta --publish
```

## Pre-Release Checklist

The release script validates these automatically, but verify manually first:

1. **On `main` branch**: `git branch --show-current`
2. **Working directory clean**: `git status`
3. **Tests pass**: `pnpm test`
4. **No uncommitted changes**: `git status --porcelain`

## MANDATORY: @grafema/rfdb Binary Download

**IMPORTANT**: If releasing `@grafema/rfdb`, you MUST download prebuilt binaries BEFORE publishing.

### Step 0: Download rfdb-server Binaries

1. **Ensure CI built the binaries**:
   - Push tag: `git tag rfdb-v0.X.Y && git push origin rfdb-v0.X.Y`
   - Wait for CI: https://github.com/Disentinel/grafema/actions
   - All 4 platform jobs must complete (darwin-x64, darwin-arm64, linux-x64, linux-arm64)

2. **Download all binaries**:
   ```bash
   ./scripts/download-rfdb-binaries.sh rfdb-v0.X.Y
   ```

3. **Verify all 4 platforms downloaded**:
   ```bash
   ls -la packages/rfdb-server/prebuilt/*/rfdb-server
   # Must show 4 binaries
   ```

**DO NOT PUBLISH @grafema/rfdb if any platform is missing!**

## CI/CD Integration

Grafema uses GitHub Actions as a safety net. Before publishing:

### 1. Check CI Status

```bash
# View latest CI run
gh run list --workflow=ci.yml --branch=main --limit=3

# If CI is failing, check why:
gh run view <run-id>
```

### 2. After Creating Tag

When you push a version tag, GitHub Actions will:

1. **release-validate.yml** runs automatically
   - Validates all tests pass
   - Checks version sync
   - Verifies CHANGELOG.md entry
   - View: https://github.com/Disentinel/grafema/actions/workflows/release-validate.yml

2. **Wait for validation to pass** (usually 5-10 minutes)

3. **Trigger release-publish.yml manually** (after validation passes)
   - Go to: https://github.com/Disentinel/grafema/actions/workflows/release-publish.yml
   - Click "Run workflow"
   - Enter version (e.g., 0.2.5-beta)
   - Optionally enable dry-run first

### 3. Verify Publication

After publish workflow completes:

```bash
# Check npm registry
npm view @grafema/cli versions --json | tail -5

# Install and verify
npx @grafema/cli@<version> --version
```

### What CI Catches

| Check | Why It Exists |
|-------|---------------|
| Tests pass | Forgot to run tests after changes |
| No .skip/.only | Left debugging code in tests |
| TypeScript | Type errors in untouched files |
| Build | Broken imports after refactoring |
| Version sync | Only bumped some packages |
| Changelog | Forgot to document release |
| Binary check | Forgot rfdb binaries |

**IMPORTANT:** Do NOT publish if validation fails. Fix issues first.

## Release Workflow

### Option A: Simple Patch Release

```bash
./scripts/release.sh patch --publish
```

This will:
1. Run pre-flight checks (tests, clean git)
2. Bump patch version across all packages
3. Build all packages
4. Prompt for CHANGELOG.md update
5. Create commit and tag
6. Publish to npm with appropriate dist-tag
7. Push to origin and merge to stable

### Option B: Specific Version

```bash
./scripts/release.sh 0.3.0-beta --publish
```

### Option C: Dry Run (Preview)

```bash
./scripts/release.sh minor --dry-run
```

## Version Types

| Type | Current | Result | npm dist-tag |
|------|---------|--------|--------------|
| `patch` | 0.2.4-beta | 0.2.5 | latest |
| `minor` | 0.2.4-beta | 0.3.0 | latest |
| `major` | 0.2.4-beta | 1.0.0 | latest |
| `prerelease` | 0.2.4-beta | 0.2.4-beta.1 | beta |
| `0.2.5-beta` | any | 0.2.5-beta | beta |
| `0.3.0` | any | 0.3.0 | latest |

## CHANGELOG.md Format

When the script prompts for changelog update, use this format:

```markdown
## [0.X.Y-beta] - YYYY-MM-DD

### Highlights
- Major changes worth mentioning

### Features
- **REG-XXX**: Description of feature

### Bug Fixes
- **REG-XXX**: Description of fix

### Infrastructure
- Description of internal changes

### Known Issues
- Any known limitations
```

## Package Publish Order

The script publishes in dependency order automatically:

1. `@grafema/types` (no deps)
2. `@grafema/rfdb-client` (depends on types)
3. `@grafema/core` (depends on types, rfdb-client)
4. `@grafema/mcp` (depends on core, types)
5. `@grafema/api` (depends on core, types)
6. `@grafema/cli` (depends on api, core, types)
7. `@grafema/rfdb` (standalone, Rust binary)

## dist-tag Management

The script automatically selects dist-tag based on version:
- Versions with `-beta` or `-alpha` -> `beta` tag
- Versions without prerelease suffix -> `latest` tag

To manually update dist-tags:
```bash
npm dist-tag add @grafema/cli@0.2.5-beta latest
```

## Rollback Procedure

If something goes wrong after publishing:

### 1. Unpublish failed version (within 72 hours)
```bash
npm unpublish @grafema/cli@0.2.5-beta
```

### 2. Or deprecate
```bash
npm deprecate @grafema/cli@0.2.5-beta "Use 0.2.4-beta instead"
```

### 3. Revert git changes
```bash
git revert HEAD
git push origin main
git push origin stable
```

### 4. Delete tag
```bash
git tag -d v0.2.5-beta
git push origin :refs/tags/v0.2.5-beta
```

## Common Issues

### "workspace:*" in published package
**Cause**: Used `npm publish` instead of `pnpm publish`
**Fix**: Always use `pnpm publish` via the script

### Package not visible on npm
**Cause**: Published with `--tag beta` but user expects `latest`
**Fix**: `npm dist-tag add @grafema/pkg@version latest`

### NPM_TOKEN not found
**Fix**: Either set environment variable or create `.npmrc.local`:
```
//registry.npmjs.org/:_authToken=npm_XXXXX
```

### Build fails
**Fix**: Script automatically reverts version changes. Fix build issue and retry.

## Post-Release

1. Verify installation: `npx @grafema/cli@latest --version`
2. Update Linear issues to Done
3. Announce in relevant channels

## Stable Branch

The `stable` branch always points to the last released version. The release script automatically merges to stable after successful release.

To manually check stable status:
```bash
git log stable -1 --oneline
git log main -1 --oneline
```

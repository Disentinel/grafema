---
name: grafema-release
description: |
  Grafema release procedure for publishing new versions to npm. Use when:
  (1) user says "release", "publish", "bump version", (2) preparing a new
  beta/stable release, (3) need to update changelog and documentation before
  publish. Covers version bumping, changelog updates, building, and npm publish.
author: Claude Code
version: 1.0.0
date: 2026-02-04
---

# Grafema Release Procedure

## When to Use

- User requests a release/publish
- New features ready for users
- Bug fixes need to be shipped

## Pre-Release Checklist

1. **Verify tests pass**: `pnpm test` (if available)
2. **Check for uncommitted changes**: `git status`
3. **Ensure on correct branch**: usually `main`

## Release Steps

### Step 1: Determine Version

Check current versions:
```bash
grep '"version"' package.json packages/*/package.json
```

Version format: `X.Y.Z-beta` or `X.Y.Z`
- Patch (Z): bug fixes
- Minor (Y): new features, backwards compatible
- Major (X): breaking changes

### Step 2: Bump Versions

Bump all packages that changed:
```bash
# Root package
npm version 0.X.Y-beta --no-git-tag-version

# Individual packages (only those with changes)
cd packages/types && npm version 0.X.Y-beta --no-git-tag-version
cd packages/core && npm version 0.X.Y-beta --no-git-tag-version
cd packages/cli && npm version 0.X.Y-beta --no-git-tag-version
# etc.
```

### Step 3: Update CHANGELOG.md

Edit `/Users/vadimr/grafema/CHANGELOG.md`:

```markdown
## [0.X.Y-beta] - YYYY-MM-DD

### Features
- **REG-XXX**: Description of feature

### Bug Fixes
- **REG-XXX**: Description of fix

### Infrastructure
- Description of internal changes

### Known Issues
- Any known limitations
```

Categories to use:
- **Highlights** (for major releases)
- **Features** / **New Capabilities**
- **Bug Fixes**
- **Infrastructure** / **Improvements**
- **Breaking Changes** (if any)
- **Known Issues**

### Step 4: Build Packages

```bash
# Build all packages
cd packages/types && pnpm build
cd packages/core && pnpm build
cd packages/cli && pnpm build
```

Or from root:
```bash
pnpm -r build
```

Note: VS Code extension may fail due to RustAnalyzer issue (REG-349).

### Step 5: Publish to npm

Use `pnpm publish` (NOT `npm publish`) to convert `workspace:*` dependencies:

```bash
cd packages/types && pnpm publish --access public --tag beta --no-git-checks
cd packages/core && pnpm publish --access public --tag beta --no-git-checks
cd packages/cli && pnpm publish --access public --tag beta --no-git-checks
```

### Step 6: Update dist-tags (if needed)

To make beta the default for `npm install`:
```bash
npm dist-tag add @grafema/types@0.X.Y-beta latest
npm dist-tag add @grafema/core@0.X.Y-beta latest
npm dist-tag add @grafema/cli@0.X.Y-beta latest
```

### Step 7: Verify Publication

```bash
npm view @grafema/cli versions --json | tail -5
npx @grafema/cli@latest --version
```

### Step 8: Commit and Tag (optional)

```bash
git add -A
git commit -m "chore: release v0.X.Y-beta"
git tag v0.X.Y-beta
git push origin main --tags
```

## Package Dependencies

Publication order matters due to dependencies:
1. `@grafema/types` (no dependencies)
2. `@grafema/core` (depends on types)
3. `@grafema/cli` (depends on core, types)
4. `@grafema/mcp` (depends on core)
5. `@grafema/rfdb` (standalone, Rust binary)

## Common Issues

### "workspace:*" in published package
**Cause**: Used `npm publish` instead of `pnpm publish`
**Fix**: Use `pnpm publish` which converts workspace protocol

### Package not visible on npm
**Cause**: Published with `--tag beta` but user expects `latest`
**Fix**: `npm dist-tag add @grafema/pkg@version latest`

### Build fails on VS Code extension
**Cause**: RustAnalyzer top-level await incompatible with CJS
**Status**: Known issue (REG-349), skip VS Code for now

## Post-Release

1. Test installation: `npx @grafema/cli@latest --version`
2. Announce in relevant channels
3. Update Linear issues to Done if applicable

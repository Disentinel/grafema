# Joel Spolsky Technical Plan: REG-67 Release Workflow

**Date:** 2026-02-06

## 1. Summary of Don's Plan

Don proposes a **manual-first, script-assisted** release workflow optimized for AI execution:

1. **Create `stable` branch** - Always points to last known-good release
2. **Unified package versions** - All @grafema/* packages share the same version
3. **Version format** - `X.Y.Z` for stable, `X.Y.Z-beta.N` for pre-release
4. **Single `scripts/release.sh`** - Unified release script with validation
5. **Enhance `/release` skill** - Add stable branch step, version sync check
6. **Create `RELEASING.md`** - Document the full process

**Philosophy:** Simple over clever. Claude executes via `/release` skill.

---

## 2. Current State Summary

### Package Versions (Out of Sync!)

| Package | Current | Target |
|---------|---------|--------|
| root (private) | 0.2.1-beta | 0.2.4-beta |
| @grafema/types | 0.2.1-beta | 0.2.4-beta |
| @grafema/core | 0.2.3-beta | 0.2.4-beta |
| @grafema/cli | 0.2.3-beta | 0.2.4-beta |
| @grafema/mcp | 0.2.1-beta | 0.2.4-beta |
| @grafema/api | 0.1.0-beta | 0.2.4-beta |
| @grafema/rfdb-client | 0.2.1-beta | 0.2.4-beta |
| @grafema/rfdb | 0.2.3-beta | 0.2.4-beta |

### Package Dependency Order (for publishing)

```
@grafema/types (0 deps)
     |
     v
@grafema/rfdb-client (depends on types)
     |
     v
@grafema/core (depends on types, rfdb-client)
     |
     +---> @grafema/mcp (depends on core, types)
     |
     +---> @grafema/api (depends on core, types)
     |
     v
@grafema/cli (depends on api, core, types)

@grafema/rfdb (standalone, Rust binary)
```

### Files to Modify

1. `scripts/publish.sh` -> **Replace with** `scripts/release.sh`
2. `.claude/skills/grafema-release/SKILL.md` -> **Update**
3. `package.json` (root) -> **Update version, add release script**
4. `packages/*/package.json` -> **Sync versions** (7 packages)
5. **Create** `RELEASING.md`
6. **Create** `stable` branch

---

## 3. Detailed Implementation Steps

### Phase 1: Foundation (Sync Versions + Script)

#### Step 1.1: Create `scripts/release.sh`

**File:** `/grafema/scripts/release.sh`

**Content:**

```bash
#!/bin/bash
# Unified release script for Grafema
#
# Usage:
#   ./scripts/release.sh patch|minor|major|prerelease [--publish] [--dry-run]
#   ./scripts/release.sh 0.2.5-beta [--publish] [--dry-run]
#
# Examples:
#   ./scripts/release.sh patch              # Bump patch, don't publish
#   ./scripts/release.sh 0.2.5-beta --publish   # Set specific version and publish
#   ./scripts/release.sh minor --dry-run    # Preview changes without modifying files

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
VERSION_ARG=""
PUBLISH=false
DRY_RUN=false

for arg in "$@"; do
    case $arg in
        --publish)
            PUBLISH=true
            ;;
        --dry-run)
            DRY_RUN=true
            ;;
        *)
            VERSION_ARG="$arg"
            ;;
    esac
done

if [ -z "$VERSION_ARG" ]; then
    echo -e "${RED}Usage: ./scripts/release.sh <version|bump-type> [--publish] [--dry-run]${NC}"
    echo ""
    echo "Version types: patch, minor, major, prerelease"
    echo "Or explicit version: 0.2.5-beta, 0.3.0, etc."
    echo ""
    echo "Options:"
    echo "  --publish    Publish to npm after versioning"
    echo "  --dry-run    Preview changes without modifying files"
    exit 1
fi

# Publishable packages (order matters for dependency resolution)
PACKAGES=(
    "packages/types"
    "packages/rfdb"
    "packages/core"
    "packages/mcp"
    "packages/api"
    "packages/cli"
    "packages/rfdb-server"
)

#---------------------------------------------------------
# STEP 1: Pre-flight checks
#---------------------------------------------------------
echo -e "${BLUE}=== Pre-flight Checks ===${NC}"

# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
    echo -e "${RED}ERROR: Uncommitted changes detected. Commit or stash first.${NC}"
    git status --short
    exit 1
fi
echo -e "${GREEN}[x] Working directory clean${NC}"

# Check we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo -e "${YELLOW}WARNING: Not on main branch (currently on: $CURRENT_BRANCH)${NC}"
    read -p "Continue anyway? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi
echo -e "${GREEN}[x] Branch: $CURRENT_BRANCH${NC}"

# Run tests
echo -e "${BLUE}Running tests...${NC}"
cd "$ROOT_DIR"
if ! pnpm test; then
    echo -e "${RED}ERROR: Tests failed. Fix before releasing.${NC}"
    exit 1
fi
echo -e "${GREEN}[x] Tests passed${NC}"

#---------------------------------------------------------
# STEP 2: Calculate new version
#---------------------------------------------------------
echo ""
echo -e "${BLUE}=== Version Calculation ===${NC}"

# Get current version from root package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

# Calculate new version
if [[ "$VERSION_ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    # Explicit version provided
    NEW_VERSION="$VERSION_ARG"
else
    # Use npm version to calculate (without actually bumping)
    case "$VERSION_ARG" in
        patch|minor|major)
            NEW_VERSION=$(npm version "$VERSION_ARG" --no-git-tag-version --dry-run 2>/dev/null | grep -v '^v' || echo "")
            if [ -z "$NEW_VERSION" ]; then
                # Fallback: manual calculation for semver
                IFS='.' read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION%%-*}"
                PRERELEASE="${CURRENT_VERSION#*-}"
                case "$VERSION_ARG" in
                    patch) PATCH=$((PATCH + 1)) ;;
                    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
                    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
                esac
                NEW_VERSION="$MAJOR.$MINOR.$PATCH"
            fi
            ;;
        prerelease)
            # Handle prerelease: 0.2.4-beta -> 0.2.4-beta.1, 0.2.4-beta.1 -> 0.2.4-beta.2
            BASE="${CURRENT_VERSION%%-*}"
            PRERELEASE="${CURRENT_VERSION#*-}"
            if [[ "$PRERELEASE" == "$CURRENT_VERSION" ]]; then
                # No prerelease suffix, add one
                NEW_VERSION="$BASE-beta.1"
            elif [[ "$PRERELEASE" =~ \.([0-9]+)$ ]]; then
                # Has number suffix, increment it
                NUM="${BASH_REMATCH[1]}"
                PREFIX="${PRERELEASE%.*}"
                NEW_VERSION="$BASE-$PREFIX.$((NUM + 1))"
            else
                # Has prerelease but no number, add .1
                NEW_VERSION="$BASE-$PRERELEASE.1"
            fi
            ;;
        *)
            echo -e "${RED}ERROR: Unknown version type: $VERSION_ARG${NC}"
            echo "Use: patch, minor, major, prerelease, or explicit version like 0.2.5-beta"
            exit 1
            ;;
    esac
fi

echo -e "${GREEN}New version: $NEW_VERSION${NC}"

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}[DRY RUN] Would update versions to $NEW_VERSION${NC}"
    echo ""
    echo "Packages that would be updated:"
    for pkg in "${PACKAGES[@]}"; do
        echo "  - $pkg"
    done
    echo "  - package.json (root)"
    exit 0
fi

#---------------------------------------------------------
# STEP 3: Update all package versions
#---------------------------------------------------------
echo ""
echo -e "${BLUE}=== Updating Package Versions ===${NC}"

# Update root package.json
npm version "$NEW_VERSION" --no-git-tag-version
echo -e "${GREEN}[x] Root package.json -> $NEW_VERSION${NC}"

# Update all workspace packages
for pkg in "${PACKAGES[@]}"; do
    if [ -f "$ROOT_DIR/$pkg/package.json" ]; then
        cd "$ROOT_DIR/$pkg"
        npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version 2>/dev/null || true
        echo -e "${GREEN}[x] $pkg -> $NEW_VERSION${NC}"
    fi
done

cd "$ROOT_DIR"

#---------------------------------------------------------
# STEP 4: Build all packages
#---------------------------------------------------------
echo ""
echo -e "${BLUE}=== Building Packages ===${NC}"

if ! pnpm build; then
    echo -e "${RED}ERROR: Build failed. Rolling back version changes...${NC}"
    git checkout -- .
    exit 1
fi
echo -e "${GREEN}[x] Build successful${NC}"

#---------------------------------------------------------
# STEP 5: Prompt for changelog update
#---------------------------------------------------------
echo ""
echo -e "${YELLOW}=== Changelog Update Required ===${NC}"
echo ""
echo "Please update CHANGELOG.md with release notes for v$NEW_VERSION"
echo "Press Enter when ready to continue..."
read -r

#---------------------------------------------------------
# STEP 6: Verify changelog was updated
#---------------------------------------------------------
if ! grep -q "\[$NEW_VERSION\]" CHANGELOG.md; then
    echo -e "${YELLOW}WARNING: CHANGELOG.md doesn't contain [$NEW_VERSION] entry.${NC}"
    read -p "Continue anyway? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

#---------------------------------------------------------
# STEP 7: Create commit and tag
#---------------------------------------------------------
echo ""
echo -e "${BLUE}=== Git Commit and Tag ===${NC}"

git add -A
git commit -m "chore: release v$NEW_VERSION"
git tag "v$NEW_VERSION"

echo -e "${GREEN}[x] Created commit and tag v$NEW_VERSION${NC}"

#---------------------------------------------------------
# STEP 8: Publish to npm (if --publish flag)
#---------------------------------------------------------
if [ "$PUBLISH" = true ]; then
    echo ""
    echo -e "${BLUE}=== Publishing to npm ===${NC}"

    # Check for NPM_TOKEN
    if [ -z "$NPM_TOKEN" ]; then
        if [ -f "$ROOT_DIR/.npmrc.local" ]; then
            export NPM_TOKEN=$(grep '_authToken=' "$ROOT_DIR/.npmrc.local" | cut -d'=' -f2)
            echo "Using token from .npmrc.local"
        else
            echo -e "${RED}ERROR: NPM_TOKEN not set and .npmrc.local not found${NC}"
            exit 1
        fi
    fi

    # Determine dist-tag based on version
    if [[ "$NEW_VERSION" =~ -beta|alpha ]]; then
        DIST_TAG="beta"
    else
        DIST_TAG="latest"
    fi

    echo "Publishing with tag: $DIST_TAG"

    # Publish packages in dependency order
    for pkg in "${PACKAGES[@]}"; do
        if [ -f "$ROOT_DIR/$pkg/package.json" ]; then
            PKG_NAME=$(node -p "require('./$pkg/package.json').name")
            PKG_PRIVATE=$(node -p "require('./$pkg/package.json').private || false")

            if [ "$PKG_PRIVATE" = "true" ]; then
                echo -e "${YELLOW}[SKIP] $PKG_NAME (private)${NC}"
                continue
            fi

            cd "$ROOT_DIR/$pkg"
            echo "Publishing $PKG_NAME@$NEW_VERSION..."
            pnpm publish --access public --tag "$DIST_TAG" --no-git-checks
            echo -e "${GREEN}[x] Published $PKG_NAME@$NEW_VERSION${NC}"
        fi
    done

    cd "$ROOT_DIR"
    echo -e "${GREEN}[x] All packages published${NC}"
fi

#---------------------------------------------------------
# STEP 9: Push and merge to stable
#---------------------------------------------------------
echo ""
echo -e "${BLUE}=== Push and Update Stable Branch ===${NC}"

echo "Pushing to origin..."
git push origin "$CURRENT_BRANCH" --tags

# Merge to stable
if git rev-parse --verify stable >/dev/null 2>&1; then
    echo "Merging to stable branch..."
    git checkout stable
    git merge "v$NEW_VERSION" --no-edit
    git push origin stable
    git checkout "$CURRENT_BRANCH"
    echo -e "${GREEN}[x] Stable branch updated${NC}"
else
    echo -e "${YELLOW}[SKIP] No stable branch exists. Create it with: git branch stable${NC}"
fi

#---------------------------------------------------------
# DONE
#---------------------------------------------------------
echo ""
echo -e "${GREEN}=== Release Complete ===${NC}"
echo ""
echo "Version: v$NEW_VERSION"
echo "Tag: v$NEW_VERSION"
if [ "$PUBLISH" = true ]; then
    echo "Published: Yes (tag: $DIST_TAG)"
fi
echo ""
echo "Next steps:"
echo "  1. Verify: npx @grafema/cli@$DIST_TAG --version"
echo "  2. Update Linear issues to Done"
echo "  3. Announce release"
```

**Validation:**
- Script exits with non-zero on any error
- Tests must pass before version bump
- Build must succeed after version bump
- Changelog entry is verified (with manual override option)

**Complexity Analysis:**
- Version sync: O(n) where n = number of packages (currently 7)
- Build: O(build_time), not affected by script
- Total package operations: O(n) - linear, acceptable

---

#### Step 1.2: Update Root package.json

**File:** `/grafema/package.json`

**Changes:**
1. Update version to `0.2.4-beta`
2. Replace `publish:all` script with `release`

```diff
{
  "name": "grafema",
- "version": "0.2.1-beta",
+ "version": "0.2.4-beta",
  ...
  "scripts": {
    ...
-   "publish:all": "./scripts/publish.sh",
+   "release": "./scripts/release.sh",
    ...
  }
}
```

---

#### Step 1.3: Sync All Package Versions to 0.2.4-beta

**Command:** (will be done by release.sh, but documenting for manual execution)

```bash
# Run from repo root
pnpm -r exec -- npm version 0.2.4-beta --no-git-tag-version --allow-same-version
```

**Packages to update:**
| Package | File | Current | New |
|---------|------|---------|-----|
| @grafema/types | packages/types/package.json | 0.2.1-beta | 0.2.4-beta |
| @grafema/core | packages/core/package.json | 0.2.3-beta | 0.2.4-beta |
| @grafema/cli | packages/cli/package.json | 0.2.3-beta | 0.2.4-beta |
| @grafema/mcp | packages/mcp/package.json | 0.2.1-beta | 0.2.4-beta |
| @grafema/api | packages/api/package.json | 0.1.0-beta | 0.2.4-beta |
| @grafema/rfdb-client | packages/rfdb/package.json | 0.2.1-beta | 0.2.4-beta |
| @grafema/rfdb | packages/rfdb-server/package.json | 0.2.3-beta | 0.2.4-beta |

**Complexity:** O(n) where n = 7 packages

---

### Phase 2: Branch Strategy

#### Step 2.1: Create `stable` Branch

**Commands:**

```bash
# From main branch with clean working directory
git checkout main
git pull origin main

# Create stable branch
git branch stable
git push -u origin stable
```

**Validation:**
- `git branch -a | grep stable` shows local and remote stable branch
- `git log stable -1` matches current main HEAD

---

### Phase 3: Update `/release` Skill

#### Step 3.1: Rewrite `grafema-release` Skill

**File:** `/grafema/.claude/skills/grafema-release/SKILL.md`

**New Content:**

```markdown
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
```

---

### Phase 4: Documentation

#### Step 4.1: Create RELEASING.md

**File:** `/grafema/RELEASING.md`

**Content:**

```markdown
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

See `/release` skill documentation for rollback procedures.

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
```

---

#### Step 4.2: Delete Old publish.sh

**File to delete:** `/grafema/scripts/publish.sh`

(After release.sh is working and tested)

---

### Phase 5: Update CLAUDE.md

#### Step 5.1: Add Release Workflow Reference

**File:** `/grafema/CLAUDE.md`

**Add to Skills section:**

```markdown
### /release
**Skill:** `grafema-release`

Use when publishing new versions to npm. Covers:
- Unified versioning across all packages
- Automated pre-flight checks (tests, clean git)
- CHANGELOG.md updates
- Building packages
- Publishing with correct dist-tags
- Automatic stable branch merge

**Trigger:** User says "release", "publish", "bump version"

**Quick command:** `./scripts/release.sh patch --publish`
```

---

## 4. Dependency Graph

```
Phase 1: Foundation
  |
  +-- Step 1.1: Create scripts/release.sh
  |       |
  |       v
  +-- Step 1.2: Update root package.json (depends on 1.1)
  |       |
  |       v
  +-- Step 1.3: Sync all package versions (depends on 1.1)

Phase 2: Branch Strategy (independent of Phase 1)
  |
  +-- Step 2.1: Create stable branch

Phase 3: Update Skill (depends on Phase 1)
  |
  +-- Step 3.1: Rewrite grafema-release skill

Phase 4: Documentation (depends on Phase 1, 2, 3)
  |
  +-- Step 4.1: Create RELEASING.md
  |       |
  |       v
  +-- Step 4.2: Delete old publish.sh

Phase 5: Update CLAUDE.md (depends on Phase 3)
  |
  +-- Step 5.1: Add release workflow reference
```

**Parallelizable:**
- Phase 1 and Phase 2 can be done in parallel
- Phase 3, 4, 5 must wait for Phase 1

---

## 5. Testing/Validation Plan

### Unit Tests for Release Script

No new unit tests needed (shell script). Validation is manual:

1. **Dry run test:**
   ```bash
   ./scripts/release.sh patch --dry-run
   # Expected: Shows version calculation, no files modified
   ```

2. **Version sync test:**
   ```bash
   ./scripts/release.sh 0.2.4-beta
   grep '"version"' package.json packages/*/package.json
   # Expected: All show 0.2.4-beta
   ```

3. **Build test:**
   ```bash
   pnpm build
   # Expected: All packages build successfully
   ```

4. **Publish test (to npm):**
   ```bash
   # Use --dry-run flag if npm supports it, or test with private registry
   ./scripts/release.sh 0.2.4-beta --publish
   npm view @grafema/cli@0.2.4-beta
   # Expected: Package visible on npm
   ```

### Integration Test Checklist

- [ ] Script refuses to run with uncommitted changes
- [ ] Script refuses to run with failing tests
- [ ] Script calculates patch/minor/major correctly
- [ ] Script handles prerelease versions correctly
- [ ] CHANGELOG.md prompt appears
- [ ] Git commit and tag are created
- [ ] Packages publish in correct order
- [ ] stable branch is updated
- [ ] dist-tag is correct (beta for prerelease, latest for stable)

---

## 6. Rollback Plan

### If version sync fails mid-way:

```bash
git checkout -- .
# All changes reverted
```

### If npm publish fails mid-way:

Some packages may be published, others not. Options:

1. **Complete the release manually:**
   ```bash
   cd packages/<failed-package>
   pnpm publish --access public --tag beta --no-git-checks
   ```

2. **Rollback published packages:**
   ```bash
   npm unpublish @grafema/<package>@<version>
   # Within 72 hours only
   ```

3. **Deprecate broken version:**
   ```bash
   npm deprecate @grafema/<package>@<version> "Broken release, use X.Y.Z"
   ```

### If stable branch merge fails:

```bash
# Manual merge
git checkout stable
git merge v<version> --no-edit
git push origin stable
git checkout main
```

### If everything is broken:

```bash
# Delete tag locally and remotely
git tag -d v<version>
git push origin :refs/tags/v<version>

# Revert commit
git revert HEAD
git push origin main

# Force stable to previous state (if needed)
git checkout stable
git reset --hard <previous-release-tag>
git push origin stable --force
```

---

## 7. Estimated Effort

| Phase | Steps | Estimated Time |
|-------|-------|----------------|
| Phase 1: Foundation | 3 | 2-3 hours |
| Phase 2: Branch Strategy | 1 | 10 minutes |
| Phase 3: Update Skill | 1 | 1 hour |
| Phase 4: Documentation | 2 | 1-2 hours |
| Phase 5: Update CLAUDE.md | 1 | 15 minutes |
| **Testing & Validation** | - | 1-2 hours |
| **Total** | 8 | **5-8 hours** |

---

## 8. Success Criteria

1. All @grafema/* packages have unified version (0.2.4-beta)
2. `scripts/release.sh` exists and passes dry-run test
3. `stable` branch exists and matches main
4. `/release` skill updated with new workflow
5. `RELEASING.md` exists with complete documentation
6. Old `publish.sh` deleted
7. User can run `./scripts/release.sh patch --publish` successfully

---

**Ready for implementation by Kent Beck (tests) and Rob Pike (code).**

---

## Phase 2: CI/CD Implementation

### Overview

Phase 2 implements GitHub Actions workflows that serve as Claude's safety net. Each workflow check corresponds to a specific Claude context limitation that might cause issues during releases.

### Existing Workflow Patterns

From `.github/workflows/build-binaries.yml` and `.github/workflows/vscode-release.yml`:

- **pnpm setup**: `pnpm/action-setup@v4` with version 9
- **Node setup**: `actions/setup-node@v4` with Node.js 20
- **Checkout**: `actions/checkout@v4`
- **Release**: `softprops/action-gh-release@v2`
- **Rust**: `dtolnay/rust-toolchain@stable` with `Swatinem/rust-cache@v2`
- **Cross-compile**: `houseabsolute/actions-rust-cross@v0`

### Workflow Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CI/CD WORKFLOW ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  TRIGGER: push to main, pull_request                                        │
│       ↓                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    ci.yml (Continuous Integration)                   │    │
│  │  ┌─────────┐  ┌───────────────┐  ┌───────────┐  ┌──────────────┐   │    │
│  │  │  test   │  │ typecheck-lint│  │   build   │  │ version-sync │   │    │
│  │  └─────────┘  └───────────────┘  └───────────┘  └──────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  TRIGGER: push tag v*                                                        │
│       ↓                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │               release-validate.yml (Pre-Release Gates)              │    │
│  │  ┌─────────┐  ┌───────────────┐  ┌──────────────┐  ┌────────────┐  │    │
│  │  │  tests  │  │ changelog-    │  │ version-sync │  │  no-skip   │  │    │
│  │  │  pass   │  │ entry-exists  │  │    check     │  │  in-tests  │  │    │
│  │  └─────────┘  └───────────────┘  └──────────────┘  └────────────┘  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  TRIGGER: workflow_dispatch (manual, after validation)                       │
│       ↓                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                  release-publish.yml (npm Publish)                   │    │
│  │  ┌─────────┐  ┌───────────────┐  ┌──────────────────────────────┐  │    │
│  │  │ publish │──│ wait 60s for  │──│   verify: npx @grafema/cli   │  │    │
│  │  │ to npm  │  │   npm sync    │  │       @version --version     │  │    │
│  │  └─────────┘  └───────────────┘  └──────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Step 2.1: Create `.github/workflows/ci.yml`

**Purpose:** Runs on every push/PR to catch issues early. This is the primary workflow that validates code quality.

**File:** `/grafema/.github/workflows/ci.yml`

```yaml
# Continuous Integration for Grafema
#
# Runs on:
#   - Every push to main
#   - Every pull request
#
# Validates:
#   - All tests pass (no .skip or .only)
#   - TypeScript compiles
#   - ESLint passes
#   - All packages build
#   - Package versions are in sync

name: CI

on:
  push:
    branches: [main, stable]
  pull_request:
    branches: [main]

env:
  NODE_VERSION: '22'
  PNPM_VERSION: '9'

jobs:
  # Job 1: Run all tests
  test:
    name: Tests
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build (required for tests)
        run: pnpm build

      - name: Run tests
        run: pnpm test

      - name: Check for .only or .skip in test files
        run: |
          echo "Checking for .only() or .skip() in test files..."
          if grep -rE '\.(only|skip)\s*\(' test/ --include="*.test.js" --include="*.test.ts"; then
            echo "::error::Found .only() or .skip() in test files. Remove before releasing."
            exit 1
          fi
          echo "No .only() or .skip() found."

  # Job 2: TypeScript and ESLint
  typecheck-lint:
    name: Typecheck & Lint
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: TypeScript check
        run: pnpm typecheck

      - name: ESLint
        run: pnpm lint

  # Job 3: Build all packages
  build:
    name: Build
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build all packages
        run: pnpm build

      - name: Verify build artifacts exist
        run: |
          echo "Verifying build outputs..."
          # Check that dist directories exist for key packages
          test -d packages/types/dist || (echo "::error::packages/types/dist not found" && exit 1)
          test -d packages/core/dist || (echo "::error::packages/core/dist not found" && exit 1)
          test -d packages/cli/dist || (echo "::error::packages/cli/dist not found" && exit 1)
          test -d packages/mcp/dist || (echo "::error::packages/mcp/dist not found" && exit 1)
          echo "All build artifacts verified."

  # Job 4: Version sync check
  version-sync:
    name: Version Sync
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Check all package versions match
        run: |
          echo "Checking package version synchronization..."

          # Get root version
          ROOT_VERSION=$(node -p "require('./package.json').version")
          echo "Root version: $ROOT_VERSION"

          # Check all publishable packages
          PACKAGES=(
            "packages/types"
            "packages/core"
            "packages/cli"
            "packages/mcp"
            "packages/api"
            "packages/rfdb"
            "packages/rfdb-server"
          )

          MISMATCH=0
          for pkg in "${PACKAGES[@]}"; do
            if [ -f "$pkg/package.json" ]; then
              PKG_VERSION=$(node -p "require('./$pkg/package.json').version")
              PKG_NAME=$(node -p "require('./$pkg/package.json').name")
              if [ "$PKG_VERSION" != "$ROOT_VERSION" ]; then
                echo "::error::Version mismatch: $PKG_NAME is $PKG_VERSION, expected $ROOT_VERSION"
                MISMATCH=1
              else
                echo "  $PKG_NAME: $PKG_VERSION"
              fi
            fi
          done

          if [ "$MISMATCH" -eq 1 ]; then
            echo ""
            echo "::error::Package versions are out of sync. Run: pnpm -r exec npm version $ROOT_VERSION --no-git-tag-version --allow-same-version"
            exit 1
          fi

          echo "All package versions are in sync."
```

**What Each Job Catches (Claude Context Limitations):**

| Job | Catches |
|-----|---------|
| `test` | Forgot to run tests after last change |
| `.only/.skip check` | Left debugging code in tests |
| `typecheck-lint` | Type errors in files not touched |
| `build` | Broken imports after refactoring |
| `version-sync` | Only bumped some packages |

---

### Step 2.2: Create `.github/workflows/release-validate.yml`

**Purpose:** Runs when a release tag is pushed. Must pass before npm publish.

**File:** `/grafema/.github/workflows/release-validate.yml`

```yaml
# Pre-Release Validation for Grafema
#
# Triggered by: git push tag v*
#
# Validates:
#   - All CI checks pass
#   - CHANGELOG.md has entry for this version
#   - Package versions match tag version
#   - For rfdb releases: binaries exist
#
# This workflow MUST pass before npm publish.
# Claude should wait for green status before proceeding.

name: Release Validation

on:
  push:
    tags:
      - 'v*'

env:
  NODE_VERSION: '22'
  PNPM_VERSION: '9'

jobs:
  # Extract version from tag
  setup:
    name: Setup
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.version.outputs.version }}
      is_prerelease: ${{ steps.version.outputs.is_prerelease }}

    steps:
      - name: Extract version from tag
        id: version
        run: |
          TAG="${GITHUB_REF#refs/tags/}"
          VERSION="${TAG#v}"
          echo "version=$VERSION" >> $GITHUB_OUTPUT

          if [[ "$VERSION" =~ -beta|-alpha|-rc ]]; then
            echo "is_prerelease=true" >> $GITHUB_OUTPUT
          else
            echo "is_prerelease=false" >> $GITHUB_OUTPUT
          fi

          echo "Tag: $TAG"
          echo "Version: $VERSION"

  # Run all CI checks
  ci-checks:
    name: CI Checks
    runs-on: ubuntu-latest
    needs: setup
    timeout-minutes: 15

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build all packages
        run: pnpm build

      - name: Run all tests
        run: pnpm test

      - name: TypeScript check
        run: pnpm typecheck

      - name: ESLint
        run: pnpm lint

      - name: Check for .only or .skip in test files
        run: |
          if grep -rE '\.(only|skip)\s*\(' test/ --include="*.test.js" --include="*.test.ts" 2>/dev/null; then
            echo "::error::Found .only() or .skip() in test files"
            exit 1
          fi

  # Validate version numbers match
  version-check:
    name: Version Check
    runs-on: ubuntu-latest
    needs: setup
    timeout-minutes: 5

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Verify all packages have correct version
        env:
          EXPECTED_VERSION: ${{ needs.setup.outputs.version }}
        run: |
          echo "Expected version: $EXPECTED_VERSION"

          # Check root
          ROOT_VERSION=$(node -p "require('./package.json').version")
          if [ "$ROOT_VERSION" != "$EXPECTED_VERSION" ]; then
            echo "::error::Root package.json version ($ROOT_VERSION) doesn't match tag ($EXPECTED_VERSION)"
            exit 1
          fi

          # Check all packages
          PACKAGES=(
            "packages/types"
            "packages/core"
            "packages/cli"
            "packages/mcp"
            "packages/api"
            "packages/rfdb"
            "packages/rfdb-server"
          )

          for pkg in "${PACKAGES[@]}"; do
            if [ -f "$pkg/package.json" ]; then
              PKG_VERSION=$(node -p "require('./$pkg/package.json').version")
              PKG_NAME=$(node -p "require('./$pkg/package.json').name")
              if [ "$PKG_VERSION" != "$EXPECTED_VERSION" ]; then
                echo "::error::$PKG_NAME version ($PKG_VERSION) doesn't match tag ($EXPECTED_VERSION)"
                exit 1
              fi
              echo "  $PKG_NAME: $PKG_VERSION"
            fi
          done

          echo "All package versions match tag."

  # Validate CHANGELOG has entry
  changelog-check:
    name: Changelog Check
    runs-on: ubuntu-latest
    needs: setup
    timeout-minutes: 5

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Check CHANGELOG.md has version entry
        env:
          VERSION: ${{ needs.setup.outputs.version }}
        run: |
          echo "Checking for CHANGELOG.md entry for version $VERSION..."

          if [ ! -f "CHANGELOG.md" ]; then
            echo "::error::CHANGELOG.md not found"
            exit 1
          fi

          # Check for [version] entry with date
          if ! grep -qE "^\#\#\s*\[$VERSION\]\s*-\s*[0-9]{4}-[0-9]{2}-[0-9]{2}" CHANGELOG.md; then
            echo "::error::CHANGELOG.md missing entry for [$VERSION] with date"
            echo "Expected format: ## [$VERSION] - YYYY-MM-DD"
            echo ""
            echo "Recent CHANGELOG entries:"
            head -50 CHANGELOG.md | grep -E "^\#\#" || true
            exit 1
          fi

          echo "CHANGELOG.md has entry for $VERSION"

  # Check for rfdb binaries (only for non-prerelease)
  binary-check:
    name: Binary Check (rfdb)
    runs-on: ubuntu-latest
    needs: setup
    # Only run for stable releases that might publish @grafema/rfdb
    if: needs.setup.outputs.is_prerelease == 'false'
    timeout-minutes: 5

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Check for prebuilt binaries
        run: |
          echo "Checking rfdb-server prebuilt binaries..."

          PLATFORMS=(
            "darwin-arm64"
            "darwin-x64"
            "linux-arm64"
            "linux-x64"
          )

          MISSING=0
          for platform in "${PLATFORMS[@]}"; do
            BINARY="packages/rfdb-server/prebuilt/$platform/rfdb-server"
            if [ ! -f "$BINARY" ]; then
              echo "::warning::Missing binary: $BINARY"
              MISSING=1
            else
              echo "  Found: $platform ($(du -h "$BINARY" | cut -f1))"
            fi
          done

          if [ "$MISSING" -eq 1 ]; then
            echo ""
            echo "::warning::Some platform binaries are missing. If publishing @grafema/rfdb, run:"
            echo "  ./scripts/download-rfdb-binaries.sh rfdb-v<VERSION>"
            # Warning only, not failure - binaries might be downloaded separately
          fi

  # Final status check
  validation-complete:
    name: Validation Complete
    runs-on: ubuntu-latest
    needs: [setup, ci-checks, version-check, changelog-check]
    # Also wait for binary-check if it ran
    if: always()

    steps:
      - name: Check all validations passed
        env:
          CI_RESULT: ${{ needs.ci-checks.result }}
          VERSION_RESULT: ${{ needs.version-check.result }}
          CHANGELOG_RESULT: ${{ needs.changelog-check.result }}
        run: |
          echo "Validation Results:"
          echo "  CI Checks: $CI_RESULT"
          echo "  Version Check: $VERSION_RESULT"
          echo "  Changelog Check: $CHANGELOG_RESULT"

          if [ "$CI_RESULT" != "success" ] || [ "$VERSION_RESULT" != "success" ] || [ "$CHANGELOG_RESULT" != "success" ]; then
            echo ""
            echo "::error::Release validation FAILED. Do NOT proceed with npm publish."
            exit 1
          fi

          echo ""
          echo "All validations PASSED. Safe to proceed with npm publish."
          echo ""
          echo "Next step: Run 'Release Publish' workflow manually from GitHub Actions."
```

**What Each Check Catches:**

| Check | Claude Context Limitation Mitigated |
|-------|-------------------------------------|
| `ci-checks` | Forgot to run tests, build, or lint |
| `.only/.skip` | Left debugging code in tests |
| `version-check` | Only bumped some packages, or version mismatch with tag |
| `changelog-check` | Forgot to document the release |
| `binary-check` | Forgot to download rfdb binaries before publishing |

---

### Step 2.3: Create `.github/workflows/release-publish.yml`

**Purpose:** Manual npm publish after validation passes. Includes post-publish verification.

**File:** `/grafema/.github/workflows/release-publish.yml`

```yaml
# npm Publish Workflow for Grafema
#
# IMPORTANT: This workflow is MANUAL only.
# Only run AFTER release-validate.yml passes.
#
# Trigger: workflow_dispatch from GitHub Actions UI
#
# Required secrets:
#   - NPM_TOKEN: npm access token with publish permissions
#
# Publishes:
#   - @grafema/types
#   - @grafema/rfdb-client (as @grafema/rfdb)
#   - @grafema/core
#   - @grafema/mcp
#   - @grafema/api
#   - @grafema/cli
#   - @grafema/rfdb (rfdb-server, only if binaries present)

name: Release Publish

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to publish (e.g., 0.2.5-beta). Must match existing tag.'
        required: true
        type: string
      dry_run:
        description: 'Dry run (do not actually publish)'
        required: false
        type: boolean
        default: false
      publish_rfdb:
        description: 'Also publish @grafema/rfdb (requires binaries)'
        required: false
        type: boolean
        default: false

env:
  NODE_VERSION: '22'
  PNPM_VERSION: '9'

jobs:
  # Verify tag exists and validation passed
  preflight:
    name: Preflight Check
    runs-on: ubuntu-latest
    outputs:
      tag: ${{ steps.check.outputs.tag }}
      dist_tag: ${{ steps.check.outputs.dist_tag }}

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Verify tag exists
        id: check
        env:
          VERSION: ${{ inputs.version }}
        run: |
          TAG="v$VERSION"

          if ! git rev-parse "$TAG" >/dev/null 2>&1; then
            echo "::error::Tag $TAG does not exist. Create it first."
            exit 1
          fi

          echo "tag=$TAG" >> $GITHUB_OUTPUT

          # Determine dist-tag
          if [[ "$VERSION" =~ -beta|-alpha|-rc ]]; then
            echo "dist_tag=beta" >> $GITHUB_OUTPUT
          else
            echo "dist_tag=latest" >> $GITHUB_OUTPUT
          fi

          echo "Tag: $TAG"
          echo "Dist-tag: $(grep dist_tag $GITHUB_OUTPUT | cut -d= -f2)"

      - name: Check release-validate workflow status
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: v${{ inputs.version }}
        run: |
          echo "Checking if release-validate passed for $TAG..."

          # Get the latest workflow run for release-validate on this tag
          RESULT=$(gh run list \
            --workflow=release-validate.yml \
            --branch="$TAG" \
            --limit=1 \
            --json conclusion \
            --jq '.[0].conclusion' 2>/dev/null || echo "not_found")

          if [ "$RESULT" == "not_found" ] || [ -z "$RESULT" ]; then
            echo "::warning::Could not find release-validate run for $TAG"
            echo "Make sure release-validate.yml passed before publishing!"
          elif [ "$RESULT" != "success" ]; then
            echo "::error::release-validate workflow did not succeed (result: $RESULT)"
            echo "Do NOT publish until validation passes."
            exit 1
          else
            echo "release-validate passed."
          fi

  # Publish packages to npm
  publish:
    name: Publish to npm
    runs-on: ubuntu-latest
    needs: preflight
    timeout-minutes: 20

    steps:
      - name: Checkout tag
        uses: actions/checkout@v4
        with:
          ref: ${{ needs.preflight.outputs.tag }}

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'pnpm'
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build all packages
        run: pnpm build

      - name: Publish packages
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          DRY_RUN: ${{ inputs.dry_run }}
          DIST_TAG: ${{ needs.preflight.outputs.dist_tag }}
          PUBLISH_RFDB: ${{ inputs.publish_rfdb }}
        run: |
          # Package publish order (dependency order)
          PACKAGES=(
            "packages/types"
            "packages/rfdb"
            "packages/core"
            "packages/mcp"
            "packages/api"
            "packages/cli"
          )

          if [ "$PUBLISH_RFDB" == "true" ]; then
            PACKAGES+=("packages/rfdb-server")
          fi

          DRY_RUN_FLAG=""
          if [ "$DRY_RUN" == "true" ]; then
            DRY_RUN_FLAG="--dry-run"
            echo "DRY RUN MODE - packages will NOT be published"
          fi

          for pkg in "${PACKAGES[@]}"; do
            if [ -f "$pkg/package.json" ]; then
              PKG_NAME=$(node -p "require('./$pkg/package.json').name")
              PKG_PRIVATE=$(node -p "require('./$pkg/package.json').private || false")

              if [ "$PKG_PRIVATE" == "true" ]; then
                echo "SKIP: $PKG_NAME (private)"
                continue
              fi

              echo ""
              echo "Publishing $PKG_NAME with tag '$DIST_TAG'..."
              cd "$pkg"
              pnpm publish --access public --tag "$DIST_TAG" --no-git-checks $DRY_RUN_FLAG
              cd -
              echo "Published: $PKG_NAME"
            fi
          done

          echo ""
          echo "All packages published successfully."

  # Verify published packages work
  verify:
    name: Verify Publication
    runs-on: ubuntu-latest
    needs: [preflight, publish]
    # Skip verification in dry-run mode
    if: inputs.dry_run != true
    timeout-minutes: 10

    steps:
      - name: Wait for npm registry propagation
        run: |
          echo "Waiting 60 seconds for npm registry to propagate..."
          sleep 60

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}

      - name: Verify @grafema/cli installation
        env:
          VERSION: ${{ inputs.version }}
          DIST_TAG: ${{ needs.preflight.outputs.dist_tag }}
        run: |
          echo "Verifying @grafema/cli@$VERSION..."

          # Try to install the specific version
          npm install -g @grafema/cli@$VERSION

          # Check version matches
          INSTALLED_VERSION=$(grafema --version 2>/dev/null | head -1 || echo "unknown")
          echo "Installed version: $INSTALLED_VERSION"

          if [[ "$INSTALLED_VERSION" != *"$VERSION"* ]]; then
            echo "::warning::Version mismatch. Expected $VERSION, got $INSTALLED_VERSION"
          fi

          echo ""
          echo "Verification complete."

      - name: Check dist-tag
        env:
          VERSION: ${{ inputs.version }}
          DIST_TAG: ${{ needs.preflight.outputs.dist_tag }}
        run: |
          echo "Checking npm dist-tag..."

          TAG_VERSION=$(npm view @grafema/cli dist-tags.$DIST_TAG 2>/dev/null || echo "unknown")
          echo "  $DIST_TAG tag points to: $TAG_VERSION"

          if [ "$TAG_VERSION" != "$VERSION" ]; then
            echo "::warning::dist-tag '$DIST_TAG' points to $TAG_VERSION, expected $VERSION"
            echo "Update manually if needed: npm dist-tag add @grafema/cli@$VERSION $DIST_TAG"
          fi

  # Summary
  summary:
    name: Publish Summary
    runs-on: ubuntu-latest
    needs: [preflight, publish, verify]
    if: always()

    steps:
      - name: Print summary
        env:
          VERSION: ${{ inputs.version }}
          DIST_TAG: ${{ needs.preflight.outputs.dist_tag }}
          DRY_RUN: ${{ inputs.dry_run }}
          PUBLISH_RESULT: ${{ needs.publish.result }}
          VERIFY_RESULT: ${{ needs.verify.result }}
        run: |
          echo "========================================"
          echo "     RELEASE PUBLISH SUMMARY"
          echo "========================================"
          echo ""
          echo "Version:   $VERSION"
          echo "Dist-tag:  $DIST_TAG"
          echo "Dry run:   $DRY_RUN"
          echo ""
          echo "Results:"
          echo "  Publish: $PUBLISH_RESULT"
          echo "  Verify:  $VERIFY_RESULT"
          echo ""

          if [ "$DRY_RUN" == "true" ]; then
            echo "This was a DRY RUN. No packages were actually published."
            echo "Run again without dry_run to publish for real."
          elif [ "$PUBLISH_RESULT" == "success" ]; then
            echo "Publication successful!"
            echo ""
            echo "Install with:"
            echo "  npm install @grafema/cli@$VERSION"
            echo "  # or"
            echo "  npm install @grafema/cli@$DIST_TAG"
          else
            echo "Publication FAILED. Check logs above."
          fi
```

**Key Features:**

1. **Manual trigger only** - Prevents accidental publishes
2. **Preflight check** - Verifies tag exists and validation passed
3. **Dependency order** - Publishes packages in correct order
4. **Post-publish verification** - Confirms packages actually work
5. **Dry-run mode** - Test the workflow without publishing

---

### Step 2.4: Update `scripts/release.sh` for CI Integration

Add CI status check before tagging. Update the existing script with these additions.

**Changes to add to `/grafema/scripts/release.sh`:**

After the pre-flight checks section, add:

```bash
#---------------------------------------------------------
# STEP 1.5: Check CI status (optional)
#---------------------------------------------------------
if [ "$SKIP_CI_CHECK" != "true" ]; then
    echo ""
    echo -e "${BLUE}=== CI Status Check ===${NC}"

    # Check if gh CLI is available
    if command -v gh &> /dev/null; then
        echo "Checking latest CI run on main..."

        CI_STATUS=$(gh run list --workflow=ci.yml --branch=main --limit=1 --json conclusion --jq '.[0].conclusion' 2>/dev/null || echo "unknown")

        case "$CI_STATUS" in
            success)
                echo -e "${GREEN}[x] CI passing on main${NC}"
                ;;
            failure)
                echo -e "${RED}ERROR: CI is failing on main. Fix before releasing.${NC}"
                echo "View: gh run list --workflow=ci.yml --branch=main"
                exit 1
                ;;
            *)
                echo -e "${YELLOW}WARNING: Could not determine CI status ($CI_STATUS)${NC}"
                read -p "Continue anyway? [y/N] " -n 1 -r
                echo
                if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                    exit 1
                fi
                ;;
        esac
    else
        echo -e "${YELLOW}[SKIP] gh CLI not available, skipping CI check${NC}"
    fi
fi
```

Add `--skip-ci-check` flag parsing:

```bash
# In argument parsing section, add:
        --skip-ci-check)
            SKIP_CI_CHECK=true
            ;;
```

Add to usage message:

```bash
echo "  --skip-ci-check  Skip GitHub Actions CI status check"
```

---

### Step 2.5: Update `/release` Skill with CI Integration

Add new section to the skill document about CI/CD workflow.

**Add to `/grafema/.claude/skills/grafema-release/SKILL.md`:**

After the "Pre-Release Checklist" section, add:

```markdown
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
```

---

### Step 2.6: Secrets Required

The following GitHub secrets must be configured:

| Secret | Purpose | How to Get |
|--------|---------|------------|
| `NPM_TOKEN` | npm publish authentication | `npm token create` with publish access |

**To configure:**
1. Go to https://github.com/Disentinel/grafema/settings/secrets/actions
2. Add `NPM_TOKEN` with your npm access token

---

## Phase 2 Dependency Graph

```
Step 2.1: Create ci.yml
    |
    v
Step 2.2: Create release-validate.yml (depends on 2.1 patterns)
    |
    v
Step 2.3: Create release-publish.yml (depends on 2.2)
    |
    +---> Step 2.4: Update release.sh with CI check (can be parallel)
    |
    v
Step 2.5: Update /release skill (depends on 2.1-2.4)
    |
    v
Step 2.6: Configure NPM_TOKEN secret (can be done anytime)
```

**Parallelizable:**
- Steps 2.1, 2.2, 2.3 can be created in sequence (file creation)
- Step 2.4 can be done in parallel with 2.1-2.3
- Step 2.6 can be done anytime

---

## Phase 2 Testing/Validation Plan

### 1. Test CI Workflow

```bash
# Create test branch
git checkout -b test/ci-workflow

# Make small change and push
echo "# test" >> README.md
git add README.md && git commit -m "test: CI workflow"
git push origin test/ci-workflow

# Create PR, verify CI runs
gh pr create --title "Test CI" --body "Testing CI workflow"

# Check CI status
gh run list --branch=test/ci-workflow
```

### 2. Test Release Validation

```bash
# Create test tag (use prerelease so it doesn't conflict)
git tag v0.0.0-test.1
git push origin v0.0.0-test.1

# Watch validation run
gh run watch --workflow=release-validate.yml

# Should fail (version mismatch) - this is expected!
# Clean up
git tag -d v0.0.0-test.1
git push origin :refs/tags/v0.0.0-test.1
```

### 3. Test Publish Dry-Run

```bash
# Trigger from GitHub Actions UI with dry_run=true
# Verify no actual publish happens
```

---

## Phase 2 Estimated Effort

| Step | Estimated Time |
|------|----------------|
| Step 2.1: Create ci.yml | 30 min |
| Step 2.2: Create release-validate.yml | 45 min |
| Step 2.3: Create release-publish.yml | 45 min |
| Step 2.4: Update release.sh | 20 min |
| Step 2.5: Update /release skill | 20 min |
| Step 2.6: Configure secrets | 10 min |
| Testing & validation | 1-2 hours |
| **Total Phase 2** | **4-5 hours** |

---

## Combined Success Criteria

### Phase 1 (Local)
1. All packages have unified version
2. `scripts/release.sh` exists and passes dry-run
3. `stable` branch exists
4. `/release` skill updated
5. `RELEASING.md` exists

### Phase 2 (CI/CD)
1. `ci.yml` runs on every push/PR
2. `release-validate.yml` runs on v* tag push
3. `release-publish.yml` works with manual trigger
4. Release script checks CI status before proceeding
5. NPM_TOKEN secret configured
6. `/release` skill includes CI integration steps

---

## Full Implementation Order

```
PHASE 1 (Local Infrastructure)
├── 1.1 Create scripts/release.sh
├── 1.2 Update root package.json
├── 1.3 Sync all package versions
├── 2.1 Create stable branch
├── 3.1 Update grafema-release skill
├── 4.1 Create RELEASING.md
├── 4.2 Delete old publish.sh
└── 5.1 Update CLAUDE.md

PHASE 2 (CI/CD)
├── 2.1 Create .github/workflows/ci.yml
├── 2.2 Create .github/workflows/release-validate.yml
├── 2.3 Create .github/workflows/release-publish.yml
├── 2.4 Update scripts/release.sh with CI check
├── 2.5 Update /release skill with CI integration
└── 2.6 Configure NPM_TOKEN secret
```

**Total estimated effort: 9-13 hours**

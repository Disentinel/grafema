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

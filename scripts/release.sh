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
SKIP_CI_CHECK=false
SKIP_CHANGELOG=false
SKIP_RFDB_CHECK=false

for arg in "$@"; do
    case $arg in
        --publish)
            PUBLISH=true
            ;;
        --dry-run)
            DRY_RUN=true
            ;;
        --skip-ci-check)
            SKIP_CI_CHECK=true
            ;;
        --skip-changelog)
            SKIP_CHANGELOG=true
            ;;
        --skip-rfdb-check)
            SKIP_RFDB_CHECK=true
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
    echo "  --publish         Publish to npm after versioning"
    echo "  --dry-run         Preview changes without modifying files"
    echo "  --skip-ci-check   Skip GitHub Actions CI status check"
    echo "  --skip-changelog  Skip CHANGELOG.md update check (for hotfixes)"
    echo "  --skip-rfdb-check Skip rfdb binary freshness check"
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

#---------------------------------------------------------
# STEP 1.6: Check rfdb binary freshness
#---------------------------------------------------------
echo ""
echo -e "${BLUE}=== RFDB Binary Freshness Check ===${NC}"

if [ "$SKIP_RFDB_CHECK" = true ]; then
    echo -e "${YELLOW}[SKIP] RFDB binary check bypassed (--skip-rfdb-check)${NC}"
else

LAST_RFDB_TAG=$(git tag -l 'rfdb-v*' | sort -V | tail -1)
if [ -z "$LAST_RFDB_TAG" ]; then
    echo -e "${RED}ERROR: No rfdb-v* tags found. Cannot verify binary freshness.${NC}"
    echo "Push a tag first: git tag rfdb-v<version> && git push origin rfdb-v<version>"
    exit 1
fi

RUST_CHANGES_SINCE_TAG=$(git log "$LAST_RFDB_TAG"..HEAD --oneline -- packages/rfdb-server/src/ | wc -l | tr -d ' ')
if [ "$RUST_CHANGES_SINCE_TAG" -gt 0 ]; then
    echo -e "${RED}ERROR: $RUST_CHANGES_SINCE_TAG Rust source commits since last rfdb tag ($LAST_RFDB_TAG)${NC}"
    echo ""
    echo "Prebuilt rfdb-server binaries are STALE. Recent Rust changes:"
    git log "$LAST_RFDB_TAG"..HEAD --oneline -- packages/rfdb-server/src/
    echo ""
    echo "Fix: push a new rfdb tag to trigger CI binary build:"
    echo "  git tag rfdb-v<version> && git push origin rfdb-v<version>"
    echo "  # Wait for CI to complete, then:"
    echo "  ./scripts/download-rfdb-binaries.sh rfdb-v<version>"
    exit 1
fi
echo -e "${GREEN}[x] RFDB binaries up-to-date (tag: $LAST_RFDB_TAG, 0 Rust changes since)${NC}"

# Verify all 4 platform binaries exist
MISSING_PLATFORMS=()
for platform in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
    if [ ! -f "$ROOT_DIR/packages/rfdb-server/prebuilt/$platform/rfdb-server" ]; then
        MISSING_PLATFORMS+=("$platform")
    fi
done
if [ ${#MISSING_PLATFORMS[@]} -gt 0 ]; then
    echo -e "${RED}ERROR: Missing rfdb-server binaries for: ${MISSING_PLATFORMS[*]}${NC}"
    echo "Download: ./scripts/download-rfdb-binaries.sh $LAST_RFDB_TAG"
    exit 1
fi
echo -e "${GREEN}[x] All 4 platform binaries present${NC}"

fi  # end SKIP_RFDB_CHECK

# Run tests
echo ""
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
    # Manual calculation for semver
    IFS='.' read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION%%-*}"
    PRERELEASE="${CURRENT_VERSION#*-}"

    case "$VERSION_ARG" in
        patch)
            PATCH=$((PATCH + 1))
            NEW_VERSION="$MAJOR.$MINOR.$PATCH"
            ;;
        minor)
            MINOR=$((MINOR + 1))
            PATCH=0
            NEW_VERSION="$MAJOR.$MINOR.$PATCH"
            ;;
        major)
            MAJOR=$((MAJOR + 1))
            MINOR=0
            PATCH=0
            NEW_VERSION="$MAJOR.$MINOR.$PATCH"
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
    echo "  - packages/rfdb-server/Cargo.toml"
    echo ""
    if [ "$SKIP_CHANGELOG" = true ]; then
        echo -e "${YELLOW}[SKIP] CHANGELOG check bypassed (--skip-changelog)${NC}"
    elif grep -q "\[$NEW_VERSION\]" CHANGELOG.md; then
        echo -e "${GREEN}[x] CHANGELOG.md contains [$NEW_VERSION] entry${NC}"
    else
        echo -e "${RED}[!] CHANGELOG.md does NOT contain [$NEW_VERSION] entry${NC}"
    fi
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

# Update rfdb-server Cargo.toml to match npm version
CARGO_TOML="$ROOT_DIR/packages/rfdb-server/Cargo.toml"
if [ -f "$CARGO_TOML" ]; then
    sed -i.bak 's/^version = "[0-9]*\.[0-9]*\.[0-9]*.*"$/version = "'"$NEW_VERSION"'"/' "$CARGO_TOML"
    rm -f "$CARGO_TOML.bak"
    echo -e "${GREEN}[x] packages/rfdb-server/Cargo.toml -> $NEW_VERSION${NC}"
fi

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
# STEP 5: Verify changelog was updated
#---------------------------------------------------------
echo ""
echo -e "${BLUE}=== Changelog Check ===${NC}"

if [ "$SKIP_CHANGELOG" = true ]; then
    echo -e "${YELLOW}[SKIP] CHANGELOG check bypassed (--skip-changelog)${NC}"
elif ! grep -q "\[$NEW_VERSION\]" CHANGELOG.md; then
    echo -e "${RED}ERROR: CHANGELOG.md does not contain a [$NEW_VERSION] entry.${NC}"
    echo ""
    echo "Please add release notes to CHANGELOG.md before releasing."
    echo "Expected entry format: ## [$NEW_VERSION] - $(date +%Y-%m-%d)"
    echo ""
    echo "To bypass this check for hotfixes, use: --skip-changelog"
    exit 1
else
    echo -e "${GREEN}[x] CHANGELOG.md contains [$NEW_VERSION] entry${NC}"
fi

#---------------------------------------------------------
# STEP 6: Create commit and tag
#---------------------------------------------------------
echo ""
echo -e "${BLUE}=== Git Commit and Tag ===${NC}"

git add -A
git commit -m "chore: release v$NEW_VERSION"
git tag "v$NEW_VERSION"

echo -e "${GREEN}[x] Created commit and tag v$NEW_VERSION${NC}"

#---------------------------------------------------------
# STEP 7: Publish to npm (if --publish flag)
#---------------------------------------------------------
if [ "$PUBLISH" = true ]; then
    echo ""
    echo -e "${BLUE}=== Publishing to npm ===${NC}"

    # Set up .npmrc with auth token for publishing.
    # pnpm publish reads auth from .npmrc, not from env vars.
    NPMRC_CREATED=false
    if [ ! -f "$ROOT_DIR/.npmrc" ]; then
        if [ -f "$ROOT_DIR/.npmrc.local" ]; then
            cp "$ROOT_DIR/.npmrc.local" "$ROOT_DIR/.npmrc"
            NPMRC_CREATED=true
            echo "Using token from .npmrc.local"
        elif [ -n "$NPM_TOKEN" ]; then
            echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > "$ROOT_DIR/.npmrc"
            NPMRC_CREATED=true
            echo "Using token from NPM_TOKEN env var"
        else
            echo -e "${RED}ERROR: No .npmrc, .npmrc.local, or NPM_TOKEN found${NC}"
            exit 1
        fi
    else
        echo "Using existing .npmrc"
    fi

    # Determine dist-tag based on version
    if [[ "$NEW_VERSION" =~ (-beta|-alpha|-rc) ]]; then
        DIST_TAG="beta"
    else
        DIST_TAG="latest"
    fi

    echo "Publishing with tag: $DIST_TAG"

    # Publish packages in dependency order
    for pkg in "${PACKAGES[@]}"; do
        if [ -f "$ROOT_DIR/$pkg/package.json" ]; then
            PKG_NAME=$(node -p "require('$ROOT_DIR/$pkg/package.json').name")
            PKG_PRIVATE=$(node -p "require('$ROOT_DIR/$pkg/package.json').private || false")

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

    # Clean up temporary .npmrc (don't leave secrets in working dir)
    if [ "$NPMRC_CREATED" = true ] && [ -f "$ROOT_DIR/.npmrc" ]; then
        rm "$ROOT_DIR/.npmrc"
        echo "Cleaned up temporary .npmrc"
    fi

    echo -e "${GREEN}[x] All packages published${NC}"
fi

#---------------------------------------------------------
# STEP 8: Push and merge to stable
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

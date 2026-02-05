#!/bin/bash
#
# Download rfdb-server binaries from GitHub Release
#
# Usage: ./scripts/download-rfdb-binaries.sh [tag]
#
# If no tag provided, uses latest rfdb-v* release.
# Places binaries in packages/rfdb-server/prebuilt/{platform}/rfdb-server
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - Internet connection
#
# Examples:
#   ./scripts/download-rfdb-binaries.sh rfdb-v0.2.3
#   ./scripts/download-rfdb-binaries.sh  # uses latest

set -e

cd "$(dirname "$0")/.."

# Validate gh CLI is installed
if ! command -v gh &> /dev/null; then
  echo "Error: GitHub CLI (gh) is required but not installed"
  echo "Install: https://cli.github.com/installation"
  exit 1
fi

# Validate gh is authenticated
if ! gh auth status &> /dev/null 2>&1; then
  echo "Error: GitHub CLI not authenticated"
  echo "Run: gh auth login"
  exit 1
fi

# Auto-detect repository from git remote
REPO=$(git config --get remote.origin.url | sed -E 's/.*github.com[:/]([^/]+\/[^/.]+)(\.git)?$/\1/')
if [ -z "$REPO" ]; then
  echo "Error: Could not detect GitHub repository from git remote"
  echo "Expected format: github.com/owner/repo"
  exit 1
fi

TAG=${1:-}

# If no tag provided, find latest rfdb-v* release
if [ -z "$TAG" ]; then
  echo "Finding latest rfdb-v* release from $REPO..."
  TAG=$(gh release list --repo "$REPO" --limit 20 2>/dev/null | grep '^rfdb-v' | head -1 | awk '{print $1}')
  if [ -z "$TAG" ]; then
    echo "Error: No rfdb-v* releases found in $REPO"
    echo ""
    echo "To create a release:"
    echo "  1. Push a tag: git tag rfdb-v0.2.3 && git push --tags"
    echo "  2. Wait for CI to complete: https://github.com/$REPO/actions"
    echo "  3. Run this script again"
    exit 1
  fi
  echo "Using latest: $TAG"
fi

# Verify release exists
if ! gh release view "$TAG" --repo "$REPO" > /dev/null 2>&1; then
  echo "Error: Release $TAG not found in $REPO"
  exit 1
fi

echo ""
echo "Downloading binaries from release: $TAG"
echo "Repository: $REPO"
echo ""

PREBUILT_DIR="packages/rfdb-server/prebuilt"
PLATFORMS=("darwin-x64" "darwin-arm64" "linux-x64" "linux-arm64")
SUCCESS_COUNT=0
FAIL_COUNT=0

for PLATFORM in "${PLATFORMS[@]}"; do
  BINARY_NAME="rfdb-server-$PLATFORM"
  TARGET_DIR="$PREBUILT_DIR/$PLATFORM"
  TARGET_FILE="$TARGET_DIR/rfdb-server"

  echo "Downloading $PLATFORM..."

  mkdir -p "$TARGET_DIR"

  if gh release download "$TAG" --repo "$REPO" --pattern "$BINARY_NAME" --dir "$TARGET_DIR" --clobber 2>/dev/null; then
    mv "$TARGET_DIR/$BINARY_NAME" "$TARGET_FILE"
    chmod +x "$TARGET_FILE"

    # Verify it's a valid binary
    FILE_TYPE=$(file "$TARGET_FILE" 2>/dev/null || echo "unknown")
    if echo "$FILE_TYPE" | grep -qE "(Mach-O|ELF)"; then
      SIZE=$(ls -lh "$TARGET_FILE" | awk '{print $5}')
      echo "  ✓ $PLATFORM ($SIZE)"
      ((SUCCESS_COUNT++))
    else
      echo "  ⚠ $PLATFORM downloaded but may not be a valid binary"
      echo "     Type: $FILE_TYPE"
      ((SUCCESS_COUNT++))
    fi
  else
    echo "  ✗ $PLATFORM (not found in release)"
    ((FAIL_COUNT++))
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Downloaded: $SUCCESS_COUNT / ${#PLATFORMS[@]}"

if [ $FAIL_COUNT -gt 0 ]; then
  echo ""
  echo "⚠ Some platforms are missing!"
  echo "Check CI status: https://github.com/$REPO/actions"
  echo ""
  echo "Do NOT publish until all 4 platforms are available."
  exit 1
fi

echo ""
echo "✓ All binaries downloaded successfully"
echo ""
echo "Verify with:"
echo "  ls -la packages/rfdb-server/prebuilt/*/rfdb-server"
echo "  file packages/rfdb-server/prebuilt/*/rfdb-server"

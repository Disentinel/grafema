#!/bin/bash
#
# Download ALL Grafema binaries from GitHub Release
#
# Usage: ./scripts/download-platform-binaries.sh [tag]
#
# If no tag provided, uses latest binaries-v* release.
# Places binaries in packages/grafema-{platform}/bin/
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - Internet connection
#
# Examples:
#   ./scripts/download-platform-binaries.sh binaries-v0.3.0-beta
#   ./scripts/download-platform-binaries.sh  # uses latest

set -e

cd "$(dirname "$0")/.."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Validate gh CLI
if ! command -v gh &> /dev/null; then
  echo -e "${RED}Error: GitHub CLI (gh) is required but not installed${NC}"
  echo "Install: https://cli.github.com/installation"
  exit 1
fi

if ! gh auth status &> /dev/null 2>&1; then
  echo -e "${RED}Error: GitHub CLI not authenticated${NC}"
  echo "Run: gh auth login"
  exit 1
fi

# Auto-detect repository
REPO=$(git config --get remote.origin.url | sed -E 's/.*github.com[:/]([^/]+\/[^/.]+)(\.git)?$/\1/')
if [ -z "$REPO" ]; then
  echo -e "${RED}Error: Could not detect GitHub repository from git remote${NC}"
  exit 1
fi

TAG=${1:-}

# If no tag provided, find latest binaries-v* release
if [ -z "$TAG" ]; then
  echo "Finding latest binaries-v* release from $REPO..."
  TAG=$(gh release list --repo "$REPO" --limit 30 2>/dev/null | grep '^binaries-v' | head -1 | awk '{print $1}')
  if [ -z "$TAG" ]; then
    echo -e "${RED}Error: No binaries-v* releases found in $REPO${NC}"
    echo ""
    echo "To create a release:"
    echo "  1. Push a tag: git tag binaries-v0.3.0-beta && git push --tags"
    echo "  2. Wait for CI to complete"
    echo "  3. Run this script again"
    exit 1
  fi
  echo "Using latest: $TAG"
fi

# Verify release exists
if ! gh release view "$TAG" --repo "$REPO" > /dev/null 2>&1; then
  echo -e "${RED}Error: Release $TAG not found in $REPO${NC}"
  exit 1
fi

echo ""
echo -e "${BLUE}Downloading binaries from release: $TAG${NC}"
echo "Repository: $REPO"
echo ""

PLATFORMS=("darwin-arm64" "darwin-x64" "linux-x64" "linux-arm64")

# Required binaries — fail if any missing for any platform
REQUIRED_BINARIES=("rfdb-server" "grafema-orchestrator")

# Optional binaries — download if available, warn if missing
OPTIONAL_BINARIES=(
  "grafema-analyzer"
  "grafema-resolve"
  "grafema-rust-analyzer"
  "grafema-rust-resolve"
  "grafema-java-analyzer"
  "java-resolve"
  "grafema-kotlin-analyzer"
  "grafema-go-analyzer"
  "haskell-analyzer"
  "haskell-resolve"
  "grafema-cpp-analyzer"
  "cpp-resolve"
  "java-parser"
  "kotlin-parser"
  "go-parser"
)

TOTAL_DOWNLOADED=0
TOTAL_FAILED=0
REQUIRED_MISSING=()

for PLATFORM in "${PLATFORMS[@]}"; do
  TARGET_DIR="packages/grafema-${PLATFORM}/bin"
  mkdir -p "$TARGET_DIR"

  echo -e "${BLUE}=== $PLATFORM ===${NC}"

  # Download ONLY required binaries into platform packages (shipped via npm)
  # Optional binaries (Haskell analyzers, language-specific tools) are NOT included —
  # they are lazy-downloaded to ~/.grafema/bin/ on first use via ensureBinary()
  for BINARY in "${REQUIRED_BINARIES[@]}"; do
    ASSET_NAME="${BINARY}-${PLATFORM}"
    TARGET_FILE="${TARGET_DIR}/${BINARY}"

    if gh release download "$TAG" --repo "$REPO" --pattern "$ASSET_NAME" --dir "$TARGET_DIR" --clobber 2>/dev/null; then
      mv "$TARGET_DIR/$ASSET_NAME" "$TARGET_FILE"
      chmod +x "$TARGET_FILE"

      SIZE=$(ls -lh "$TARGET_FILE" | awk '{print $5}')
      echo -e "  ${GREEN}OK${NC} $BINARY ($SIZE)"
      ((TOTAL_DOWNLOADED++))
    else
      echo -e "  ${RED}MISSING${NC} $BINARY (REQUIRED)"
      REQUIRED_MISSING+=("${BINARY}-${PLATFORM}")
      ((TOTAL_FAILED++))
    fi
  done

  # Clean up any stale optional binaries from previous runs
  for BINARY in "${OPTIONAL_BINARIES[@]}"; do
    if [ -f "${TARGET_DIR}/${BINARY}" ]; then
      rm -f "${TARGET_DIR}/${BINARY}"
      echo -e "  ${YELLOW}removed${NC} $BINARY (not shipped in npm — lazy download)"
    fi
  done

  echo ""
done

# Remove .gitkeep files from bin dirs (no longer needed after binaries are placed)
for PLATFORM in "${PLATFORMS[@]}"; do
  rm -f "packages/grafema-${PLATFORM}/bin/.gitkeep"
done

# Summary
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "Downloaded: $TOTAL_DOWNLOADED binaries"

if [ ${#REQUIRED_MISSING[@]} -gt 0 ]; then
  echo ""
  echo -e "${RED}REQUIRED binaries missing:${NC}"
  for ITEM in "${REQUIRED_MISSING[@]}"; do
    echo "  - $ITEM"
  done
  echo ""
  echo -e "${RED}Do NOT publish until all required binaries are available.${NC}"
  echo "Check CI status: https://github.com/$REPO/actions"
  exit 1
fi

# Verify binary types
echo ""
echo -e "${BLUE}Verifying binaries...${NC}"
VERIFY_FAIL=false

for PLATFORM in "${PLATFORMS[@]}"; do
  for REQ in "${REQUIRED_BINARIES[@]}"; do
    FILE="packages/grafema-${PLATFORM}/bin/${REQ}"
    if [ -f "$FILE" ]; then
      FILE_TYPE=$(file "$FILE" 2>/dev/null || echo "unknown")
      if echo "$FILE_TYPE" | grep -qE "(Mach-O|ELF)"; then
        :  # ok
      else
        echo -e "  ${RED}WARN${NC} $FILE — unexpected type: $FILE_TYPE"
        VERIFY_FAIL=true
      fi
    fi
  done
done

if [ "$VERIFY_FAIL" = true ]; then
  echo -e "${YELLOW}Some binaries have unexpected file types. Verify manually.${NC}"
else
  echo -e "${GREEN}All required binaries verified.${NC}"
fi

echo ""
echo -e "${GREEN}Done. Binaries ready for publishing.${NC}"
echo ""
echo "Verify:"
echo "  ls -la packages/grafema-*/bin/"
echo "  file packages/grafema-*/bin/rfdb-server"

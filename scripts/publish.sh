#!/bin/bash
# Publish all @grafema packages to npm
#
# pnpm automatically converts workspace:* to actual versions during publish.
# This script just handles versioning and authentication.
#
# Usage: ./scripts/publish.sh <version>
# Example: ./scripts/publish.sh 0.1.0-alpha.3

set -e

cd "$(dirname "$0")/.."

VERSION=${1:-}
if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/publish.sh <version>"
  echo "Example: ./scripts/publish.sh 0.1.0-alpha.3"
  exit 1
fi

# Check for NPM_TOKEN
if [ -z "$NPM_TOKEN" ]; then
  if [ -f .npmrc.local ]; then
    export NPM_TOKEN=$(grep '_authToken=' .npmrc.local | cut -d'=' -f2)
    echo "Using token from .npmrc.local"
  else
    echo "Error: NPM_TOKEN not set and .npmrc.local not found"
    exit 1
  fi
fi

echo "📦 Publishing @grafema packages v$VERSION"
echo ""

# Update versions in all packages
echo "1. Updating versions to $VERSION..."
pnpm -r exec -- npm version "$VERSION" --no-git-tag-version --allow-same-version 2>/dev/null || true

# Build all packages
echo "2. Building..."
pnpm build

# Publish (pnpm converts workspace:* to actual versions automatically)
echo "3. Publishing to npm..."
pnpm -r publish --access public --no-git-checks

echo ""
echo "✅ All packages published as v$VERSION"
echo ""
echo "Don't forget to commit the version changes:"
echo "  git add packages/*/package.json"
echo "  git commit -m 'chore: release v$VERSION'"
echo "  git tag v$VERSION"
echo "  git push && git push --tags"

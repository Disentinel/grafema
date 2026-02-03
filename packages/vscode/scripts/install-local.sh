#!/bin/bash
# Install Grafema Explore extension locally from source
# Usage: ./scripts/install-local.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$(dirname "$EXTENSION_DIR")")"

echo "=== Grafema Explore Local Install ==="
echo ""

# Check if we're in the right directory
if [ ! -f "$EXTENSION_DIR/package.json" ]; then
    echo "Error: Must run from packages/vscode directory or repo root"
    exit 1
fi

cd "$EXTENSION_DIR"

# Check for vsce
if ! command -v vsce &> /dev/null; then
    echo "Installing vsce (VS Code Extension Manager)..."
    npm install -g @vscode/vsce
fi

# Build dependencies first
echo "1. Building monorepo dependencies..."
cd "$REPO_ROOT"
pnpm install
pnpm build

# Package extension
echo ""
echo "2. Packaging extension..."
cd "$EXTENSION_DIR"
vsce package --no-dependencies

# Find the generated .vsix file
VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -1)

if [ -z "$VSIX_FILE" ]; then
    echo "Error: No .vsix file generated"
    exit 1
fi

echo ""
echo "3. Installing extension..."
code --install-extension "$VSIX_FILE" --force

# Cleanup
rm -f "$VSIX_FILE"

echo ""
echo "=== Installation complete ==="
echo ""
echo "Restart VS Code to activate the extension."
echo "Then open a project with .grafema/graph.rfdb to use Grafema Explore."

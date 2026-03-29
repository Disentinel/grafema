#!/usr/bin/env bash
# Build a native (Haskell/Rust) package and write .build-hash sidecar.
#
# Usage:
#   scripts/build-native.sh <package-dir> [build-command...]
#
# Examples:
#   scripts/build-native.sh packages/js-analyzer cabal install --install-method=copy --overwrite-policy=always
#   scripts/build-native.sh packages/grafema-orchestrator cargo build --release
#   scripts/build-native.sh packages/grafema-resolve cabal install --install-method=copy --overwrite-policy=always
#
# The script:
# 1. Computes blake3 hash of all source files (*.hs, *.rs, *.cabal, Cargo.toml, Cargo.lock)
# 2. Runs the build command
# 3. Writes the hash to <package-dir>/.build-hash
#
# The orchestrator reads .build-hash at runtime and compares with a fresh
# computation to detect stale binaries.

set -euo pipefail

PKG_DIR="${1:?Usage: build-native.sh <package-dir> [build-command...]}"
shift

if [ $# -eq 0 ]; then
  echo "Error: no build command specified" >&2
  exit 1
fi

# Compute deterministic hash of source files
compute_hash() {
  local dir="$1"
  # Include all source files, sorted for determinism.
  # Run find from inside the package dir so paths are relative (src/...),
  # matching the Rust orchestrator's hash computation.
  (cd "$dir" && find src -type f \( -name '*.hs' -o -name '*.rs' \) 2>/dev/null | sort | \
    xargs shasum -a 256 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
}

HASH=$(compute_hash "$PKG_DIR")

if [ -z "$HASH" ]; then
  echo "Warning: no source files found in $PKG_DIR/src" >&2
  exit 0
fi

echo "Source hash: $HASH"

# Check if rebuild is needed
if [ -f "$PKG_DIR/.build-hash" ]; then
  EXISTING=$(cat "$PKG_DIR/.build-hash")
  if [ "$EXISTING" = "$HASH" ]; then
    echo "Binary is up to date (hash unchanged), skipping build"
    exit 0
  fi
fi

# Run the build
echo "Building in $PKG_DIR..."
cd "$PKG_DIR"
"$@"

# Write hash sidecar
echo "$HASH" > .build-hash
echo "Wrote .build-hash: $HASH"

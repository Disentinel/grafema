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
  # LC_ALL=C pins a byte-wise sort independent of the build host's locale, so the
  # order matches the orchestrator's compute_source_hash (Rust string ordering).
  # Without it, a glibc UTF-8 locale collates punctuation differently and the
  # recomputed hash would not equal this .build-hash.
  (cd "$dir" && find src -type f \( -name '*.hs' -o -name '*.rs' \) 2>/dev/null | LC_ALL=C sort | \
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

# Record start time so we can identify binaries produced by this build.
BUILD_START=$(date +%s)

# Run the build
echo "Building in $PKG_DIR..."
cd "$PKG_DIR"
"$@"

# Write hash sidecar
echo "$HASH" > .build-hash
echo "Wrote .build-hash: $HASH"

# Sync newly-installed cabal binaries to ~/.grafema/bin/.
#
# The orchestrator's resolve_binary checks ~/.grafema/bin/ BEFORE ~/.cabal/bin/
# (see packages/grafema-orchestrator/src/config.rs::resolve_binary). Without
# this sync, a stale ~/.grafema/bin/<binary> shadows the fresh cabal-install
# output, leaving end-to-end runs silently using outdated binaries while unit
# tests against the fresh binary pass.
#
# We only run for cabal-install builds; cargo builds keep their binaries in
# target/release/ which the orchestrator reaches via dist-newstyle symlinks.
if printf '%s\n' "$@" | grep -q '^install$'; then
  SYNC_DIR="$HOME/.grafema/bin"
  CABAL_BIN="$HOME/.cabal/bin"
  if [ -d "$CABAL_BIN" ]; then
    mkdir -p "$SYNC_DIR"
    SYNCED=0
    for f in "$CABAL_BIN"/*; do
      [ -f "$f" ] || continue
      # Portable mtime: BSD stat -f, fallback GNU stat -c.
      mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
      if [ "$mtime" -ge "$BUILD_START" ]; then
        base=$(basename "$f")
        cp -f "$f" "$SYNC_DIR/$base"
        echo "Synced ~/.grafema/bin/$base"
        SYNCED=$((SYNCED + 1))
      fi
    done
    if [ "$SYNCED" -eq 0 ]; then
      echo "No new binaries detected in $CABAL_BIN; nothing to sync"
    fi
  fi
fi

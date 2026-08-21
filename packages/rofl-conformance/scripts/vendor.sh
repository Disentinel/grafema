#!/usr/bin/env bash
# One-time vendoring of the ROFL v0 oracle engine + corpus data files.
#
# Engine is pinned to MAIN rev 052a4c5 — the corpus branch (6dfa003) patches
# src/api.ts and src/store.ts, so engine files must NOT come from it.
# Corpus DATA files (audit-v0.2.rofl) come from 6dfa003 via `git show` (data-only).
#
# Run from the package root: bash scripts/vendor.sh /path/to/rofl-clone
set -euo pipefail

ROFL_CLONE="${1:-/home/dev/rofl}"
ENGINE_REV=052a4c5
CORPUS_REV=6dfa003
PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$PKG_DIR/vendor/rofl-v0" "$PKG_DIR/vendor/corpus"

git -C "$ROFL_CLONE" archive "$ENGINE_REV" src boot.rofl LIMITS.md examples scripts \
  | tar -x -C "$PKG_DIR/vendor/rofl-v0/"
echo "$ENGINE_REV" > "$PKG_DIR/vendor/rofl-v0/REV"

git -C "$ROFL_CLONE" show "$CORPUS_REV:run/audit-v0.2.rofl" \
  > "$PKG_DIR/vendor/corpus/audit-v0.2.rofl"
echo "$CORPUS_REV" > "$PKG_DIR/vendor/corpus/REV"

echo "vendored: engine=$ENGINE_REV corpus=$CORPUS_REV"

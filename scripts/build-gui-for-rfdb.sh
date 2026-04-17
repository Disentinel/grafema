#!/bin/bash
# Build the Grafema GUI dist tree and then rebuild rfdb-server with the UI
# bundle embedded. Intended as the one-liner developers run after touching GUI
# sources.
#
# Env vars honored:
#   GRAFEMA_UI_DIST  — if already set, skipped the pnpm build step is still run
#                      but the Cargo build uses whatever the variable points to.
#   SKIP_GUI_BUILD=1 — skip the pnpm build and only rebuild the Rust side.
#
# Exit codes:
#   0 — success
#   non-zero — pnpm or cargo failure
set -euo pipefail

# Resolve repo root relative to this script so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [[ "${SKIP_GUI_BUILD:-0}" != "1" ]]; then
  echo "==> Building @grafema/gui"
  pnpm --filter @grafema/gui build
else
  echo "==> Skipping GUI build (SKIP_GUI_BUILD=1)"
fi

export GRAFEMA_UI_DIST="${GRAFEMA_UI_DIST:-$REPO_ROOT/packages/gui/dist}"

if [[ ! -d "$GRAFEMA_UI_DIST" ]]; then
  echo "error: GRAFEMA_UI_DIST=$GRAFEMA_UI_DIST does not exist" >&2
  exit 1
fi

echo "==> Building rfdb-server with UI embedded from $GRAFEMA_UI_DIST"
cargo build --manifest-path "$REPO_ROOT/packages/rfdb-server/Cargo.toml" --release

echo "==> Done. Binary at: $REPO_ROOT/packages/rfdb-server/target/release/rfdb-server"

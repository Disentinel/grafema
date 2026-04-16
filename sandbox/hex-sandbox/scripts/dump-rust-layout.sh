#!/usr/bin/env bash
# Generate a Rust-produced layout JSON for the sandbox to consume.
#
# Usage:
#   ./scripts/dump-rust-layout.sh
#
# Runs `grafema-orchestrator layout --synthetic <N>` and writes the output
# to public/layout-rust.json. Default N matches the sandbox's tree.json
# leaf count so per-node lookup succeeds for every entry.
#
# Reload the sandbox in your browser after running to apply.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$SANDBOX_DIR/../.." && pwd)"
ORCH_DIR="$ROOT_DIR/packages/grafema-orchestrator"

# Match leaf count from public/tree.json if present, else default 1500.
TREE_JSON="$SANDBOX_DIR/public/tree.json"
if [[ -f "$TREE_JSON" ]]; then
  N=$(node -e "const t = require('$TREE_JSON'); console.log(t.leaves?.length ?? 1500);")
else
  N=1500
fi
echo "Generating Rust layout for $N leaves…"

cd "$ORCH_DIR"
cargo run --release --quiet -- layout \
  --synthetic "$N" \
  --dump-json "$SANDBOX_DIR/public/layout-rust.json"

echo "Wrote $SANDBOX_DIR/public/layout-rust.json"

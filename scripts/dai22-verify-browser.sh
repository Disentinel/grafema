#!/usr/bin/env bash
# DAI-22 Chunk-10b Playwright browser-level verifier.
#
# Usage: ./scripts/dai22-verify-browser.sh
# Starts rfdb-server against .grafema/graph.rfdb, passes PORT to the
# playwright script, tears down on exit.

set -euo pipefail

cd "$(dirname "$0")/.."

RFDB_BIN="packages/rfdb-server/target/release/rfdb-server"
SOCK=".grafema/rfdb.sock"
DATA=".grafema"
DB=".grafema/graph.rfdb"
PLY_SCRIPT="packages/gui/scripts/playwright-verify-dai22.mjs"

[[ -x "$RFDB_BIN" ]] || { echo "rfdb-server not built: $RFDB_BIN"; exit 1; }
[[ -d "$DB" ]]       || { echo "no RFDB at $DB (run grafema analyze && grafema layout --commit)"; exit 1; }
[[ -f "$PLY_SCRIPT" ]] || { echo "missing script: $PLY_SCRIPT"; exit 1; }

# Clean stale state
rm -f "$SOCK" "$DATA/rfdb.pid" "$DATA/rfdb-http.port" "$DB/LOCK"

"$RFDB_BIN" "$DB" --socket "$SOCK" --data-dir "$DATA" --http-port 0 \
  > /tmp/dai22-verify-browser-rfdb.log 2>&1 &
SRV=$!
cleanup() {
  kill "$SRV" 2>/dev/null || true
  wait "$SRV" 2>/dev/null || true
  rm -f "$SOCK" "$DATA/rfdb.pid" "$DATA/rfdb-http.port" "$DB/LOCK"
}
trap cleanup EXIT
sleep 5

PORT=$(cat "$DATA/rfdb-http.port")
echo "==> rfdb-server listening on :$PORT"

mkdir -p /tmp/dai22-ply

echo "==> running playwright browser verify"
PORT="$PORT" OUT_DIR=/tmp/dai22-ply node "$PLY_SCRIPT"
RC=$?

echo
if [[ $RC -eq 0 ]]; then
  echo "=================================================="
  echo "DAI-22 Chunk-10b browser verify: ALL PASS"
  echo "=================================================="
else
  echo "=================================================="
  echo "DAI-22 Chunk-10b browser verify: FAIL (rc=$RC)"
  echo "rfdb log: /tmp/dai22-verify-browser-rfdb.log"
  echo "screenshots: /tmp/dai22-ply/"
  echo "=================================================="
fi
exit $RC

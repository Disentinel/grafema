#!/usr/bin/env bash
# run-round.sh — one migration round: restore → audit → act → record → snapshot → commit.
# git commit ONLY; push is NEVER performed (governance).
#
# usage: bash run-migration/run-round.sh <round-number, e.g. 002> [--seeds N]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RM="$ROOT/run-migration"
ROUND="${1:?round number required, e.g. 002}"
shift || true

cd "$ROOT"

echo "== restore + audit (sources are truth, snapshots are caches) =="
node --experimental-strip-types --no-warnings "$RM/ledger.ts" audit

echo "== act: conformance harness =="
node --experimental-strip-types packages/rofl-conformance/src/run.ts "$@"

echo "== record: round-$ROUND from conformance-report.json =="
node --experimental-strip-types packages/rofl-conformance/src/record-round.ts "$ROUND"

echo "== re-audit with the new round =="
node --experimental-strip-types --no-warnings "$RM/ledger.ts" audit

echo "== snapshot =="
node --experimental-strip-types --no-warnings "$RM/ledger.ts" snapshot "round-$ROUND"

echo "== commit (never push) =="
git add "$RM" _ai/research/rofl-conformance-report.md packages/rofl-conformance/conformance-report.json packages/rofl-conformance/conformance-run-meta.json
git commit -m "rofl-migration: round $ROUND"
echo "round $ROUND committed (NOT pushed)"

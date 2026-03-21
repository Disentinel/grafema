#!/usr/bin/env bash
# Run regression tests — covers REG-655, REG-656, REG-652.
# Usage:
#   ./scripts/test-regression.sh         # regressions only
#   ./scripts/test-regression.sh --all   # regressions + VSCode unit tests
#
# Log: /tmp/grafema-regression.log

set -uo pipefail

LOG="/tmp/grafema-regression.log"
RUN_VSCODE=false
[[ "${1:-}" == "--all" ]] && RUN_VSCODE=true

echo "Running regression tests..."
echo "Log: $LOG"
echo ""

if $RUN_VSCODE; then
  node --import tsx --test packages/mcp/test/regressions.test.ts \
       packages/vscode/test/unit/*.test.ts 2>&1 | tee "$LOG"
else
  node --import tsx --test packages/mcp/test/regressions.test.ts 2>&1 | tee "$LOG"
fi

EXIT_CODE=${PIPESTATUS[0]}
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

awk '
  /not ok/ && !/# TODO/ && !/subtestsFailed/ {
    name = $0; sub(/.*not ok [0-9]+ - /, "", name)
    in_block = 1; real = 0; err = ""; grab_err = 0; next
  }
  !in_block { next }
  /subtestsFailed/ { in_block = 0; next }
  /failureType:/ && !/subtestsFailed/ { real = 1 }
  /error: \|/ { grab_err = 1; next }
  /error: / && !grab_err { err = $0; sub(/.*error: /, "", err) }
  grab_err && /^[[:space:]]+[^[:space:]]/ && !/code:/ && !/stack:/ {
    if (!err) { err = $0; sub(/^[[:space:]]+/, "", err) }; next
  }
  /code:/ { grab_err = 0 }
  /\.\.\.$/ {
    if (real) { count++; printf "  FAIL: %s\n", name; if (err) printf "        %s\n", err; printf "\n" }
    in_block = 0
  }
  END {
    if (count > 0) printf "%d regression(s) broken\n", count
    else print "ALL REGRESSIONS PASS"
  }
' "$LOG"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Full log: $LOG"
exit $EXIT_CODE

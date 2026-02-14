#!/usr/bin/env bash
# Run unit tests with output saved to log file.
# Usage:
#   ./scripts/test.sh                    # all tests
#   ./scripts/test.sh <file.test.js>     # single file
#
# Log: /tmp/grafema-test.log
# After run: prints summary of failed tests.

set -uo pipefail

LOG="/tmp/grafema-test.log"

if [ $# -gt 0 ]; then
  TARGET="test/unit/$1"
else
  TARGET="test/unit/*.test.js"
fi

echo "Running tests: $TARGET"
echo "Log: $LOG"
echo ""

node --test --test-concurrency=1 $TARGET 2>&1 | tee "$LOG"
EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Parse TAP: find real test failures (any failureType except subtestsFailed, skip TODO)
awk '
  /not ok/ && !/# TODO/ && !/subtestsFailed/ {
    name = $0
    sub(/.*not ok [0-9]+ - /, "", name)
    in_block = 1; real = 0; loc = ""; err = ""; grab_err = 0
    next
  }
  !in_block { next }
  /subtestsFailed/ { in_block = 0; next }
  /failureType:/ && !/subtestsFailed/ { real = 1 }
  /location:/ {
    loc = $0; sub(/.*location: ./, "", loc); sub(/.$/, "", loc)
  }
  /error: \|/ { grab_err = 1; next }
  /error: / && !grab_err {
    err = $0; sub(/.*error: /, "", err)
    gsub(/^[\047]|[\047]$/, "", err)
  }
  grab_err && /^[[:space:]]+[^[:space:]]/ && !/code:/ && !/stack:/ {
    if (!err) { err = $0; sub(/^[[:space:]]+/, "", err) }
    next
  }
  /code:/ { grab_err = 0 }
  /\.\.\.$/ {
    if (real) {
      count++
      printf "  FAIL: %s\n", name
      if (err) printf "        %s\n", err
      if (loc) printf "        at %s\n", loc
      printf "\n"
    }
    in_block = 0
  }
  END {
    if (count > 0) printf "%d test(s) failed\n", count
    else print "ALL TESTS PASSED"
  }
' "$LOG"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Full log: $LOG"

exit $EXIT_CODE

#!/usr/bin/env bash
# Check for benchmark regressions in critcmp output.
#
# Usage: check-bench-regression.sh <critcmp-output-file> [threshold]
#
# The threshold is a multiplier (default 1.20 = 20% slower).
# A regression is detected when the "pr" baseline is slower than "main".
#
# critcmp output format:
#   group           main                                     pr
#   -----           ----                                     --
#   bench/size      RATIO  TIME±ERR  THROUGHPUT              RATIO  TIME±ERR  THROUGHPUT
#
# The baseline with ratio 1.00 is the fastest.
# If main=1.00 and pr>threshold, the PR introduced a regression.

set -euo pipefail

INPUT_FILE="${1:?Usage: $0 <critcmp-output-file> [threshold]}"
THRESHOLD="${2:-1.20}"

if [ ! -f "$INPUT_FILE" ]; then
  echo "Error: File not found: $INPUT_FILE"
  exit 1
fi

# Step 1: Determine column positions from header
# Header line looks like: "group           main                                     pr"
HEADER=$(head -1 "$INPUT_FILE")

# Find column positions by checking word order in header
# Column 1 is always "group" (benchmark name), remaining are baseline names
COLS=$(echo "$HEADER" | awk '{for(i=2;i<=NF;i++) printf "%d %s\n", i-1, $i}')
MAIN_COL=""
PR_COL=""

while IFS=' ' read -r idx name; do
  if [ "$name" = "main" ]; then
    MAIN_COL="$idx"
  elif [ "$name" = "pr" ]; then
    PR_COL="$idx"
  fi
done <<< "$COLS"

if [ -z "$MAIN_COL" ] || [ -z "$PR_COL" ]; then
  echo "Error: Could not find 'main' and 'pr' columns in header: $HEADER"
  exit 1
fi

echo "Columns: main=#${MAIN_COL}, pr=#${PR_COL} (threshold: ${THRESHOLD}x)"
echo ""

# Step 2: Parse each benchmark line
FAILED=false
CHECKED=0

while IFS= read -r line; do
  # Skip header, separator, empty lines
  case "$line" in group*|-----*|"") continue ;; esac

  # Must contain / (benchmark name format: group/size)
  BENCH=$(echo "$line" | awk '{print $1}')
  echo "$BENCH" | grep -q '/' || continue

  # Extract ratios: standalone decimals followed by a field containing ±
  # Returns them in column order (left to right)
  RATIOS=$(echo "$line" | awk '{
    count = 0
    for (i=2; i<=NF; i++) {
      if ($i ~ /^[0-9]+\.[0-9]+$/ && i < NF && $(i+1) ~ /±/) {
        count++
        printf "%s\n", $i
      }
    }
  }')

  RATIO_MAIN=$(echo "$RATIOS" | sed -n "${MAIN_COL}p")
  RATIO_PR=$(echo "$RATIOS" | sed -n "${PR_COL}p")

  if [ -z "$RATIO_MAIN" ] || [ -z "$RATIO_PR" ]; then
    continue
  fi

  CHECKED=$((CHECKED + 1))

  # Regression: main is fastest (1.00) and PR exceeds threshold
  IS_REGRESSION=$(awk "BEGIN {
    if ($RATIO_MAIN == 1.0 && $RATIO_PR > $THRESHOLD) print 1;
    else print 0
  }")

  if [ "$IS_REGRESSION" = "1" ]; then
    echo "REGRESSION: $BENCH — pr is ${RATIO_PR}x slower than main (threshold: ${THRESHOLD}x)"
    FAILED=true
  fi
done < "$INPUT_FILE"

echo ""
echo "Checked $CHECKED benchmarks."

if [ "$FAILED" = "true" ]; then
  echo "RESULT: FAILED — regressions detected"
  exit 1
else
  echo "RESULT: PASSED — no regressions above ${THRESHOLD}x"
  exit 0
fi

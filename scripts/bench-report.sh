#!/usr/bin/env bash
# Generate a markdown benchmark report from critcmp output.
#
# Usage: bench-report.sh <critcmp-output-file> [threshold]
#
# Produces a markdown table comparing "main" vs "pr" baselines,
# with per-benchmark change percentages and pass/fail status.
#
# Exit code: 0 = no regressions, 1 = regressions found

set -euo pipefail

export LC_NUMERIC=C

INPUT_FILE="${1:?Usage: $0 <critcmp-output-file> [threshold]}"
THRESHOLD="${2:-1.20}"

if [ ! -f "$INPUT_FILE" ]; then
  echo "## Benchmark Report"
  echo ""
  echo "No benchmark comparison data found."
  exit 0
fi

# Parse header to find column positions
HEADER=$(head -1 "$INPUT_FILE")
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
  echo "## Benchmark Report"
  echo ""
  echo "Could not parse benchmark comparison (missing main/pr columns)."
  exit 0
fi

# Collect benchmark data
improved=0
regressed=0
unchanged=0
has_regression=false

# Build table rows
TABLE_ROWS=""

while IFS= read -r line; do
  # Skip header, separator, empty lines
  case "$line" in group*|-----*|"") continue ;; esac

  BENCH=$(echo "$line" | awk '{print $1}')
  echo "$BENCH" | grep -q '/' || continue

  # Extract time values (fields with ± in them, like "123.45 ns")
  # critcmp format: bench  RATIO TIME±ERR THROUGHPUT  RATIO TIME±ERR THROUGHPUT
  RATIOS=$(echo "$line" | awk '{
    for (i=2; i<=NF; i++) {
      if ($i ~ /^[0-9]+\.[0-9]+$/ && i < NF && $(i+1) ~ /±/) {
        printf "%s\n", $i
      }
    }
  }')

  RATIO_MAIN=$(echo "$RATIOS" | sed -n "${MAIN_COL}p")
  RATIO_PR=$(echo "$RATIOS" | sed -n "${PR_COL}p")

  if [ -z "$RATIO_MAIN" ] || [ -z "$RATIO_PR" ]; then
    continue
  fi

  # Extract time strings for display
  TIMES=$(echo "$line" | awk '{
    for (i=2; i<=NF; i++) {
      if ($(i) ~ /±/) {
        # Previous field is the time value, this field has ±
        printf "%s\n", $(i)
      }
    }
  }')

  TIME_MAIN=$(echo "$TIMES" | sed -n "${MAIN_COL}p")
  TIME_PR=$(echo "$TIMES" | sed -n "${PR_COL}p")

  # Determine status based on ratios
  # If main=1.00, PR is slower by ratio. If pr=1.00, PR is faster.
  STATUS=""
  CHANGE=""

  if [ "$RATIO_MAIN" = "1.00" ] && [ "$RATIO_PR" = "1.00" ]; then
    STATUS="unchanged"
    CHANGE="same"
    unchanged=$((unchanged + 1))
  elif [ "$RATIO_MAIN" = "1.00" ]; then
    # PR is slower than main
    CHANGE=$(awk "BEGIN { printf \"+%.0f%%\", ($RATIO_PR - 1.0) * 100 }")
    IS_REG=$(awk "BEGIN { print ($RATIO_PR > $THRESHOLD) ? 1 : 0 }")
    if [ "$IS_REG" = "1" ]; then
      STATUS="regressed"
      regressed=$((regressed + 1))
      has_regression=true
    else
      STATUS="unchanged"
      unchanged=$((unchanged + 1))
    fi
  elif [ "$RATIO_PR" = "1.00" ]; then
    # PR is faster than main
    CHANGE=$(awk "BEGIN { printf \"-%.0f%%\", ($RATIO_MAIN - 1.0) * 100 }")
    STATUS="improved"
    improved=$((improved + 1))
  else
    # Both non-1.00, compare them
    CHANGE=$(awk "BEGIN {
      diff = ($RATIO_PR / $RATIO_MAIN - 1.0) * 100;
      if (diff > 0) printf \"+%.0f%%\", diff;
      else printf \"%.0f%%\", diff;
    }")
    STATUS="unchanged"
    unchanged=$((unchanged + 1))
  fi

  # Format status emoji
  case "$STATUS" in
    improved)  ICON=":green_circle:" ;;
    regressed) ICON=":red_circle:" ;;
    *)         ICON=":white_circle:" ;;
  esac

  TABLE_ROWS="${TABLE_ROWS}| \`${BENCH}\` | ${TIME_MAIN:-?} | ${TIME_PR:-?} | ${CHANGE} | ${ICON} |
"
done < "$INPUT_FILE"

# Count total
total=$((improved + regressed + unchanged))

# Output report
echo "## RFDB Benchmark Report"
echo ""

if [ "$total" -eq 0 ]; then
  echo "No benchmarks found in comparison output."
  exit 0
fi

# Summary
if [ "$has_regression" = "true" ]; then
  echo ":warning: **Performance regression detected** (threshold: $(awk "BEGIN { printf \"%.0f%%\", ($THRESHOLD - 1.0) * 100 }"))"
else
  echo ":white_check_mark: **No performance regressions** (threshold: $(awk "BEGIN { printf \"%.0f%%\", ($THRESHOLD - 1.0) * 100 }"))"
fi

echo ""
echo "**${total} benchmarks:** ${improved} improved, ${regressed} regressed, ${unchanged} unchanged"
echo ""

# Table
echo "| Benchmark | Main | PR | Change | Status |"
echo "|-----------|------|-----|--------|--------|"
echo -n "$TABLE_ROWS"

echo ""
echo "<details>"
echo "<summary>Raw critcmp output</summary>"
echo ""
echo '```'
cat "$INPUT_FILE"
echo '```'
echo "</details>"

if [ "$has_regression" = "true" ]; then
  exit 1
fi
exit 0

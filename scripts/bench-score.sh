#!/usr/bin/env bash
# Compute an integral benchmark score from Criterion JSON output.
#
# Usage: bench-score.sh [criterion-dir]
#
# Reads estimates.json files from Criterion's output directory,
# computes ops/sec for each benchmark, then returns the geometric
# mean as a single human-readable score (e.g., "1.23M ops/s").
#
# Requires: jq, awk

set -euo pipefail

export LC_NUMERIC=C

CRITERION_DIR="${1:-target/criterion}"

if [ ! -d "$CRITERION_DIR" ]; then
  echo "Error: Criterion output directory not found: $CRITERION_DIR" >&2
  exit 1
fi

# Collect all mean point estimates (nanoseconds) into a temp file
MEANS_FILE=$(mktemp)
trap 'rm -f "$MEANS_FILE"' EXIT

find "$CRITERION_DIR" -path "*/new/estimates.json" -type f 2>/dev/null | while IFS= read -r json_file; do
  mean_ns=$(jq -r '.mean.point_estimate // .point_estimate // empty' "$json_file" 2>/dev/null)
  if [ -n "$mean_ns" ]; then
    echo "$mean_ns"
  fi
done > "$MEANS_FILE"

count=$(wc -l < "$MEANS_FILE" | tr -d ' ')

if [ "$count" -eq 0 ]; then
  echo "N/A"
  exit 0
fi

# Compute geometric mean of ops/sec and format — all in one awk call
awk '
BEGIN { log_sum = 0; n = 0 }
{
  mean_ns = $1 + 0
  if (mean_ns > 0) {
    log_sum += log(1e9 / mean_ns)
    n++
  }
}
END {
  if (n == 0) { print "N/A"; exit }
  geo = exp(log_sum / n)
  if      (geo >= 1e9) printf "%.1fB ops/s\n", geo / 1e9
  else if (geo >= 1e6) printf "%.1fM ops/s\n", geo / 1e6
  else if (geo >= 1e3) printf "%.1fK ops/s\n", geo / 1e3
  else                 printf "%.0f ops/s\n", geo
}
' "$MEANS_FILE"

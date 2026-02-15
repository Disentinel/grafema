#!/usr/bin/env bash
# Generate a v1 vs v2 engine comparison report from Criterion output.
#
# Usage: bench-v1-v2-report.sh [criterion-dir]
#
# Reads estimates.json files from v1/* and v2/* benchmark groups,
# computes ops/sec for each operation, generates:
# 1. Per-operation comparison table (markdown)
# 2. Integral OPS/sec score per engine (geometric mean)
#
# Requires: jq, awk

set -euo pipefail

export LC_NUMERIC=C

CRITERION_DIR="${1:-packages/rfdb-server/target/criterion}"

if [ ! -d "$CRITERION_DIR" ]; then
  echo "## v1 vs v2 Benchmark Report"
  echo ""
  echo "No benchmark data found at: $CRITERION_DIR"
  echo "Run: \`cd packages/rfdb-server && cargo bench --bench v1_v2_comparison\`"
  exit 0
fi

# Collect benchmark results into temp files
V1_FILE=$(mktemp)
V2_FILE=$(mktemp)
PAIRS_FILE=$(mktemp)
trap 'rm -f "$V1_FILE" "$V2_FILE" "$PAIRS_FILE"' EXIT

# Find all v1/* and v2/* benchmark estimates
find "$CRITERION_DIR" -path "*/v1/*/new/estimates.json" -type f 2>/dev/null | while IFS= read -r json_file; do
  # Extract operation and size from path: .../v1/add_nodes/1000/new/estimates.json
  rel_path="${json_file#"$CRITERION_DIR"/}"
  op=$(echo "$rel_path" | cut -d'/' -f2)
  size=$(echo "$rel_path" | cut -d'/' -f3)
  mean_ns=$(jq -r '.mean.point_estimate // .point_estimate // empty' "$json_file" 2>/dev/null)
  if [ -n "$mean_ns" ]; then
    echo "${op}/${size} ${mean_ns}"
  fi
done > "$V1_FILE"

find "$CRITERION_DIR" -path "*/v2/*/new/estimates.json" -type f 2>/dev/null | while IFS= read -r json_file; do
  rel_path="${json_file#"$CRITERION_DIR"/}"
  op=$(echo "$rel_path" | cut -d'/' -f2)
  size=$(echo "$rel_path" | cut -d'/' -f3)
  mean_ns=$(jq -r '.mean.point_estimate // .point_estimate // empty' "$json_file" 2>/dev/null)
  if [ -n "$mean_ns" ]; then
    echo "${op}/${size} ${mean_ns}"
  fi
done > "$V2_FILE"

v1_count=$(wc -l < "$V1_FILE" | tr -d ' ')
v2_count=$(wc -l < "$V2_FILE" | tr -d ' ')

if [ "$v1_count" -eq 0 ] || [ "$v2_count" -eq 0 ]; then
  echo "## v1 vs v2 Benchmark Report"
  echo ""
  echo "Incomplete data: ${v1_count} v1 benchmarks, ${v2_count} v2 benchmarks."
  exit 0
fi

# Build paired comparison
# Join v1 and v2 by operation/size key
while IFS=' ' read -r key v1_ns; do
  v2_ns=$(awk -v k="$key" '$1 == k {print $2}' "$V2_FILE")
  if [ -n "$v2_ns" ]; then
    echo "$key $v1_ns $v2_ns"
  fi
done < "$V1_FILE" > "$PAIRS_FILE"

pair_count=$(wc -l < "$PAIRS_FILE" | tr -d ' ')

# Generate report
echo "## v1 vs v2 Engine Benchmark Report"
echo ""

# Integral scores (geometric mean ops/sec per engine)
v1_score=$(awk '
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
  if      (geo >= 1e9) printf "%.1fB ops/s", geo / 1e9
  else if (geo >= 1e6) printf "%.1fM ops/s", geo / 1e6
  else if (geo >= 1e3) printf "%.1fK ops/s", geo / 1e3
  else                 printf "%.0f ops/s", geo
}
' <(awk '{print $2}' "$V1_FILE"))

v2_score=$(awk '
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
  if      (geo >= 1e9) printf "%.1fB ops/s", geo / 1e9
  else if (geo >= 1e6) printf "%.1fM ops/s", geo / 1e6
  else if (geo >= 1e3) printf "%.1fK ops/s", geo / 1e3
  else                 printf "%.0f ops/s", geo
}
' <(awk '{print $2}' "$V2_FILE"))

echo "### Integral Performance"
echo ""
echo "| Engine | Score |"
echo "|--------|-------|"
echo "| **v1** (GraphEngine) | ${v1_score} |"
echo "| **v2** (GraphEngineV2) | ${v2_score} |"
echo ""

# Per-operation table
echo "### Per-Operation Comparison"
echo ""
echo "| Operation | v1 | v2 | Ratio (v2/v1) | Status |"
echo "|-----------|------|------|---------------|--------|"

improved=0
regressed=0
unchanged=0

while IFS=' ' read -r key v1_ns v2_ns; do
  v1_formatted=$(awk -v ns="$v1_ns" 'BEGIN {
    if (ns >= 1e9) printf "%.2fs", ns / 1e9
    else if (ns >= 1e6) printf "%.2fms", ns / 1e6
    else if (ns >= 1e3) printf "%.2fus", ns / 1e3
    else printf "%.0fns", ns
  }')

  v2_formatted=$(awk -v ns="$v2_ns" 'BEGIN {
    if (ns >= 1e9) printf "%.2fs", ns / 1e9
    else if (ns >= 1e6) printf "%.2fms", ns / 1e6
    else if (ns >= 1e3) printf "%.2fus", ns / 1e3
    else printf "%.0fns", ns
  }')

  ratio=$(awk -v v1="$v1_ns" -v v2="$v2_ns" 'BEGIN {
    if (v1 > 0) printf "%.2f", v2 / v1
    else print "N/A"
  }')

  status=""
  ratio_num=$(awk -v v1="$v1_ns" -v v2="$v2_ns" 'BEGIN { if (v1 > 0) print v2/v1; else print 1 }')

  if awk -v r="$ratio_num" 'BEGIN { exit (r > 1.20) ? 0 : 1 }'; then
    status=":red_circle: slower"
    regressed=$((regressed + 1))
  elif awk -v r="$ratio_num" 'BEGIN { exit (r < 0.80) ? 0 : 1 }'; then
    status=":green_circle: faster"
    improved=$((improved + 1))
  else
    status=":white_circle: ~same"
    unchanged=$((unchanged + 1))
  fi

  echo "| \`${key}\` | ${v1_formatted} | ${v2_formatted} | ${ratio}x | ${status} |"
done < "$PAIRS_FILE"

total=$((improved + regressed + unchanged))

echo ""
echo "**${total} operations:** ${improved} faster, ${regressed} slower, ${unchanged} comparable"
echo ""
echo "_Both engines accessed via GraphStore trait. v2 includes adapter layer overhead._"
echo "_Threshold: >20% = slower (red), <80% = faster (green)._"

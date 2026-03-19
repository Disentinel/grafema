#!/usr/bin/env bash
#
# Compare SWE-bench results between baseline and grafema conditions.
#
# Usage:
#   ./scripts/swe-bench/compare.sh [results-dir]
#
# Default results-dir: scripts/swe-bench/results/
#
# Reads from:
#   <results-dir>/baseline/<task_id>/
#   <results-dir>/grafema/<task_id>/
#
# Outputs a markdown table comparing metrics.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="${1:-$SCRIPT_DIR/results}"

BASELINE_DIR="$RESULTS_DIR/baseline"
GRAFEMA_DIR="$RESULTS_DIR/grafema"

if [[ ! -d "$BASELINE_DIR" && ! -d "$GRAFEMA_DIR" ]]; then
  echo "Error: no results found in $RESULTS_DIR" >&2
  echo "Expected: $RESULTS_DIR/baseline/ and/or $RESULTS_DIR/grafema/" >&2
  exit 1
fi

# Collect all task IDs from both conditions
ALL_TASKS=()
if [[ -d "$BASELINE_DIR" ]]; then
  for d in "$BASELINE_DIR"/*/; do
    [[ -d "$d" ]] && ALL_TASKS+=("$(basename "$d")")
  done
fi
if [[ -d "$GRAFEMA_DIR" ]]; then
  for d in "$GRAFEMA_DIR"/*/; do
    task=$(basename "$d")
    # Add only if not already in list
    if [[ ! " ${ALL_TASKS[*]:-} " =~ " $task " ]]; then
      ALL_TASKS+=("$task")
    fi
  done
fi

# Sort tasks
IFS=$'\n' SORTED_TASKS=($(sort <<<"${ALL_TASKS[*]}")); unset IFS

# --- Helper functions ---

get_patch_lines() {
  local dir="$1"
  if [[ -f "$dir/patch.diff" ]]; then
    wc -l < "$dir/patch.diff" | tr -d ' '
  else
    echo "-"
  fi
}

get_tokens() {
  local dir="$1"
  local field="$2"
  if [[ -f "$dir/result.json" ]]; then
    jq -r ".usage.${field} // .result.${field} // \"-\"" "$dir/result.json" 2>/dev/null || echo "-"
  else
    echo "-"
  fi
}

get_tool_count() {
  local dir="$1"
  if [[ -f "$dir/result.json" ]]; then
    jq '[.. | .tool_name? // empty] | length' "$dir/result.json" 2>/dev/null || echo "-"
  else
    echo "-"
  fi
}

get_cost() {
  local dir="$1"
  if [[ -f "$dir/result.json" ]]; then
    jq -r '.total_cost_usd // "-"' "$dir/result.json" 2>/dev/null || echo "-"
  else
    echo "-"
  fi
}

get_turns() {
  local dir="$1"
  if [[ -f "$dir/result.json" ]]; then
    jq -r '.num_turns // "-"' "$dir/result.json" 2>/dev/null || echo "-"
  else
    echo "-"
  fi
}

has_grafema_usage() {
  local dir="$1"
  if [[ -f "$dir/session.jsonl" ]]; then
    python3 -c "
import json
count = 0
for line in open('$dir/session.jsonl'):
    try: ev = json.loads(line)
    except: continue
    if ev.get('type') == 'assistant':
        for b in ev.get('message',{}).get('content',[]):
            if b.get('type') == 'tool_use' and b.get('name','').startswith('mcp__grafema'):
                count += 1
print(count)
" 2>/dev/null || echo "-"
  else
    echo "-"
  fi
}

check_resolved() {
  local preds_file="$1"
  local task_id="$2"
  # Check if task appears in swebench eval results
  # This is a placeholder — actual check depends on eval output format
  echo "?"
}

# --- Output table ---

echo "# SWE-bench Comparison: Baseline vs Grafema"
echo ""
echo "Results: $RESULTS_DIR"
echo "Date: $(date +%Y-%m-%d)"
echo ""
echo "| Task | B.Cost | G.Cost | B.Turns | G.Turns | G.Grafema | B.Patch | G.Patch |"
echo "|------|--------|--------|---------|---------|-----------|---------|---------|"

TASK_COUNT=0

for TASK_ID in "${SORTED_TASKS[@]}"; do
  B_DIR="$BASELINE_DIR/$TASK_ID"
  G_DIR="$GRAFEMA_DIR/$TASK_ID"

  B_COST=$(get_cost "$B_DIR")
  G_COST=$(get_cost "$G_DIR")
  B_TURNS=$(get_turns "$B_DIR")
  G_TURNS=$(get_turns "$G_DIR")
  G_GRAFEMA=$(has_grafema_usage "$G_DIR")

  B_PATCH=$(get_patch_lines "$B_DIR")
  G_PATCH=$(get_patch_lines "$G_DIR")

  # Format cost
  B_COST_FMT=$(python3 -c "print(f'\${float(\"${B_COST}\"):.2f}')" 2>/dev/null || echo "-")
  G_COST_FMT=$(python3 -c "print(f'\${float(\"${G_COST}\"):.2f}')" 2>/dev/null || echo "-")

  TASK_COUNT=$((TASK_COUNT + 1))

  echo "| $TASK_ID | $B_COST_FMT | $G_COST_FMT | $B_TURNS | $G_TURNS | $G_GRAFEMA | $B_PATCH | $G_PATCH |"
done

# --- Totals ---
echo ""
echo "## Summary ($TASK_COUNT tasks)"

echo ""
echo "---"
echo ""
echo "Legend:"
echo "- B = Baseline, G = Grafema"
echo "- G.Grafema = number of Grafema MCP tool calls"
echo "- Patch = lines in git diff"
echo "- Delta = total token difference (negative = Grafema cheaper)"

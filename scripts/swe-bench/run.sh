#!/usr/bin/env bash
#
# SWE-bench pipeline using Claude Code (`claude -p`) inside Docker containers.
#
# Usage:
#   ./scripts/swe-bench/run.sh <task_id> [--mode baseline|grafema] [--results-dir ./results]
#
# Requirements:
#   - Docker running
#   - tasks.json generated (see generate-tasks.py)
#   - ~/.claude/ directory with valid auth
#   - SWE-bench Docker images pulled (sweb.eval.x86_64.<repo>:<instance_id>)
#
# Examples:
#   ./scripts/swe-bench/run.sh axios__axios-4731
#   ./scripts/swe-bench/run.sh axios__axios-4731 --mode grafema
#   ./scripts/swe-bench/run.sh axios__axios-4731 --mode baseline --results-dir ./my-results
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASKS_FILE="$SCRIPT_DIR/tasks.json"
TEMPLATES_DIR="$SCRIPT_DIR/templates"

# --- Defaults ---
MODE="baseline"
RESULTS_DIR="$SCRIPT_DIR/results"
MODEL="claude-sonnet-4-6-20250514"

# --- Parse args ---
TASK_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="$2"
      shift 2
      ;;
    --results-dir)
      RESULTS_DIR="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --help|-h)
      head -20 "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      if [[ -z "$TASK_ID" ]]; then
        TASK_ID="$1"
      else
        echo "Error: unexpected argument '$1'" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$TASK_ID" ]]; then
  echo "Error: task_id required" >&2
  echo "Usage: $0 <task_id> [--mode baseline|grafema] [--results-dir ./results]" >&2
  exit 1
fi

if [[ "$MODE" != "baseline" && "$MODE" != "grafema" ]]; then
  echo "Error: --mode must be 'baseline' or 'grafema'" >&2
  exit 1
fi

# --- Read task from tasks.json ---
if [[ ! -f "$TASKS_FILE" ]]; then
  echo "Error: $TASKS_FILE not found. Run generate-tasks.py first." >&2
  exit 1
fi

TASK_JSON=$(jq -r --arg id "$TASK_ID" '.[] | select(.instance_id == $id)' "$TASKS_FILE")
if [[ -z "$TASK_JSON" || "$TASK_JSON" == "null" ]]; then
  echo "Error: task '$TASK_ID' not found in $TASKS_FILE" >&2
  exit 1
fi

REPO=$(echo "$TASK_JSON" | jq -r '.repo')
BASE_COMMIT=$(echo "$TASK_JSON" | jq -r '.base_commit')
PROBLEM_STATEMENT=$(echo "$TASK_JSON" | jq -r '.problem_statement')

echo "=== SWE-bench Pipeline ==="
echo "Task:   $TASK_ID"
echo "Repo:   $REPO"
echo "Commit: ${BASE_COMMIT:0:12}"
echo "Mode:   $MODE"
echo "Model:  $MODEL"
echo ""

# --- Find Docker image ---
# SWE-bench image naming convention
REPO_SLUG=$(echo "$REPO" | tr '/' '__' | tr '[:upper:]' '[:lower:]')
# Try common naming patterns
IMAGE=""
for candidate in \
  "sweb.eval.x86_64.${REPO_SLUG}:${TASK_ID}" \
  "swebench/sweb.eval.x86_64.${REPO_SLUG}:${TASK_ID}" \
  "ghcr.io/swebench/sweb.eval.x86_64.${REPO_SLUG}:${TASK_ID}"; do
  if docker image inspect "$candidate" &>/dev/null; then
    IMAGE="$candidate"
    break
  fi
done

if [[ -z "$IMAGE" ]]; then
  echo "Docker image not found locally. Trying to pull..."
  PULL_IMAGE="sweb.eval.x86_64.${REPO_SLUG}:${TASK_ID}"
  if docker pull "$PULL_IMAGE" 2>/dev/null; then
    IMAGE="$PULL_IMAGE"
  else
    echo "Error: Could not find Docker image for $TASK_ID" >&2
    echo "Expected image name pattern: sweb.eval.x86_64.${REPO_SLUG}:${TASK_ID}" >&2
    echo "" >&2
    echo "Build it with swebench:" >&2
    echo "  python -m swebench.harness.prepare_images --dataset_name swe-bench/SWE-Bench_Multilingual --instance_ids $TASK_ID" >&2
    exit 1
  fi
fi

echo "Image:  $IMAGE"

# --- Setup results directory ---
TASK_RESULTS="$RESULTS_DIR/$MODE/$TASK_ID"
mkdir -p "$TASK_RESULTS"

# --- Container name ---
CONTAINER="swe-${MODE}-${TASK_ID}"

# Cleanup any leftover container
docker rm -f "$CONTAINER" &>/dev/null || true

# --- Start timer ---
START_TIME=$(date +%s)

# --- Start container ---
echo ""
echo "--- Starting container ---"
docker run -d --name "$CONTAINER" \
  -v "$HOME/.claude:/root/.claude:ro" \
  "$IMAGE" sleep 2h >/dev/null

echo "Container: $CONTAINER"

# --- Check Node version ---
NODE_VERSION=$(docker exec "$CONTAINER" node --version 2>/dev/null || echo "unknown")
echo "Node:   $NODE_VERSION"

# Skip Node 16 containers — Claude Code and Grafema require Node 18+
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo ""
  echo "SKIPPED: Node $NODE_VERSION is too old (need 18+). Cleaning up."
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  docker rm "$CONTAINER" >/dev/null 2>&1 || true
  exit 0
fi

# --- Install Claude Code ---
echo ""
echo "--- Installing Claude Code ---"
docker exec "$CONTAINER" bash -c '
  npm install -g @anthropic-ai/claude-code 2>&1 | tail -1
' || {
  echo "Error: Failed to install Claude Code" >&2
  docker stop "$CONTAINER" >/dev/null && docker rm "$CONTAINER" >/dev/null
  exit 1
}

# --- Grafema setup (if grafema mode) ---
if [[ "$MODE" == "grafema" ]]; then
  echo ""
  echo "--- Installing Grafema ---"
  docker exec "$CONTAINER" bash -c '
    npm install -g grafema 2>&1 | tail -1 &&
    cd /testbed &&
    grafema init &&
    grafema analyze --auto-start 2>&1 | tail -5 &&
    echo "" &&
    echo "Setting up MCP config..." &&
    cat > /testbed/.mcp.json << MCPEOF
{
  "mcpServers": {
    "grafema": {
      "command": "grafema-mcp",
      "args": ["--project", "/testbed"]
    }
  }
}
MCPEOF
    echo "Grafema ready"
  ' || {
    echo "Warning: Grafema setup failed, continuing without it" >&2
  }

  # Start rfdb-server for MCP tools
  echo ""
  echo "--- Starting rfdb-server ---"
  docker exec "$CONTAINER" bash -c '
    if [ -d /testbed/.grafema ]; then
      setsid rfdb-server /testbed/.grafema/graph.rfdb \
        --socket /testbed/.grafema/rfdb.sock </dev/null >/dev/null 2>&1 & disown
      sleep 2
      echo "rfdb-server started"
    else
      echo "No .grafema directory, skipping rfdb-server"
    fi
  ' || true
fi

# --- Generate prompt ---
echo ""
echo "--- Generating prompt ---"

if [[ "$MODE" == "grafema" ]]; then
  TEMPLATE="$TEMPLATES_DIR/prompt-grafema.md"
else
  TEMPLATE="$TEMPLATES_DIR/prompt-baseline.md"
fi

PROMPT=$(sed "s|{{problem_statement}}|$PROBLEM_STATEMENT|" "$TEMPLATE")

# Write prompt to a file inside the container (avoids shell escaping issues)
docker exec "$CONTAINER" bash -c "cat > /tmp/prompt.txt" <<< "$PROMPT"

# --- Run Claude Code agent ---
echo ""
echo "--- Running Claude Code agent ($MODE) ---"
echo "This may take several minutes..."

docker exec -w /testbed -e CLAUDE_MODEL="$MODEL" "$CONTAINER" bash -c '
  claude -p "$(cat /tmp/prompt.txt)" \
    --output-format json \
    --max-turns 75 \
    --model "$CLAUDE_MODEL" \
    --verbose \
    > /tmp/result.json 2>/tmp/claude-stderr.log
  EXIT_CODE=$?
  echo "Agent exit code: $EXIT_CODE"
  exit $EXIT_CODE
' || true

# --- Capture results ---
echo ""
echo "--- Capturing results ---"

# Patch (git diff)
docker exec -w /testbed "$CONTAINER" git diff > "$TASK_RESULTS/patch.diff" 2>/dev/null || true

# Agent output JSON
docker cp "$CONTAINER:/tmp/result.json" "$TASK_RESULTS/result.json" 2>/dev/null || true

# Agent stderr log
docker cp "$CONTAINER:/tmp/claude-stderr.log" "$TASK_RESULTS/claude-stderr.log" 2>/dev/null || true

# --- Create swebench prediction ---
PATCH_CONTENT=$(cat "$TASK_RESULTS/patch.diff" 2>/dev/null || echo "")
if [[ -n "$PATCH_CONTENT" ]]; then
  jq -n \
    --arg id "$TASK_ID" \
    --arg patch "$PATCH_CONTENT" \
    --arg model "claude-code-$MODE" \
    '{instance_id: $id, model_patch: $patch, model_name_or_path: $model}' \
    >> "$RESULTS_DIR/$MODE/preds.jsonl"
  echo "Prediction written to $RESULTS_DIR/$MODE/preds.jsonl"
else
  echo "Warning: empty patch"
fi

# --- Timer ---
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
ELAPSED_MIN=$((ELAPSED / 60))
ELAPSED_SEC=$((ELAPSED % 60))

# --- Extract metrics from result.json ---
echo ""
echo "--- Results Summary ---"
echo "Task:     $TASK_ID"
echo "Mode:     $MODE"
echo "Time:     ${ELAPSED_MIN}m ${ELAPSED_SEC}s"

PATCH_LINES=$(wc -l < "$TASK_RESULTS/patch.diff" 2>/dev/null || echo "0")
echo "Patch:    $PATCH_LINES lines"

if [[ -f "$TASK_RESULTS/result.json" ]]; then
  # Try to extract token counts from Claude's JSON output
  INPUT_TOKENS=$(jq -r '.usage.input_tokens // .result.input_tokens // "N/A"' "$TASK_RESULTS/result.json" 2>/dev/null || echo "N/A")
  OUTPUT_TOKENS=$(jq -r '.usage.output_tokens // .result.output_tokens // "N/A"' "$TASK_RESULTS/result.json" 2>/dev/null || echo "N/A")
  echo "Tokens:   in=$INPUT_TOKENS out=$OUTPUT_TOKENS"

  # Count tool calls if available
  TOOL_CALLS=$(jq '[.. | .tool_name? // empty] | length' "$TASK_RESULTS/result.json" 2>/dev/null || echo "N/A")
  echo "Tools:    $TOOL_CALLS calls"
fi

echo "Results:  $TASK_RESULTS/"

# --- Cleanup ---
echo ""
echo "--- Cleanup ---"
docker stop "$CONTAINER" >/dev/null 2>&1 || true
docker rm "$CONTAINER" >/dev/null 2>&1 || true
echo "Container removed"

echo ""
echo "=== Done ==="

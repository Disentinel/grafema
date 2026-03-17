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
#   - Auth: CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API billing)
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

# Load .env if present (won't override existing env vars)
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    value="${value%\"}" && value="${value#\"}"
    [[ -z "${!key:-}" && -n "$value" ]] && export "$key=$value"
  done < "$SCRIPT_DIR/.env"
fi

# --- Defaults ---
MODE="baseline"
RESULTS_DIR="$SCRIPT_DIR/results"
MODEL="sonnet"

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

# --- Check auth ---
# Subscription (Max/Pro): CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`
# API key: ANTHROPIC_API_KEY (separate billing from subscription!)
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Error: auth required. Set one of:" >&2
  echo "  CLAUDE_CODE_OAUTH_TOKEN  — subscription token (run 'claude setup-token' on host)" >&2
  echo "  ANTHROPIC_API_KEY        — API key (separate billing!)" >&2
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
REPO_SLUG=$(echo "$REPO" | sed 's|/|__|g' | tr '[:upper:]' '[:lower:]')
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
# Pass whichever auth env var is set
AUTH_ARGS=()
[[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] && AUTH_ARGS+=(-e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
[[ -n "${ANTHROPIC_API_KEY:-}" ]] && AUTH_ARGS+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")

docker run -d --name "$CONTAINER" \
  "${AUTH_ARGS[@]}" \
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
    # Save pristine state for clean diff later
    cd /testbed && git stash 2>/dev/null || true &&
    npm install -g grafema 2>&1 | tail -1 &&
    grafema init &&
    grafema analyze 2>&1 | tail -5 &&
    # Revert grafema init side-effects (.gitignore, .mcp.json, .claude/)
    git checkout -- .gitignore 2>/dev/null || true &&
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

# Build prompt: replace {{problem_statement}} with actual problem text
# Use Python to avoid shell escaping issues with special characters
PROMPT=$(python3 -c "
import sys
template = open('$TEMPLATE').read()
problem = sys.stdin.read()
print(template.replace('{{problem_statement}}', problem))
" <<< "$PROBLEM_STATEMENT")

# Write prompt to a file inside the container (avoids shell escaping issues)
echo "$PROMPT" | docker exec -i "$CONTAINER" bash -c "cat > /tmp/prompt.txt && chmod 644 /tmp/prompt.txt"

# --- Run Claude Code agent ---
echo ""
echo "--- Running Claude Code agent ($MODE) ---"
echo "This may take several minutes..."

# Create non-root user (--dangerously-skip-permissions requires non-root)
docker exec "$CONTAINER" bash -c '
  useradd -m -s /bin/bash solver 2>/dev/null || true
  cp -r /root/.npm /home/solver/.npm 2>/dev/null || true
  chown -R solver:solver /testbed /home/solver 2>/dev/null || true
' || true

docker exec -u solver -w /testbed -e CLAUDE_MODEL="$MODEL" \
  ${CLAUDE_CODE_OAUTH_TOKEN:+-e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"} \
  ${ANTHROPIC_API_KEY:+-e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"} \
  "$CONTAINER" bash -c '
  # stream-json gives per-turn JSONL (full session trace); requires --verbose
  claude -p "$(cat /tmp/prompt.txt)" \
    --output-format stream-json \
    --verbose \
    --max-turns 75 \
    --model "$CLAUDE_MODEL" \
    --dangerously-skip-permissions \
    > /tmp/session.jsonl 2>/tmp/claude-stderr.log
  EXIT_CODE=$?
  # Extract final result line (type=result) for summary
  grep "\"type\":\"result\"" /tmp/session.jsonl | tail -1 > /tmp/result.json 2>/dev/null
  echo "Agent exit code: $EXIT_CODE"
  exit $EXIT_CODE
' || true

# --- Capture results ---
echo ""
echo "--- Capturing results ---"

# Patch (git diff, excluding grafema artifacts)
docker exec -u solver -w /testbed "$CONTAINER" \
  git diff -- . ':!.grafema' ':!.mcp.json' ':!.claude' > "$TASK_RESULTS/patch.diff" 2>/dev/null || true

# Session JSONL (full turn-by-turn trace)
docker cp "$CONTAINER:/tmp/session.jsonl" "$TASK_RESULTS/session.jsonl" 2>/dev/null || true

# Agent result JSON (last line of session = summary)
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
  COST=$(jq -r '.total_cost_usd // "N/A"' "$TASK_RESULTS/result.json" 2>/dev/null || echo "N/A")
  TURNS=$(jq -r '.num_turns // "N/A"' "$TASK_RESULTS/result.json" 2>/dev/null || echo "N/A")
  echo "Cost:     \$$COST"
  echo "Turns:    $TURNS"
fi

# Count tokens and tool calls from session JSONL
if [[ -f "$TASK_RESULTS/session.jsonl" ]]; then
  python3 -c "
import json, sys
in_tok = out_tok = 0
tools = {}
for line in open('$TASK_RESULTS/session.jsonl'):
    try:
        ev = json.loads(line)
    except: continue
    # Count tokens from usage in result message
    u = ev.get('usage', {})
    in_tok += u.get('input_tokens', 0) + u.get('cache_read_input_tokens', 0)
    out_tok += u.get('output_tokens', 0)
    # Count tool calls
    if ev.get('type') == 'tool_use':
        name = ev.get('tool', {}).get('name', ev.get('name', 'unknown'))
        tools[name] = tools.get(name, 0) + 1
print(f'Tokens:   in={in_tok} out={out_tok} total={in_tok+out_tok}')
if tools:
    print(f'Tools:    {sum(tools.values())} calls')
    for name, count in sorted(tools.items(), key=lambda x: -x[1]):
        print(f'  {name}: {count}')
else:
    print('Tools:    0 calls')
print(f'Session:  {sum(1 for _ in open(\"$TASK_RESULTS/session.jsonl\"))} events')
" 2>/dev/null || echo "  (could not parse session.jsonl)"
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

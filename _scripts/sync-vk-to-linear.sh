#!/usr/bin/env bash
# Sync completed vibe-kanban tasks back to Linear
# Usage: ./_scripts/sync-vk-to-linear.sh [--dry-run]
#
# Finds tasks with status "done" in vibe-kanban that have REG-XXX in title,
# and prints Linear issue identifiers for manual or automated closing.
#
# Requires: curl, python3, vibe-kanban backend running

set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# Get vibe-kanban port
PORT_FILE="/var/folders/k9/dst30b8n5rs6x6nny6__7s6w0000gn/T/vibe-kanban/vibe-kanban.port"
if [[ ! -f "$PORT_FILE" ]]; then
  # Try common temp location pattern
  PORT_FILE=$(find /var/folders -name "vibe-kanban.port" 2>/dev/null | head -1)
  if [[ -z "$PORT_FILE" ]]; then
    echo "ERROR: vibe-kanban not running (port file not found)"
    exit 1
  fi
fi

VK_PORT=$(cat "$PORT_FILE")
VK_URL="http://127.0.0.1:${VK_PORT}"

# Verify backend is running
if ! curl -s "${VK_URL}/api/projects" > /dev/null 2>&1; then
  echo "ERROR: vibe-kanban backend not responding on port ${VK_PORT}"
  exit 1
fi

# Get project ID
PROJECT_ID=$(curl -s "${VK_URL}/api/projects" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data['data']:
    if p['name'] == 'grafema':
        print(p['id'])
        break
")

if [[ -z "$PROJECT_ID" ]]; then
  echo "ERROR: grafema project not found in vibe-kanban"
  exit 1
fi

# Get completed tasks
echo "Fetching completed tasks from vibe-kanban..."
COMPLETED=$(curl -s "${VK_URL}/api/tasks?project_id=${PROJECT_ID}" | python3 -c "
import json, sys, re
data = json.load(sys.stdin)
for task in data['data']:
    if task['status'] == 'done':
        match = re.search(r'(REG-\d+)', task['title'])
        if match:
            print(f\"{match.group(1)}\t{task['title']}\")
        else:
            print(f'NO-ID\t{task[\"title\"]}')
")

if [[ -z "$COMPLETED" ]]; then
  echo "No completed tasks found."
  exit 0
fi

echo ""
echo "Completed tasks to sync to Linear:"
echo "------------------------------------"
echo "$COMPLETED"
echo "------------------------------------"
echo ""

if [[ "$DRY_RUN" == true ]]; then
  echo "[DRY RUN] Would mark the above as Done in Linear."
  echo "Run without --dry-run to execute."
  exit 0
fi

echo "These tasks will be marked as 'Done' in Linear."
read -p "Continue? [y/N] " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Note: This script prints the identifiers. Actual Linear update
# should be done via Claude Code MCP tools or Linear API.
echo ""
echo "Linear issue identifiers to close:"
echo "$COMPLETED" | while IFS=$'\t' read -r id title; do
  if [[ "$id" != "NO-ID" ]]; then
    echo "  - $id ($title)"
  fi
done
echo ""
echo "Use Claude Code to update Linear statuses:"
echo '  Ask: "Mark REG-XXX, REG-YYY as Done in Linear"'

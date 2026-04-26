#!/bin/bash
# Run autoresearch experiments on remote VM.
# Usage: ./run-remote.sh [baseline|grafema|both] [question-id]
#
# Prerequisites on remote:
# - rfdb-server running with VS Code graph at /home/dev/vscode/.grafema/rfdb.sock
# - claude CLI installed and authenticated
# - Node.js + pnpm
# - /home/dev/vscode/autoresearch/ set up (prompts, questions, harness)
# - /home/dev/vscode/.mcp.json configured for grafema mode

MODE=${1:-both}
QID=${2:-}

REMOTE="root@204.168.176.164"
REMOTE_USER="dev"
PROJECT="/home/dev/vscode"
HARNESS="node /home/dev/grafema/autoresearch/harness/run.mjs"
QUESTIONS="${PROJECT}/autoresearch/questions.yaml"

run_mode() {
  local mode=$1
  local extra_args=""
  [ -n "$QID" ] && extra_args="--question-id $QID"

  echo "=== Running $mode mode ==="
  ssh $REMOTE "su - $REMOTE_USER bash -c '
    export CLAUDE_CODE_OAUTH_TOKEN=\$(cat ~/.claude/.credentials.json 2>/dev/null | node -e \"process.stdin.on(\\\"data\\\",d=>console.log(JSON.parse(d).oauthToken))\" 2>/dev/null || echo \"\")
    cd $PROJECT
    $HARNESS \
      --mode $mode \
      --model sonnet \
      --questions $QUESTIONS \
      --project-root $PROJECT \
      $extra_args \
      2>&1
  '"
}

case $MODE in
  baseline)
    run_mode baseline
    ;;
  grafema)
    run_mode grafema
    ;;
  both)
    run_mode baseline
    echo ""
    echo "=== Switching to grafema mode ==="
    echo ""
    run_mode grafema
    ;;
  *)
    echo "Usage: $0 [baseline|grafema|both] [question-id]"
    exit 1
    ;;
esac

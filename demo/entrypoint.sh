#!/usr/bin/env bash
set -euo pipefail

VSIX_PATH="/tmp/grafema-explore.vsix"
DB_PATH="/home/coder/workspace/grafema/.grafema/graph.rfdb"
SOCKET_PATH="/tmp/rfdb.sock"
WS_PORT=7432
HEALTH_TIMEOUT=30

# Install extension as coder user (code-server needs HOME=/home/coder)
echo "[grafema-demo] Installing Grafema VS Code extension..."
su -s /bin/bash coder -c "code-server --install-extension $VSIX_PATH" 2>&1 || {
    echo "[grafema-demo] WARNING: Extension install failed, continuing anyway"
}

echo "[grafema-demo] Starting rfdb-server..."
echo "[grafema-demo]   Database: $DB_PATH"
echo "[grafema-demo]   Socket:   $SOCKET_PATH"
echo "[grafema-demo]   WS port:  $WS_PORT"

# Start rfdb-server as background process (runs as root, serves on localhost only)
/usr/local/bin/rfdb-server "$DB_PATH" --socket "$SOCKET_PATH" --ws-port "$WS_PORT" &
RFDB_PID=$!

echo "[grafema-demo] rfdb-server PID: $RFDB_PID"

# Health check: wait for WebSocket port to become available
echo "[grafema-demo] Waiting for rfdb-server on port $WS_PORT..."
elapsed=0
while ! nc -z localhost "$WS_PORT" 2>/dev/null; do
    if [ "$elapsed" -ge "$HEALTH_TIMEOUT" ]; then
        echo "[grafema-demo] ERROR: rfdb-server did not start within ${HEALTH_TIMEOUT}s"
        exit 1
    fi
    # Check if process is still alive
    if ! kill -0 "$RFDB_PID" 2>/dev/null; then
        echo "[grafema-demo] ERROR: rfdb-server process died unexpectedly"
        exit 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done

echo "[grafema-demo] rfdb-server is ready (took ${elapsed}s)"
echo "[grafema-demo] Starting code-server on :8080..."

# Start supervisord (manages code-server)
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf

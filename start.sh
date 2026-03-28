#!/bin/zsh

# --- Crypto Terminal Robust Startup Script ---

PROJECT_DIR="/Users/aranayabsarkar/experiments/crypto_terminal"
VENV_PATH="$PROJECT_DIR/venv/bin/activate"
LOG_DIR="$PROJECT_DIR/logs"

mkdir -p "$LOG_DIR"

echo "🧹 Cleaning up pre-existing processes..."

# 1. Kill any process on port 8080 (Flask)
LSOF_8080=$(lsof -t -i :8080)
if [[ -n "$LSOF_8080" ]]; then
  echo "⚠️  Found process on port 8080. Terminating..."
  echo "$LSOF_8080" | xargs kill -9
fi

# 2. Kill all cloudflared instances
pkill -f cloudflared
echo "✅ Stale processes cleared."

# 3. Clear database lock files if they exist (safe cleanup)
rm -f "$PROJECT_DIR/terminal.db-journal" "$PROJECT_DIR/terminal.db-wal"

echo "🚀 Starting Crypto Terminal Ecosystem..."

# 1. Start Flask Server
echo "📡 Launching Flask Server (server1.py)..."
source "$VENV_PATH"
nohup python3 "$PROJECT_DIR/server1.py" > "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
echo "✅ Server started (PID: $SERVER_PID). logs at $LOG_DIR/server.log"

# 2. Wait for server to be healthy
echo "⏳ Waiting for server health check..."
MAX_RETRIES=15
RETRY_COUNT=0
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if curl -s http://localhost:8080/health > /dev/null; then
    echo "✅ Server is healthy!"
    break
  fi
  RETRY_COUNT=$((RETRY_COUNT+1))
  sleep 1
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "❌ Server failed to start in time. Check $LOG_DIR/server.log"
  kill $SERVER_PID
  exit 1
fi

# 3. Start Cloudflare Tunnel
echo "🛡️  Starting Cloudflare Tunnel..."
nohup cloudflared tunnel --config "$PROJECT_DIR/config.yml" run > "$LOG_DIR/tunnel.log" 2>&1 &
TUNNEL_PID=$!
echo "✅ Tunnel started (PID: $TUNNEL_PID). logs at $LOG_DIR/tunnel.log"

echo ""
echo "✨ Ecosystem fully restored after loadshedding!"
echo "Server: http://localhost:8080"
echo "Tunnel: Active (see logs for URL)"
echo ""

# 4. Open dashboard in browser
echo "🌐 Opening Crypto Terminal Dashboard..."
open "http://localhost:8080"

echo "---"
echo "To stop everything later: kill $SERVER_PID $TUNNEL_PID"

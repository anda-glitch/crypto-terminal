#!/bin/zsh

# --- Crypto Terminal One-Button Restart ---
# Double-click this file from Finder to restart everything!

cd "$(dirname "$0")"
./start.sh

# Keep the window open for 10 seconds to let the user see the status
echo ""
echo "🚪 Closing in 10 seconds..."
sleep 10
exit

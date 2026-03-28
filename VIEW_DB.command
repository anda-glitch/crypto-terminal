#!/bin/bash
# VIEW_DB.command - Quick terminal view of terminal.db tables
cd "$(dirname "$0")"
DB_FILE="terminal.db"

if [ ! -f "$DB_FILE" ]; then
    echo "Error: $DB_FILE not found in $(pwd)"
    exit 1
fi

echo "==========================================="
echo "CRYPTO TERMINAL - DATABASE LIVE INSPECTOR"
echo "==========================================="
echo ""
echo "TABLES FOUND:"
sqlite3 $DB_FILE ".tables"
echo ""
echo "RECENT TRADES:"
sqlite3 -header -column $DB_FILE "SELECT * FROM trades ORDER BY id DESC LIMIT 5;"
echo ""
echo "USER ACCOUNTS:"
sqlite3 -header -column $DB_FILE "SELECT username, email, active_session FROM users;"
echo ""
echo "WATCHLIST (TOP 5):"
sqlite3 -header -column $DB_FILE "SELECT * FROM watchlist LIMIT 5;"
echo ""
echo "==========================================="
echo "Press any key to close..."
read -n 1

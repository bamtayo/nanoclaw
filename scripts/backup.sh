#!/usr/bin/env bash
# Backs up critical NanoClaw state to OneDrive Documents.
# Safe to run while the service is running — SQLite files are copied with
# a brief WAL checkpoint, not locked.
set -euo pipefail

BACKUP_DIR="/mnt/c/Users/ZION/OneDrive/Documents/nanoclaw-backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE="$BACKUP_DIR/nanoclaw-$TIMESTAMP.tar.gz"
LATEST="$BACKUP_DIR/nanoclaw-latest.tar.gz"

mkdir -p "$BACKUP_DIR"

# Checkpoint WAL so the SQLite copy is consistent
sqlite3 /home/zion/nanoclaw/data/v2.db "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true

tar -czf "$ARCHIVE" \
  --exclude='*.log' \
  --exclude='node_modules' \
  -C /home/zion \
  nanoclaw/.env \
  nanoclaw/data/v2.db \
  nanoclaw/groups \
  .gmail-mcp \
  .gdrive-mcp \
  .ms365-mcp \
  .config/nanoclaw \
  onecli-web-client.json \
  2>/dev/null

# Keep a stable "latest" symlink for easy restore reference
ln -sf "$ARCHIVE" "$LATEST"

SIZE=$(du -sh "$ARCHIVE" | cut -f1)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup complete: $ARCHIVE ($SIZE)"

# Prune backups older than 30 days
find "$BACKUP_DIR" -name "nanoclaw-*.tar.gz" -mtime +30 -delete 2>/dev/null || true

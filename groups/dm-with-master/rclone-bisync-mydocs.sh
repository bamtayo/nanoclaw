#!/usr/bin/env bash
# Hourly bisync of work Google Drive's "My Documents" ↔ OneDrive's
# "Documents/My Documents GDrive". Self-heals from the "Must run
# --resync to recover" state that bisync drops into after consecutive
# transient failures (perms, network, etc.).
#
# Triggered by zion's crontab, every hour.

set -uo pipefail

LOG=/home/zion/rclone-sync.log
LOCK=/home/zion/.cache/rclone-bisync-mydocs.lock
SRC='gdrive-work:My Documents'
DST='onedrive:Documents/My Documents GDrive'
ENV_FILE=/home/zion/nanoclaw/.env
CHAT_ID=7059290642

# Prevent overlapping runs — the single biggest preventable cause of state
# corruption. If a previous hour's bisync is still going when the next cron
# fires, two processes racing on the same workdir can leave inconsistent
# listings/lock files and force a full --resync. flock returns immediately
# if it can't acquire the lock; we treat that as success (the prior run
# will handle this hour's deltas).
mkdir -p "$(dirname "$LOCK")"
exec 9>"$LOCK"
if ! flock -n 9; then
  printf '%s SKIP: prior run still holding %s\n' "$(date '+%Y/%m/%d %H:%M:%S')" "$LOCK" >> "$LOG"
  exit 0
fi

stamp() { date '+%Y/%m/%d %H:%M:%S'; }
log()   { printf '%s %s\n' "$(stamp)" "$*" >> "$LOG"; }

telegram() {
  local body="$1"
  local tok
  tok=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
  [[ -z "$tok" ]] && return 0
  curl -fsS --max-time 15 \
    -X POST "https://api.telegram.org/bot${tok}/sendMessage" \
    -d "chat_id=${CHAT_ID}" -d "parse_mode=Markdown" \
    --data-urlencode "text=${body}" >/dev/null 2>&1 || true
}

# Run the normal bisync. Capture combined output so we can grep for the
# specific recovery signal without losing it from the log.
OUT=$(/usr/bin/rclone bisync "$SRC" "$DST" --tpslimit 2 --tpslimit-burst 2 --drive-skip-dangling-shortcuts 2>&1)
RC=$?

printf '%s\n' "$OUT" >> "$LOG"

if (( RC == 0 )); then
  exit 0
fi

# Auto-recover only on the specific bisync-aborted-needs-resync signal.
# Other failures (network, perms, quota) should still alert without
# blindly resyncing.
if grep -qF 'Must run --resync to recover' <<<"$OUT"; then
  log "AUTO-RECOVER: bisync state lost, running --resync"
  RESYNC_OUT=$(/usr/bin/rclone bisync "$SRC" "$DST" --resync --tpslimit 2 --tpslimit-burst 2 --drive-skip-dangling-shortcuts 2>&1)
  RC2=$?
  printf '%s\n' "$RESYNC_OUT" >> "$LOG"
  if (( RC2 == 0 )); then
    log "AUTO-RECOVER: resync OK, baseline rebuilt"
    telegram "🔄 rclone bisync self-healed: state was lost, ran \`--resync\` (Path1=Drive wins on conflicts). Next hourly runs back to delta-only. Check \`$LOG\` if you suspect a OneDrive-side change was clobbered."
  else
    log "AUTO-RECOVER: resync FAILED (exit $RC2)"
    telegram "🚨 rclone bisync self-heal **failed**: \`--resync\` exited $RC2. OneDrive ↔ Drive sync is dead until you debug. Tail \`$LOG\`."
  fi
  exit $RC2
fi

# Non-recoverable failure: log + alert.
log "bisync failed (exit $RC), no auto-recover path matched"
telegram "🚨 rclone bisync failed (exit $RC) — not a recoverable state error. OneDrive ↔ Drive sync stalled. Tail \`$LOG\`."
exit $RC

#!/usr/bin/env bash
# Sync work Gmail (tayo@maxdrive.ai) via lieer and reindex with notmuch.
# Wrapped in flock so overlapping cron runs can't collide on the maildir lock.
set -euo pipefail

MAILDIR="/home/zion/mail/maxdrive"
LOG="/tmp/gmi-sync-maxdrive.log"

cd "$MAILDIR"
exec /usr/bin/flock -n /tmp/gmi-sync-maxdrive.lock bash -c "
  echo '[\$(date -Iseconds)] pull starting' >> '$LOG'
  # IMPORTANT: pull-only, NEVER 'gmi sync'.
  # 'gmi sync' pushes local notmuch tags back to Gmail labels. Since we
  # ignore_remote_labels for CATEGORY_* on pull, the local maildir lacks
  # those tags, and push would STRIP them from Gmail — undoing the user's
  # filters and dumping every message into Primary inbox.
  /usr/bin/gmi pull >> '$LOG' 2>&1
  /usr/bin/notmuch new >> '$LOG' 2>&1
  echo '[\$(date -Iseconds)] pull done' >> '$LOG'
"

#!/usr/bin/env bash
# Proactively refreshes the Claude OAuth token on the host.
# Run every 4 hours via cron — independent of NanoClaw so credentials stay
# fresh even when no agent session is active.
set -euo pipefail

CREDS="$HOME/.claude/.credentials.json"
REFRESH_URL="https://platform.claude.com/v1/oauth/token"
LOG="/home/zion/nanoclaw/logs/token-refresh.log"
THRESHOLD=$((2 * 3600)) # refresh if expiry is within 2 hours

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

if [[ ! -f "$CREDS" ]]; then
  log "No credentials file — skipping"
  exit 0
fi

EXPIRES_AT=$(python3 -c "
import json, sys
d = json.load(open('$CREDS'))
tok = d.get('claudeAiOauth') or d.get('claudeAiOauthToken') or {}
print(int(tok.get('expiresAt', 0)) // 1000)
" 2>/dev/null || echo 0)

NOW=$(date +%s)
REMAINING=$(( EXPIRES_AT - NOW ))

if (( REMAINING > THRESHOLD )); then
  log "Token healthy — ${REMAINING}s until expiry, skipping refresh"
  exit 0
fi

REFRESH_TOKEN=$(python3 -c "
import json
d = json.load(open('$CREDS'))
tok = d.get('claudeAiOauth') or d.get('claudeAiOauthToken') or {}
print(tok.get('refreshToken', ''))
" 2>/dev/null || echo "")

if [[ -z "$REFRESH_TOKEN" ]]; then
  log "No refresh token available — manual /login required"
  exit 1
fi

RESPONSE=$(curl -sf -X POST "$REFRESH_URL" \
  -H "Content-Type: application/json" \
  -d "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"$REFRESH_TOKEN\"}" 2>/dev/null)

if [[ -z "$RESPONSE" ]]; then
  log "Refresh request failed — manual /login may be required"
  exit 1
fi

python3 - "$CREDS" <<EOF
import json, sys

creds_path = sys.argv[1]
refreshed = json.loads("""$RESPONSE""")

with open(creds_path) as f:
    d = json.load(f)

tok = d.get('claudeAiOauth') or d.get('claudeAiOauthToken') or {}
tok.update(refreshed)
updated = {'claudeAiOauth': tok, 'claudeAiOauthToken': tok}

with open(creds_path, 'w') as f:
    json.dump(updated, f)
EOF

NEW_EXPIRES=$(python3 -c "
import json
d = json.load(open('$CREDS'))
tok = d.get('claudeAiOauth') or d.get('claudeAiOauthToken') or {}
import time; remaining = int(tok.get('expiresAt', 0)) // 1000 - int(time.time())
print(f'{remaining // 3600}h {(remaining % 3600) // 60}m')
" 2>/dev/null || echo "unknown")

log "Token refreshed successfully — valid for $NEW_EXPIRES"

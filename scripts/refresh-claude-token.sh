#!/usr/bin/env bash
# Proactively refreshes the Claude OAuth token on the host.
# Run every 4 hours via cron — independent of NanoClaw so credentials stay
# fresh even when no agent session is active.
#
# Format derived from the Claude Code binary at
# /home/zion/.nvm/versions/node/v24.15.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe:
#   POST https://platform.claude.com/v1/oauth/token
#   Content-Type: application/x-www-form-urlencoded
#   grant_type=refresh_token & refresh_token=... & client_id=9d1c250a-...
#
# Response is snake_case (access_token, expires_in) — the credentials file
# is camelCase (accessToken, expiresAt in ms). We translate at write time.
set -euo pipefail

CREDS="$HOME/.claude/.credentials.json"
REFRESH_URL="https://platform.claude.com/v1/oauth/token"
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
LOG="/home/zion/nanoclaw/logs/token-refresh.log"
FAIL_SENTINEL="/home/zion/nanoclaw/logs/token-refresh.failing"
THRESHOLD=$((2 * 3600)) # refresh if expiry is within 2 hours

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

mark_failed() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" > "$FAIL_SENTINEL"
}
mark_ok() {
  rm -f "$FAIL_SENTINEL"
}

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
  mark_failed "No refresh token — run /login"
  exit 1
fi

RESPONSE=$(curl -s -X POST "$REFRESH_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "refresh_token=$REFRESH_TOKEN" \
  --data-urlencode "client_id=$CLIENT_ID" 2>&1) || true

if [[ -z "$RESPONSE" ]]; then
  log "Refresh request failed (no response) — manual /login may be required"
  mark_failed "Refresh request returned no response"
  exit 1
fi

# Validate success: must contain access_token (snake_case from OAuth response)
if echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('access_token') else 1)" 2>/dev/null; then
  : # valid
else
  log "Refresh response was an error: $(echo "$RESPONSE" | head -c 300) — manual /login may be required"
  mark_failed "Refresh failed: $(echo "$RESPONSE" | head -c 200)"
  exit 1
fi

python3 - "$CREDS" <<PYEOF || { log "Failed to write updated credentials"; exit 1; }
import json, sys, time

creds_path = sys.argv[1]
resp = json.loads("""$RESPONSE""")

with open(creds_path) as f:
    d = json.load(f)

tok = d.get('claudeAiOauth') or d.get('claudeAiOauthToken') or {}

# Translate snake_case OAuth response → camelCase credentials format.
if 'access_token' in resp:
    tok['accessToken'] = resp['access_token']
if 'refresh_token' in resp:
    tok['refreshToken'] = resp['refresh_token']
if 'expires_in' in resp:
    # expires_in is seconds-from-now; expiresAt is ms-since-epoch
    tok['expiresAt'] = int((time.time() + int(resp['expires_in'])) * 1000)
if 'scope' in resp:
    tok['scopes'] = resp['scope'].split(' ') if isinstance(resp['scope'], str) else resp['scope']

updated = {'claudeAiOauth': tok, 'claudeAiOauthToken': tok}

with open(creds_path, 'w') as f:
    json.dump(updated, f)
PYEOF

NEW_EXPIRES=$(python3 -c "
import json
d = json.load(open('$CREDS'))
tok = d.get('claudeAiOauth') or d.get('claudeAiOauthToken') or {}
import time; remaining = int(tok.get('expiresAt', 0)) // 1000 - int(time.time())
print(f'{remaining // 3600}h {(remaining % 3600) // 60}m')
" 2>/dev/null || echo "unknown")

log "Token refreshed successfully — valid for $NEW_EXPIRES"
mark_ok

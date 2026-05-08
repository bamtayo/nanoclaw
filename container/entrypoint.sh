#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

set -e

# Symlink gmail credentials to home dir so gmail-mcp's fallback path works.
# The mount lands at /workspace/extra/.gmail-mcp; ~/.gmail-mcp is where the
# server looks when GMAIL_OAUTH_PATH / GMAIL_CREDENTIALS_PATH aren't set.
[ -d /workspace/extra/.gmail-mcp ] && ln -sfn /workspace/extra/.gmail-mcp ~/.gmail-mcp

# Symlink gdrive tokens to the default XDG config path that mcp-google-drive
# falls back to when GOOGLE_TOKEN_PATH env var isn't propagated by the SDK.
if [ -d /workspace/extra/.gdrive-mcp ]; then
  mkdir -p ~/.config/mcp-google-drive
  ln -sfn /workspace/extra/.gdrive-mcp/tokens.json ~/.config/mcp-google-drive/tokens.json
fi

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json

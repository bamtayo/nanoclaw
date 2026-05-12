#!/bin/sh
# Run a second Gmail MCP instance for the tayo@maxdrive.ai work account.
# Uses an isolated HOME so it doesn't clobber the personal account's credentials.
#
# Why this is a separate MCP from the personal 'gmail' one:
# - @gongrzhe/server-gmail-autoauth-mcp expects credentials in ~/.gmail-mcp/.
# - Two accounts ⇒ two HOMEs ⇒ two MCP processes. They share the same npm
#   package binary but read different credential files.
#
# Why invoke /pnpm/bin/gmail-mcp directly (not via npx):
# - npx would fetch the package from the npm registry through the OneCLI
#   proxy on every spawn (30+s, frequently times out, leaves the agent
#   without mcp__gmail-work__send_email).
#
# Why GMAIL_FROM_HEADER is set:
# - The image build patches the package's hardcoded 'From: me' so it
#   reads From from this env var (fallback: 'me'). Lets Gmail show the
#   user's friendly display name on outgoing mail. The personal MCP
#   doesn't set this env var so its behavior is unchanged.
#   See scripts/build-group-image-gcalcli.sh for the image-side patch.
set -e

export HOME=/tmp/gmail-mcp-work-home
mkdir -p "$HOME/.gmail-mcp"
cp /workspace/extra/.gmail-mcp/gcp-oauth.keys.json "$HOME/.gmail-mcp/gcp-oauth.keys.json"
cp /workspace/extra/.gmail-mcp/credentials.work.json "$HOME/.gmail-mcp/credentials.json"

# Persist refreshed credentials back to the shared location on exit so the
# refresh token survives container restarts.
trap 'cp "$HOME/.gmail-mcp/credentials.json" /workspace/extra/.gmail-mcp/credentials.work.json 2>/dev/null' EXIT

export GMAIL_FROM_HEADER='Adetayo Bamiduro <tayo@maxdrive.ai>'

exec /pnpm/bin/gmail-mcp

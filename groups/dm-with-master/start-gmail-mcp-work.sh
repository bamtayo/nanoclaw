#!/bin/sh
# Run a second Gmail MCP instance for the tayo@maxdrive.ai work account.
# Uses an isolated HOME so it doesn't clobber the personal account's credentials.
#
# IMPORTANT: invoke /pnpm/bin/gmail-mcp directly. Earlier versions used
# `npx @gongrzhe/server-gmail-autoauth-mcp`, which forced a 30+ second
# package download from the npm registry through the OneCLI proxy on every
# container spawn — usually timing out and the MCP never started, leaving
# the agent without mcp__gmail-work__send_email and falling back to
# claiming "lieer can't send".
export HOME=/tmp/gmail-mcp-work-home
mkdir -p "$HOME/.gmail-mcp"
cp /workspace/extra/.gmail-mcp/gcp-oauth.keys.json "$HOME/.gmail-mcp/gcp-oauth.keys.json"
cp /workspace/extra/.gmail-mcp/credentials.work.json "$HOME/.gmail-mcp/credentials.json"
# Persist refreshed credentials back to the shared location on exit so the
# refresh token survives container restarts.
trap 'cp "$HOME/.gmail-mcp/credentials.json" /workspace/extra/.gmail-mcp/credentials.work.json 2>/dev/null' EXIT
exec /pnpm/bin/gmail-mcp

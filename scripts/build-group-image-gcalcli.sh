#!/usr/bin/env bash
# Build a per-agent-group container image with gcalcli installed for work
# Google Calendar access (read/search/add events).
#
# Why not just use container.json's packages.apt?
# - Ubuntu 26.04's apt package ships gcalcli 4.3.0, which uses the deprecated
#   oauth2client library and expects tokens at ~/.gcalcli_oauth (legacy path).
# - Host gcalcli (4.5.x) uses google-auth and stores tokens at
#   $XDG_DATA_HOME/gcalcli/oauth. Pickle format differs across libraries.
# - To share OAuth tokens between host and container, we need matching
#   versions on both sides, so we install gcalcli via pip in the container.
# - We also need ENV XDG_DATA_HOME=/workspace/extra/.local/share so gcalcli
#   inside the container finds the bind-mounted oauth file (nanoclaw's
#   additionalMounts can only land under /workspace/extra/, not /home/node/).
#
# Usage: ./scripts/build-group-image-gcalcli.sh <agent-group-id>
#   e.g.: ./scripts/build-group-image-gcalcli.sh ag-1778157312942-nn81ob
#
# After running, set the resulting imageTag in groups/<folder>/container.json:
#   "imageTag": "<output of this script>"
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE_BASE="$(container_image_base)"

AGENT_GROUP_ID="${1:?Usage: $0 <agent-group-id>}"
TAG="${IMAGE_BASE}:${AGENT_GROUP_ID}"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Cc/Bcc patch script for @gongrzhe/server-gmail-autoauth-mcp v1.1.11.
# v1.1.11's read_email handler omits Cc and Bcc from the returned text — patches
# the dist/index.js to extract both headers and include them after To: in the
# returned email summary. Idempotent (no-op if already patched).
cat > "$TMPDIR/patch-gmail-cc.js" <<'EOF'
const fs = require('fs');
const p = process.argv[2];
let s = fs.readFileSync(p, 'utf8');
if (s.includes("const cc = headers.find")) { console.log('gmail-mcp already Cc-patched'); process.exit(0); }
const findDate = "const date = headers.find(h => h.name?.toLowerCase() === 'date')?.value || '';";
const addCcBcc = findDate + `
                    const cc = headers.find(h => h.name?.toLowerCase() === 'cc')?.value || '';
                    const bcc = headers.find(h => h.name?.toLowerCase() === 'bcc')?.value || '';`;
const findText = 'Thread ID: ${threadId}\\nSubject: ${subject}\\nFrom: ${from}\\nTo: ${to}\\nDate: ${date}';
const replText = 'Thread ID: ${threadId}\\nSubject: ${subject}\\nFrom: ${from}\\nTo: ${to}\\nCc: ${cc}\\nBcc: ${bcc}\\nDate: ${date}';
if (!s.includes(findDate)) { console.error('Cc patch: date line not found, package layout changed?'); process.exit(1); }
if (!s.includes(findText)) { console.error('Cc patch: text template not found, package layout changed?'); process.exit(1); }
s = s.replace(findDate, addCcBcc).replace(findText, replText);
fs.writeFileSync(p, s);
console.log('gmail-mcp Cc-patched OK');
EOF

cat > "$TMPDIR/Dockerfile" <<'EOF'
ARG IMAGE_BASE
FROM ${IMAGE_BASE}:latest
USER root
RUN apt-get update && apt-get install -y python3-pip python3-venv && rm -rf /var/lib/apt/lists/*
RUN pip install --break-system-packages gcalcli==4.5.1
ENV XDG_DATA_HOME=/workspace/extra/.local/share

# Patch @gongrzhe/server-gmail-autoauth-mcp so its hardcoded 'From: me'
# becomes a template that reads from $GMAIL_FROM_HEADER (fallback 'me').
# Lets the work-account gmail-work MCP show Adetayo's display name without
# affecting the personal Gmail MCP. start-gmail-mcp-work.sh sets the env
# var; personal MCP doesn't, so its behavior is unchanged.
RUN GMAIL_UTL=$(readlink -f /pnpm/global/v11/7-19e0d729bae/node_modules/@gongrzhe/server-gmail-autoauth-mcp)/dist/utl.js && \
    grep -q "'From: me'" "$GMAIL_UTL" && \
    sed -i "s#'From: me'#\`From: \${process.env.GMAIL_FROM_HEADER || 'me'}\`#" "$GMAIL_UTL"

# Patch read_email to also surface Cc/Bcc headers (v1.1.11 only returns
# Subject/From/To/Date — Cc disappears from the agent's view of every email).
# Path-glob find since the pnpm content-addressed hash drifts across rebuilds.
COPY patch-gmail-cc.js /tmp/patch-gmail-cc.js
RUN GMAIL_INDEX=$(find /pnpm/global -type f -path "*@gongrzhe/server-gmail-autoauth-mcp/dist/index.js" | head -1) && \
    [ -n "$GMAIL_INDEX" ] && node /tmp/patch-gmail-cc.js "$GMAIL_INDEX" && \
    rm /tmp/patch-gmail-cc.js

USER node
EOF

docker build --build-arg "IMAGE_BASE=$IMAGE_BASE" -t "$TAG" -f "$TMPDIR/Dockerfile" "$TMPDIR"
echo
echo "Built: $TAG"
echo "Now set this in groups/<folder>/container.json:"
echo "  \"imageTag\": \"$TAG\""

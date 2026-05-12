#!/usr/bin/env bash
# Safety wrapper around /usr/bin/gmi.
# Refuses 'sync' and 'push' because lieer's push direction strips Gmail
# labels not present in the local maildir — including filter-applied
# CATEGORY_* labels — which dismantles your inbox filters.
# See ~/sync-maxdrive-mail.sh comment block for the full incident note.
set -euo pipefail

if [[ "${1:-}" == "sync" || "${1:-}" == "push" ]]; then
  echo "REFUSED: 'gmi $1' is blocked by ~/.local/bin/gmi wrapper." >&2
  echo "" >&2
  echo "Reason: lieer push would strip Gmail labels (categories, custom)" >&2
  echo "  not present in the local maildir, dismantling your filters." >&2
  echo "" >&2
  echo "If you absolutely must push (e.g. one-off debugging), bypass" >&2
  echo "  the wrapper with: /usr/bin/gmi $*" >&2
  exit 1
fi
exec /usr/bin/gmi "$@"

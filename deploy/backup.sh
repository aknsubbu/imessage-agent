#!/usr/bin/env bash
# Takes a consistent copy of the database. The database runs in WAL mode, so a
# plain file copy of agent.db can miss recent writes; sqlite's own backup does not.
set -euo pipefail

ROOT=/opt/imessage-agent
DEST="$ROOT/data/backups"
mkdir -p "$DEST"

sqlite3 "$ROOT/data/agent.db" ".backup '$DEST/agent-$(date +%F).db'"
# Keep two weeks.
find "$DEST" -name 'agent-*.db' -mtime +14 -delete

# These copies still live on the same disk. To survive losing the VM, pull the
# newest one to another machine, for example from your laptop:
#   scp agent@<vm>:/opt/imessage-agent/data/backups/agent-$(date +%F).db ~/agent-backups/

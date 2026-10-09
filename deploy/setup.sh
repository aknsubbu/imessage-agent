#!/usr/bin/env bash
# One-time setup of a Debian or Ubuntu VM. Run as root from the repository,
# after copying the repository to /opt/imessage-agent along with the three env
# files (agent-server/.env, imessage-chatbot/.env, imessage-chatbot/.env.local).
#
#   sudo bash /opt/imessage-agent/deploy/setup.sh
set -euo pipefail

ROOT=/opt/imessage-agent
NODE_MAJOR="${NODE_MAJOR:-24}"

if [[ $EUID -ne 0 ]]; then echo "Run this as root (sudo)." >&2; exit 1; fi
if [[ ! -d "$ROOT/agent-server" ]]; then echo "Copy the repository to $ROOT first." >&2; exit 1; fi

# --- refuse to start half-configured -------------------------------------------
need() { # file, variable
  grep -Eq "^$2=.+" "$1" 2>/dev/null || { echo "Missing $2 in $1" >&2; MISSING=1; }
}
MISSING=0
need "$ROOT/agent-server/.env" AGENT_SHARED_SECRET
need "$ROOT/agent-server/.env" GROQ_API_KEYS
# Without these two a fresh VM would run in UTC and hand ownership to whoever texts first.
need "$ROOT/agent-server/.env" OWNER_IDS
need "$ROOT/agent-server/.env" TIMEZONE
need "$ROOT/imessage-chatbot/.env" PROJECT_ID
need "$ROOT/imessage-chatbot/.env" PROJECT_SECRET
need "$ROOT/imessage-chatbot/.env.local" AGENT_SHARED_SECRET
if [[ $MISSING -ne 0 ]]; then echo "Fix the env files above, then run this again." >&2; exit 1; fi

# --- packages ------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# ffmpeg: voice memos and photo resizing. libheif-examples: heif-convert, which
# decodes iPhone photos where the distribution's ffmpeg is older than version 7.
apt-get install -y ca-certificates curl ffmpeg libheif-examples sqlite3
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

# --- swap: decoding a large photo needs more than a 1 GB machine has spare -----
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- user, files, dependencies ---------------------------------------------------
id agent >/dev/null 2>&1 || useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin agent
mkdir -p "$ROOT/data/media" "$ROOT/data/backups"
chown -R agent:agent "$ROOT"
chmod 600 "$ROOT/agent-server/.env" "$ROOT/imessage-chatbot/.env" "$ROOT/imessage-chatbot/.env.local"
chmod +x "$ROOT/deploy/backup.sh"
for dir in protocol agent-server imessage-chatbot; do
  (cd "$ROOT/$dir" && sudo -u agent env HOME=/tmp npm ci --no-audit --no-fund)
done

# --- services --------------------------------------------------------------------
cp "$ROOT"/deploy/*.service "$ROOT"/deploy/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now agent-server.service
systemctl enable --now agent-backup.timer

cat <<'NOTE'

The agent server is running. The bridge is installed but NOT started.

Only one bridge may run against your Photon project. Stop the one on your
laptop first (Ctrl+C), then start this one:

    sudo systemctl enable --now imessage-bridge.service

Logs:    journalctl -u agent-server -u imessage-bridge -f
Deploy:  copy the new code, then  sudo systemctl restart agent-server
         (restart imessage-bridge only when the bridge's own code changed)
NOTE

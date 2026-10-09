# Running it on a cloud VM

These files set up one small Debian or Ubuntu VM to run both processes under `systemd`. **They have not been run on a real VM yet**; treat the first run as a test.

The VM needs no inbound ports other than SSH: the bridge dials out to Photon.

## Steps

1. Create the VM (Debian 12+ or Ubuntu 24.04+, 1 GB of memory is enough) and make sure you can SSH in with a key.
2. Copy the repository, without `node_modules` or `data`:

```bash
rsync -a --exclude node_modules --exclude data --exclude .git ./ <user>@<vm>:/tmp/imessage-agent/
```

3. On the VM, move it into place and run the setup. The three env files travel with the copy; the script refuses to continue if `OWNER_IDS`, `TIMEZONE` or a secret is missing.

```bash
sudo mv /tmp/imessage-agent /opt/imessage-agent && sudo bash /opt/imessage-agent/deploy/setup.sh
```

4. Stop the bridge on your laptop (Ctrl+C). Then start the one on the VM:

```bash
sudo systemctl enable --now imessage-bridge.service
```

5. Text the agent. Watch the logs with:

```bash
journalctl -u agent-server -u imessage-bridge -f
```

## What the setup does

- Installs Node, `ffmpeg`, `libheif-examples` (for iPhone photos) and `sqlite3`, and adds a 1 GB swap file.
- Creates an `agent` user that owns `/opt/imessage-agent` and can write only to `data/`.
- Installs `agent-server.service` and `imessage-bridge.service` with `Restart=always`, and a nightly database backup into `data/backups/` (kept for two weeks).

## Things to know

- **Memory and history start fresh on the VM** unless you also copy `data/agent.db` from your laptop. Stop the laptop server first, then copy it with `sqlite3 data/agent.db ".backup agent-copy.db"` and place it at `/opt/imessage-agent/data/agent.db`.
- **Updating:** copy the new code over, then `sudo systemctl restart agent-server`. Restart `imessage-bridge` only when the bridge's own code changed, because texts sent during a bridge restart are lost.
- **Backups stay on the VM's disk.** Pull one to another machine now and then; `backup.sh` shows the command.
- **Nothing watches the VM from outside yet.** If it goes down, the agent simply stops answering.

# iMessage agent

Two processes and one shared contract. The design and roadmap are in [PLAN.md](PLAN.md).

| Folder | What it is |
|---|---|
| `imessage-chatbot/` | The **bridge**. The only process that talks to Spectrum. Forwards every inbound message to the server and carries out the actions it sends back. |
| `agent-server/` | The **agent server**. Decides what to do: debouncing, memory, the model calls, commands, the outbox. |
| `protocol/` | The types and request signing both sides share. |
| `data/` | Created on first run: the SQLite database and downloaded media. |
| `deploy/` | Setup script and `systemd` units for running both on a cloud VM. See [deploy/README.md](deploy/README.md). |

## Run it

Start the server first, then the bridge, each in its own terminal. Only ever run **one** bridge against a Photon project.

```bash
cd agent-server && npm start
```

```bash
cd imessage-chatbot && npm start
```

Stop either with Ctrl+C. Restart the server as often as you like; restart the bridge only when its own code changes, because texts that arrive while it is down are lost.

## Configure

`agent-server/.env` (copy from `.env.example`):

- `GROQ_API_KEYS` — comma-separated. Leave empty to run on the built-in fake model.
- `OWNER_IDS` — your number or email. Leave empty and the first person to text becomes the owner.
- `TIMEZONE` — defaults to the machine's zone.
- `AGENT_SHARED_SECRET` — must match the one in `imessage-chatbot/.env.local`.

## Develop without iMessage

With the server running, chat from a terminal. This uses its own "terminal" channel, so it never crosses wires with the real bridge. It needs `OWNER_IDS` (or `CHAT_SENDER`) set.

```bash
cd agent-server && npm run chat
```

```bash
cd agent-server && npm test
```

Once Groq keys are in place, this prints your real limits and settles the plan's open questions:

```bash
cd agent-server && npm run probe
```

## What it can do

- Hold a conversation, remember lasting facts about you, and keep a running summary of long chats.
- Keep lists and notes, set one-off and repeating reminders, search earlier messages, do exact arithmetic.
- Follow reminders through without the model: 👍 a reminder to mark it done, reply `1h` (or `snooze`, `tomorrow`, `done`) to put it off or finish it, one nudge after 30 quiet minutes, and a streak count for repeating ones.
- Understand voice memos (transcribed with Whisper) and photos.
- Search the web (Groq's built-in search, on the same keys) and read a link you send.

Web content is treated as untrusted: the link fetcher opens only links you sent yourself and refuses private and internal addresses, pages are scored by Groq's prompt-injection classifier, and once web text is in a turn the agent cannot save, schedule, delete, search again or open another link until your next message.

Voice and photos need `ffmpeg` on the machine. Photos also need a HEIC decoder: `sips` on macOS (built in), or `heif-convert` on Linux (`apt install libheif-examples`).

## Commands you can text

`/help`, `/memory`, `/forget <n>` or `/forget all`, `/lists`, `/reminders`, `/usage`, `/reset`, `/ping` for everyone; `/status`, `/who`, `/allow <id>`, `/deny <id>` for the owner.

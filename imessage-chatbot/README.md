<img src="../assets/logo.svg" width="72" align="right" alt="imessage-agent logo">

# imessage-chatbot (the bridge)

The only process that talks to [Spectrum](https://photon.codes/docs/spectrum-ts) and Photon's cloud iMessage. It holds no conversation logic, so it rarely needs a restart: it forwards every inbound message, reaction and receipt to the agent server, and carries out the actions the server sends back (send, react, typing, read receipts, and so on). The decisions all live in [`../agent-server`](../agent-server); the shared message types and request signing are in [`../protocol`](../protocol).

See the [top-level README](../README.md) for the whole system and [DEMO.md](../DEMO.md) for what it can do.

## Environment

From your project Settings on the [Photon dashboard](https://app.photon.codes), in `.env`:

- `PROJECT_ID`
- `PROJECT_SECRET`

And in `.env.local`:

- `AGENT_SHARED_SECRET` — must match the one in `agent-server/.env`. Requests between the two are signed with it.
- `AGENT_SERVER_URL` — only if the server is not at `http://127.0.0.1:8787`.
- `MEDIA_DIR` — where attachments are saved for the server to read (default `../data/media`). It must be the same directory the server uses.

## Run

```sh
npm ci
npm run start
```

Start the agent server first. Run **one** bridge per Photon project. Restart the bridge only when its own code changes: texts that arrive while it is down are lost. The server can be restarted freely.

## Layout

| File | Job |
|---|---|
| `src/index.ts` | Starts Spectrum, forwards events, runs the action loop, stops cleanly on SIGINT and SIGTERM |
| `src/normalize.ts` | Turns a Spectrum message into the protocol's event, downloading attachments to the shared `data/media` directory |
| `src/server-client.ts` | Signed HTTP calls to the server, with retries |
| `src/execute.ts` | Carries out one action against Spectrum |
| `src/actions.ts` | Makes sure each action is carried out at most once, and reports `sending`, then the result |
| `src/recent.ts` | A bounded in-memory map of recent messages, spaces and action ids, so a tapback or edit can find its target |

## Where to go next

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- The message normaliser is tested from the agent server's suite (`cd ../agent-server && npm test`, see `test/normalize.test.ts`).

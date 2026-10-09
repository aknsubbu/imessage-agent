# iMessage agent server — plan

Written 2026-10-08, revised the same day for two changes: a pool of three Groq keys, and cloud hosting instead of your Mac. Covers the architecture, the Groq free-tier strategy, the full feature catalogue by phase, and the decisions that are yours to make.

## 1. Summary

- **Shape:** two processes on one small always-on cloud VM, so nothing depends on your laptop. The existing `imessage-chatbot` becomes a thin **bridge** that only talks to Spectrum. A new **agent server** owns everything else: memory, the Groq calls, tools, scheduling and the token budget.
- **Groq's free tier still shapes the design, but three keys loosen it.** Only three chat models are free today, each capped per account at 8,000 tokens per minute and 200,000 tokens per day. One account is roughly 30 tool-using replies a day on the main model; three separate accounts is roughly 90, and more with the fallback models.
- **What three keys do not change:** a single request still cannot exceed about 8,000 tokens, so context stays short whatever the pool size.
- **Flag — your call (section 7):** rotating between accounts to get past rate limits is something Groq's acceptable-use policy prohibits, and it puts all three accounts at risk of suspension. The key pool is built so its slots can hold other providers or a paid key instead.
- **The design stays budget-aware:** short context, burst debouncing, replies that cost zero tokens where possible (tapbacks, slash commands), and fallback across keys and then models.
- **Where this plan stands:** the facts below were researched against Groq's live docs and the Spectrum code installed in your project, then independently re-checked (119 claims, 26 corrected or left unconfirmed). The architecture is my own synthesis of that research; the planned comparison of three alternative designs did not run because the session hit its usage limit.

## 2. Facts the plan is built on

### Groq free tier (checked 2026-10-08)

| Model | Use | Requests/min · /day | Tokens/min · /day | Notes |
|---|---|---|---|---|
| `openai/gpt-oss-120b` | main agent, tool use | 30 · 1,000 | 8,000 · 200,000 | tools, strict JSON, prompt caching; one tool call per step |
| `openai/gpt-oss-20b` | plain chat, summaries, fallback | 30 · 1,000 | 8,000 · 200,000 | same features, faster |
| `qwen/qwen3.8-27b` | photos, last-resort fallback | 30 · 1,000 | 8,000 · 200,000 | **preview** model; only one that reads images (max 3, 2,048 tokens each) |
| `whisper-large-v3-turbo` | voice memos | 20 · 2,000 | 28,800 audio-seconds/day | 25 MB per file; does not accept CAF |
| `meta-llama/llama-prompt-guard-2-86m` | prompt-injection filter | 30 · 14,400 | 15,000 · 500,000 | 512-token input window |
| `canopylabs/orpheus-v1-english` | spoken replies | 10 · 100 | 1,200 · 3,600 | 200 characters per call, WAV only — a novelty at best |

What follows from this:

- **Older guides are wrong.** `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` and `groq/compound` are no longer on the free tier. Groq cut five chat models from it in two months, so model IDs must live in config and the server should call `GET /v1/models` at boot.
- **Groq has no embeddings endpoint.** Memory search starts with SQLite full-text search; local embeddings come later.
- **Limits are per organisation.** Three keys only add capacity if they belong to three separate accounts; three keys from one account share one set of limits.
- **Groq's policy on this.** The acceptable-use policy prohibits going beyond rate limits by "registering multiple accounts or orchestrating usage between multiple organizations", and the services agreement forbids use intended to avoid fees. Bouncing between three accounts when one is limited is that pattern.
- **No header reports daily tokens.** The server must keep its own usage ledger.
- **A tool-using reply is at least two requests**, about 7,000 tokens, which nearly fills one model's minute. A plain chat reply is one request of about 2,000 tokens.
- **Strict JSON output cannot be combined with tool use or streaming** in the same request.
- **Invalid tool calls come back as HTTP 400** with a `failed_generation` field; the loop must catch and retry these.
- **Data:** Groq does not retain inference data by default and may not train on it; a zero-data-retention toggle exists in the console.

### Spectrum as installed (`spectrum-ts` 12.10.1 — the bundled skill docs describe 12.2.0 and have drifted)

- **A restarted bridge loses messages.** The stream's resume position is held in memory only, so anything texted while the bridge is down is not replayed. Keep the bridge tiny and restart it rarely.
- **Do not `await` the agent inside the `for await` loop.** Delivery is serial; one slow reply stalls every chat. Hand each message to a per-chat queue.
- **No shutdown handlers.** 12.10.x no longer handles SIGINT/SIGTERM; the bridge must call `app.stop()` itself.
- **No idempotent send and no working retry.** Sends are single-shot, and a resend can duplicate. The bridge needs its own outbox.
- **The current echo loop silently ignores two common cases:** a threaded reply (content type `reply`) and a photo with a caption (content type `group`).
- **What cloud iMessage delivers inbound:** text, attachments, voice memos, contacts, replies, added reactions, read receipts, poll votes.
- **What it never delivers:** typing, edits, unsends, reaction removals. Features that react to those are blocked.
- **Voice memos arrive as CAF** and must be transcoded with ffmpeg before Whisper, so ffmpeg has to be installed on the VM.
- **Streaming is narrow.** Only a plain `text(stream)` updates in place, as one message plus at most five edits. Groq finishes short replies faster than that, so streaming is not worth building first.
- **Native tapbacks need the exact glyphs** ❤️ 👍 👎 😂 ‼️ ❓ (❤️ and ‼️ must include the U+FE0F variation selector); anything else is sent as a custom emoji reaction.
- **Line type decides several features.** On Photon's Free and Pro plans the number comes from a shared pool: group creation fails, group events are not delivered, and messages the agent starts on its own only reach people registered as users in the Photon dashboard (Free allows up to 10). Whether a plain reply to an unregistered sender also fails is not settled — see the table below. A dedicated line is the Business plan at $250 per line per month.
- **Photon quotas:** 5,000 messages per day and 50 new conversations per line per day.
- **Telemetry, which you turned on,** sends trace data to Photon. It does not include message text, but it does include the chat identifier, which embeds the other person's phone number or email.

### Settled by the live run on 2026-10-08

| Question | Answer |
|---|---|
| Are the three keys separate accounts with separate limits? | Yes. Each key reports its own 1,000 requests a day and 8,000 tokens a minute per model |
| Are the three chat models' limits separate buckets? | Yes |
| What does a reply cost? | About 1,100 tokens for plain chat now that the tool list rides along on every request; about 2,300 when a tool is used; about 3,600 with a photo |
| Is your Photon line shared or dedicated? | Shared |
| What do photos and voice memos arrive as? | HEIC (about 6 MB) and CAF with Opus audio; both are converted on the server |
| Does a plain reply to you go through on the shared line? | Yes |

### Still not confirmed

| Question | Why it matters |
|---|---|
| Does a reminder (a message the agent starts) reach you on the shared line? | Text it "remind me in 2 minutes to stretch" to find out |
| On a shared line, does a reply to an unregistered sender go through? | Decides whether extra users must be registered in the Photon dashboard |
| Do `browser_search` and `code_interpreter` work on a free key? | `npm run probe -- --search` answers it; decides whether web search needs Tavily |
| Is a single request over 8,000 tokens rejected outright? | `npm run probe -- --large` answers it |

## 3. Architecture

```
 iPhone ──iMessage──> Photon cloud ──gRPC──> BRIDGE (imessage-chatbot)        AGENT SERVER (new)
                                             thin, rarely restarted           restart freely
                                             ───────────────────────          ──────────────────────────
                                             normalise inbound event  ──POST /v1/events──>  journal + dedupe
                                             download media to disk                          fast paths (no LLM)
                                             spool events if server down                     debounce / cancel per chat
                                                                                             context under budget
                                             execute actions          <──SSE /v1/actions──   Groq router + tool loop
                                             (send, react, typing…)                          reply plan → actions
                                             own outbox, pacing       ──POST …/ack──────>    scheduler (reminders…)
                                                                                             SQLite: memory, ledger
```

Both processes run on the same cloud VM and talk over `127.0.0.1`. Neither needs an inbound port, because the bridge dials out to Photon.

### Why two processes

- **The bridge cannot be restarted without losing messages; the server can.** Putting all the logic you will iterate on in the server means daily development never drops a text.
- **Secrets stay apart.** The bridge holds the Photon credentials; the server holds the Groq key and any tool tokens.
- **The server is channel-agnostic.** The same server can sit behind Spectrum's terminal provider for development, and later WhatsApp, Telegram or Slack — those provider packages are already in `node_modules`.

### Who owns what

| Concern | Owner | Reason |
|---|---|---|
| Spectrum connection, media download, executing sends | Bridge | Only the bridge has the Spectrum objects |
| Carrying out sends and reporting each result | Bridge | It is the only place that knows whether a send returned |
| Send pacing, the outbox, never-double-send | Server | **changed while building:** the bridge keeps no state at all; pacing in the server also makes cancelling unsent bubbles trivial |
| Spooling inbound events while the server is down | Bridge | Messages must survive a server restart |
| Debounce, in-flight cancellation, carry-forward | Server | Needs the turn state and must abort the Groq call |
| Memory, tools, scheduling, token budget, model routing | Server | Everything that changes often |

### The contract between them

Three endpoints on the server, bound to `127.0.0.1`, both directions signed with the same HMAC scheme Spectrum uses for its webhooks (`v0=HMAC-SHA256(secret, "v0:" + timestamp + ":" + rawBody)`, five-minute window):

- `POST /v1/events` — the bridge posts every inbound event. The server stores it and answers `202`. Idempotent on `eventId`.
- `POST /v1/actions/poll` — the bridge long-polls this for actions: replies, and also reminders and other messages the agent starts on its own. (Built as a long poll, not a server-sent-events stream: same behaviour, simpler to test.) An action the bridge never started on is offered again.
- `POST /v1/actions/ack` — the bridge reports `sending` before it calls Spectrum and the result after. The server never re-offers an action that reached `sending`.

A reply is not the HTTP response to an event because debouncing means the reply to message one may never exist, and a reminder has no request to answer. For the first afternoon's spike, a synchronous `POST /v1/turn` returning `{ actions }` is fine.

The exact shapes — `InboundEvent`, `Action`, `Ack` — are defined once, with their validation, in [protocol/index.ts](protocol/index.ts). In short: an event is one inbound iMessage flattened into text and media parts, tagged as a message or as a signal (reaction, read receipt, poll vote); an action is one thing for the bridge to do (`send`, `react`, `typing`, `read`, `edit`, `unsend`).

- **Media:** the bridge downloads attachment bytes with `content.read()` and writes them to a shared directory; the event carries the path. The server does the transcoding and analysis.
- **Duplicates versus drops:** the bridge reports `sending` before the Spectrum call and the result after. After a crash, anything stuck in `sending` is recorded as a failure, not resent. A missing bubble is better than a repeated one.

### One turn, end to end

1. **Intake.** Journal the event, drop duplicates, ignore auto-replies and spam-flagged messages, check the sender against the allowlist.
2. **Fast paths, no Groq call.** Slash commands, tapbacks, read receipts, poll votes, and "ok / thanks / lol" (answered with a tapback).
3. **Debounce.** Wait a few seconds per chat for the burst to settle. If a new message lands mid-reply, abort the Groq call, cancel unsent bubbles, and answer everything together.
4. **Presence.** Mark the chat read, start the typing indicator.
5. **Context under budget.** Aim for about 3,000 input tokens: a fixed system prompt and tool list at the front (so Groq's cache can reuse it), a short profile of the person, a rolling summary, the last few messages.
6. **Model call.** Route by task, at most three steps per turn, `reasoning_effort` always set explicitly, a small `max_completion_tokens`.
7. **Reply plan.** The model's text is split into one to three short bubbles on blank lines. Reactions, effects and "stay silent" are expressed as small inline tags the server parses and validates, which costs no extra request. (The alternatives — a second strict-JSON call, or a `respond` tool — each cost another request.)
8. **Actions.** Pushed to the bridge with small pauses between bubbles; the bridge executes and acknowledges.
9. **Ledger.** Record models tried, tokens, cache hits, tools, latency and outcome in one `turns` row.

### Groq key pool, routing and budget

The server holds a **pool** of slots. Each slot is one provider, one key and that account's limits; your three Groq keys are three slots, read from the environment and never stored in the database.

- **One ledger row per key and model.** The server tracks requests and tokens per minute and per day for each pair, because Groq reports no daily token count.
- **Sticky, not round-robin.** The server stays on one key until it is limited, then moves to the next. Groq's prompt cache is assumed to be per account, so hopping every request would throw away free cached tokens.
- **Failover order:** same model on the next key first (same quality), and only when every key is limited for that model, the next model down.
- **What the pool adds:** about three times the daily volume, and three tool-using turns a minute instead of one. It does not raise the 8,000-token ceiling on a single request.
- **Slots are provider-agnostic.** A slot can equally hold another provider's free tier or a Groq paid key with a spend cap, which is the route that does not conflict with Groq's policy.
- **Nothing is added to disguise the rotation.** The pool is plain failover.

| Situation | Behaviour |
|---|---|
| Any text message | `gpt-oss-120b` with the full tool list (ten small local tools). **Changed while building:** the agent saves facts about you unprompted, which needs the tools on every turn; with three keys the extra ~650 tokens a reply is affordable |
| Message contains a photo | `qwen/qwen3.8-27b` — there is no fallback for vision |
| Voice memo | transcode CAF, then `whisper-large-v3-turbo` |
| 429 rate limit | next key for the same model, then the next model; SDK retries switched off so the server decides |
| "Request too large" | shrink the context and retry; do not wait |
| 400 invalid tool call | retry up to twice at lower temperature, then answer without tools |
| A key's daily tokens for a model are spent | skip that key and model pair until reset |
| A key is rejected (401, suspended account) | drop the slot, alert you, carry on with the rest |
| Everything is spent | one honest line with an estimate; commands, reminders and notes keep working |

### Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 26 for both processes | the bridge already runs on it; native TypeScript, `--watch`, `--env-file` |
| Agent loop | a small client of our own on the OpenAI-compatible HTTP API | **changed while building:** the key pool needs the rate-limit headers and error bodies on every response, and any OpenAI-compatible provider then fits a slot with no extra code |
| HTTP | Hono with `@hono/node-server` | small, has SSE helpers, portable |
| Database | SQLite through Node's built-in driver, plain SQL | **changed while building:** no dependency, full-text search included, and synchronous calls keep the per-chat turn logic free of races. Vector search was already ruled out on the 1 GB VM |
| Jobs and scheduling | in-process timers plus `croner`, state in tables | one process, one user; rows outlive timers so restarts are safe |
| Tests | vitest with a fake Groq; later promptfoo for a small golden set | evals spend the same Groq quota as the live agent |
| Hosting | one small cloud VM, two `systemd` services | always on without your laptop; see Hosting below |

Mastra is the natural upgrade if hand-rolled memory becomes a chore: it takes the same Groq model object and keys memory the way Photon's guide recommends.

### Hosting (cloud)

The bridge holds a long-lived outbound connection to Photon, so it needs an always-on machine, not a serverless platform.

| Option | Cost | Fit |
|---|---|---|
| **Google Cloud Always Free `e2-micro`** | $0, but needs a billing account with a card on file | **Recommended.** About 1 GB of memory, enough for both processes with full-text search. Only in `us-west1`, `us-central1` or `us-east1`. Set a budget alert so a misconfiguration cannot bill you |
| Oracle Cloud Always Free (Arm, 2 cores, 12 GB) | $0 | Roomier, but Oracle may reclaim instances it considers idle, and a low-traffic chat agent looks idle |
| Fly.io | from about $2.19 a month | Simplest paid option if $0 can bend |
| Render free, Railway free, Cloudflare Workers | — | Not suitable: Render's free tier sleeps after 15 idle minutes, Railway's free credit is $1 a month, Workers cannot hold the connection |

How it runs on the VM:

- **Two `systemd` services** with `Restart=always`, plus Node 26 and ffmpeg installed on the box.
- **No inbound ports.** The firewall stays closed except SSH with key login; the dashboard is reached over an SSH tunnel.
- **Secrets** (Photon credentials, Groq keys, tool tokens) live in root-only environment files on the VM, never in the repository.
- **Database:** the SQLite file sits on the VM disk and an encrypted copy leaves the VM nightly. Turso's free tier is the alternative if you want the VM to be disposable.
- **Media** (photos, voice memos) is deleted after processing.
- **Deploys restart the server only.** The bridge is restarted only when bridge code changes, because texts sent during a bridge restart are lost.
- **One bridge at a time.** A second bridge on the same Photon project (for example on your laptop) may answer every message twice; this is not tested. Develop against the terminal harness, and use a second Photon project if you need live iMessage in development.
- **External uptime check.** An agent that is down cannot text you that it is down.
- **Memory limit:** a local embedding model will not fit in 1 GB. Memory search stays on full-text search on this VM; embeddings would need the Oracle box or a hosted embedding API.

What moving off the Mac costs: Apple Reminders, Apple Notes, HomeKit through Shortcuts and macOS speech are no longer reachable. Todoist, Notion, iCloud Calendar and Home Assistant cover most of the same ground from the cloud.

Your conversations and the agent's memory will live on that VM, which is a change from keeping them on your own machine.

### Data model (SQLite tables)

`users`, `chats`, `messages` (the inbox journal, unique on event id), `turns` (the ledger), `actions` (outbox and acknowledgements), `usage` (per key and model, per minute and per day), `profile_facts`, `summaries`, `notes`, `reminders`, `tool_cache`, `failures`, `allowlist`, `flags`, `media`.

### Repository layout

```
imessage-agent/
  imessage-chatbot/   existing bridge (its own git repo today)
  agent-server/       new
  protocol/           shared types and zod schemas
  PLAN.md
```

## 4. Phases

| Phase | Goal | Exit criteria |
|---|---|---|
| **0 — Spike and probes** (about a day) | Prove the loop and settle the open questions | A text gets a Groq reply through `POST /v1/turn`; the probe script has answered the table in section 2; line type known |
| **1 — Solid conversationalist** | Something you would keep texting | Bursts get one reply; interrupting works; no duplicate or lost reply across a server restart; `/usage` is accurate across all keys; the terminal harness runs with a fake Groq; both processes are running on the cloud VM |
| **2 — Daily-usable assistant** | Tools, media, memory, reminders | Voice memo, photo and link each get a useful answer; reminders fire; `/memory` and `/forget` work; runs unattended on the VM for a week, with backups and the uptime check in place |
| **3 — Delight** | iMessage-native expression and personal integrations | Effects, polls and tapback feedback in use; calendar connected; dashboard shows quota and recent turns |
| **4 — Ambitious** | Groups, long tasks, other channels | Per feature |

Phase 0 also fixes the bridge: handle `reply` and `group` content, stop awaiting inside the loop, call `app.stop()` on SIGINT/SIGTERM, and import from `spectrum-ts/providers/imessage` (the current import only resolves by accident of hoisting).

## 5. Feature catalogue

**Needs** column: *reg* = on a shared line the recipient must be registered in the Photon dashboard; *ded* = dedicated line only; *Mac helper* = needs a small helper process on a Mac, so it is not available in the cloud deployment. **Groq** column: token cost per use — 0, low, med, high.

### Conversation core

| Feature | What you get | Phase | Groq | Needs |
|---|---|---|---|---|
| Whole-message intake | Swipe-replies and photo-with-caption are understood as one turn | 1 | 0 | |
| Burst debounce | Three quick texts get one considered answer | 1 | 0 | |
| Interrupt and carry forward | A follow-up mid-answer replaces the stale answer | 1 | low | |
| Typing indicator | Shows while it works, disappears if it stays silent | 1 | 0 | |
| Read-receipt timing | Flips to Read when it actually picks the message up | 1 | 0 | |
| Short paced bubbles | One to three bubbles with small pauses, not a wall of text | 1 | low | |
| Tapback acknowledgements | "ok", "thanks", "lol" get a tapback, not a reply | 1 | 0 | |
| Auto-reply and spam guard | Ignores Focus auto-replies; no bot-to-bot loops | 1 | 0 | |
| Rolling conversation memory | Remembers this morning and yesterday, across restarts | 1 | low | |
| Markdown-native formatting | Real bold and lists instead of asterisks | 2 | 0 | |
| Threaded replies | Each answer is attached to the bubble it answers | 2 | low | |
| Working marker | Instant reaction on slow turns, removed when the answer lands | 2 | 0 | |
| Green-bubble fallback | Plain single messages when the other side is on SMS/RCS | 2 | 0 | |
| First-contact onboarding | Short intro, asks your name and time zone, shares its contact card | 2 | low | |
| Personas | `/persona coach`, `terse`, `tutor`, or your own | 2 | 0 | |
| Preferences and quiet hours | Reply length, tone, units, do-not-disturb | 2 | 0 | |
| Style mirroring | Drifts toward your lowercase, length and emoji habits | 3 | low | |

### iMessage-native expression

| Feature | What you get | Phase | Groq | Needs |
|---|---|---|---|---|
| Tapbacks as feedback | 👎 tries again, ❓ explains, ❤️ is remembered | 2 | med | |
| Thumbs-up to confirm | "Remind you Friday 5pm?" — 👍 does it | 2 | 0 | |
| Rich links for sources | Sources and map links arrive as native previews | 2 | 0 | |
| Contact cards in and out | Forward a contact to remember; ask and get a tappable card | 2 | low | |
| Polls as decision buttons | A real iMessage poll when it needs you to choose | 3 | low | |
| Message effects | Confetti for good news, invisible ink for spoilers — rarely | 3 | low | |
| Mirror your effect | Answers a slam or fireworks in kind | 3 | low | |
| Self-correction | Edits or unsends its own bubble instead of piling on | 3 | low | |
| Custom emoji reactions | Beyond the six tapbacks | 3 | low | |
| Growing bubble for long answers | One bubble that updates in place a few times | 3 | 0 | |
| Read-receipt awareness | Does not stack messages on an unread thread | 3 | 0 | |
| Left-on-read nudge | One light follow-up if you read but did not answer | 3 | med | reg |
| Live status card | A long job shows as one card that updates in place | 4 | 0 | |

### Understanding what you send

| Feature | What you get | Phase | Groq | Needs |
|---|---|---|---|---|
| Voice memo in | Talk instead of typing; answered like a text | 2 | low | |
| Voice translation | A memo in another language comes back in English | 2 | low | |
| Photo and screenshot understanding | Ask about a menu, receipt or error screen | 2 | high | |
| Send a link, get the gist | Five-line summary, then follow-up questions | 2 | med | |
| PDF and document digests | Key points, dates and amounts from a file | 2–3 | high | |
| Snap to action | Photograph a flyer → "Add to calendar?" | 3 | med | |
| Voice journal | Nightly memo filed as an entry; weekly reflection | 3 | med | reg |

### Memory

| Feature | What you get | Phase | Groq | Needs |
|---|---|---|---|---|
| Rolling summaries | Old conversation folded into a short running summary | 2 | low | |
| Personal profile | Tell it once you are vegetarian; it acts on it | 2 | med | |
| Inspect and erase | `/memory`, `/forget`, `/export` | 2 | 0 | |
| Recall search | "What was that ramen place I mentioned in August?" | 2 | med | |
| People memory | "This is my plumber" → later "send me the plumber's number" | 3 | low | |
| Per-group memory and persona | Each group has its own summary and tone | 4 | med | |

### Tools

| Feature | What you get | Phase | Groq | Needs |
|---|---|---|---|---|
| Utility pack | Exact maths, time zones, units, currency, QR codes | 1–2 | med | |
| Weather | "Do I need an umbrella?" (Open-Meteo, no key) | 2 | med | |
| Quick facts | Wikipedia lookups | 2 | med | |
| Web search with sources | Groq's built-in search if it works on a free key, otherwise Tavily (1,000/month) | 2 | med | |
| Notes and lists | "Add oat milk to shopping" | 2 | low | |
| Calendar | "What's on tomorrow?", add events after you confirm | 3 | med | Google OAuth or iCloud |
| Inbox triage | "Anything important in my email?"; drafts sent only on approval | 3 | high | Gmail OAuth |
| Smart home | "Turn off the living room lights" | 3 | med | Home Assistant reachable from the VM |
| Apple Reminders and Notes sync | Items also appear in Apple's apps | 4 | low | Mac helper |
| Todoist or Notion sync | Same, with a static token | 3 | low | |
| Image replies | "Draw a birthday card" (Cloudflare Workers AI, about 170 a day free) | 3 | 0 | |
| Spoken replies | A short voice bubble | 3 | low | |
| Ready-made tool servers (MCP) | Add GitHub, Notion, Home Assistant and others with little code | 3 | med | filter tools to fit the budget |
| Long tail | Crypto, stocks, sports fixtures, Hacker News, GitHub | 3+ | med | |

### Proactive — the agent texts first

| Feature | What you get | Phase | Groq | Needs |
|---|---|---|---|---|
| Reminders | "Remind me Friday 5pm to call the bank"; recurring too | 2 | low | reg |
| Tapback to finish, reply to snooze | 👍 marks done, "1h" snoozes | 2 | 0 | reg |
| Morning briefing | Weather, calendar, due reminders in one message | 3 | low | reg |
| Watchers | "Tell me if it will rain before my 6am run" | 3 | low | reg |
| Habit tracker | Daily check-in; 👍 logs it; streaks | 3 | 0 | reg |
| Follow-up check-ins | Asks how Thursday's interview went — once | 3 | med | reg |
| Texted usage reports | Morning digest of turns, tokens, failures | 3 | 0 | reg |

### Budget and reliability

| Feature | What you get | Phase | Groq | Needs |
|---|---|---|---|---|
| Key pool | Three Groq keys (or other providers) behind one router | 1 | 0 | see the policy flag in section 7 |
| Usage ledger | Knows what each key and model has left today; survives restarts | 1 | 0 | |
| Fallback chain | A rate-limited key is replaced by the next key, then the next model | 1 | 0 | |
| Error handling by class | Each Groq failure gets the right reaction, not a blind retry | 1 | low | |
| Per-model queue | Two people in the same minute are answered in turn | 1 | 0 | |
| Context budgeter | Replies never bounce off the per-minute ceiling | 1 | 0 | |
| Honest rate-limit notices | "Back in about 40 seconds", said once | 1 | 0 | |
| Inbox journal, per-chat dispatch | Nothing processed twice; one slow chat blocks no other | 1 | 0 | |
| Graceful shutdown | A restart never cuts a reply in half | 1 | 0 | |
| Cache-stable prompt prefix | The fixed part of the prompt is reused free; can double capacity | 2 | 0 | |
| Tool-result cache | Weather asked twice in ten minutes is not re-fetched | 2 | 0 | |
| Per-user fair shares | One chatty contact cannot spend everyone's day | 2 | 0 | |
| Send outbox with pacing | No repeats after a crash; stays inside Photon's limits | 2 | 0 | |
| Send-error-aware pacing | Collapses remaining bubbles if the line pushes back | 2 | 0 | |
| Downtime-gap detection | Tells you which window may have lost messages | 2 | 0 | |
| Brownout ladder | Leaner as the budget drains: fewer tools, shorter, smaller model | 3 | 0 | |
| Catch-up after downtime | Answers what it missed | 4 | 0 | uses an unsupported internal API |

### Safety, privacy and access

| Feature | What you get | Phase | Groq | Needs |
|---|---|---|---|---|
| Sender allowlist with pairing codes | Only approved people get answers | 1 | 0 | |
| Secrets split, signed local protocol | A server bug cannot leak iMessage credentials | 1 | 0 | |
| Injection filter | Poisoned web pages and emails are screened on a separate free bucket | 2 | 0 | |
| Confirm before acting | Reads freely; asks before anything with side effects | 2 | 0 | |
| Circuit breaker and kill switch | A flood or loop is muted; one text stops everything | 2 | 0 | |
| Outbound guard | No keys, system prompt or forty-bubble replies leave | 2 | 0 | |
| Attachment hygiene | Size and type limits with a clear message | 2 | low | |
| Retention windows | Old data ages out by default | 2 | 0 | |
| Minimal-PII logs | Useful logs that are not a second copy of everyone's messages | 2 | 0 | |
| Owner-approval draft mode | You approve replies to new contacts from your own phone | 4 | 0 | reg |

### Admin, development and operations

| Feature | What you get | Phase | Groq | Needs |
|---|---|---|---|---|
| Slash commands | `/help`, `/usage`, `/reset`; later `/model`, `/pause`, `/allow`, `/debug` | 1–2 | 0 | |
| Turn ledger | Any turn can be reconstructed later | 1 | 0 | |
| Terminal harness with fake Groq | Develop with no iMessage and no quota spend | 1 | 0 | run in its own process — it takes over the console |
| Boot self-check and free-tier probe | Reports what works on this plan and machine | 0–1 | low | |
| Failure log | Nothing fails silently; failed items can be retried by hand | 2 | 0 | |
| Feature flags, hot reload | Switch models, tools and prompts without restarting | 2 | 0 | |
| Cloud deployment | Both processes start on boot and restart on crash | 1 | 0 | |
| Backups | A lost or reclaimed VM costs at most a day of memory | 2 | 0 | |
| Heartbeats and uptime check | You find out when either process stalls, or the whole VM | 2 | 0 | reg for texted alerts; the uptime check is external |
| Local dashboard | Quota gauges, recent turns, failures, allowlist | 3 | 0 | |
| Record and replay | Re-run real conversations against a new prompt for free | 3 | 0 | |
| Eval suite | A small golden set before a prompt or model change ships | 3 | med | |
| Hosted tracing | Langfuse free tier, when SQL over the ledger is not enough | 3 | 0 | |
| Model deprecation watcher | Warns before Groq removes a model you depend on | 4 | low | |
| Capacity forecaster | Moves background work to hours when nobody is texting | 4 | 0 | |
| Other providers in the pool | Slots filled by another provider's free tier, or Groq's paid tier under a hard cap | 2–4 | 0 | |

### Multi-user, groups and other channels

| Feature | What you get | Phase | Groq | Needs |
|---|---|---|---|---|
| Multi-user isolation and invites | Family and friends each get private memory and a fair share | 2 | 0 | reg (Free allows 10 users) |
| Group etiquette | Speaks only when addressed; otherwise at most a tapback | 3–4 | med | untested on a shared line |
| Group lifecycle awareness | Says hello when added, notices renames | 4 | low | ded |
| Agent-created groups | Starts a planning chat with a name and an opening poll | 4 | low | ded |
| Commitment catcher | Files "I'll book the cab" and can post who owes what | 4 | high | ded |
| Household relay and shared lists | "Tell Priya dinner's at 8" | 4 | low | reg |
| Other channels | The same agent on WhatsApp, Telegram or Slack | 4 | 0 | provider packages already installed |

### Blocked today

Reacting to your edits, your unsends, or the fact that you are still typing. Cloud iMessage in 12.10.1 does not deliver any of the three.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Groq shrinks the free tier again | Model IDs in config, `/v1/models` check at boot, provider-agnostic loop; Groq's paid tier is about $0.14 a day for 100 tool-using replies |
| The only vision model is a preview model | Treat photo understanding as best-effort; Gemini's free tier is a fallback, but Google uses free-tier content to improve its products |
| Bridge downtime loses messages | Keep the bridge tiny; gap detection in phase 2; catch-up in phase 4 |
| A crash mid-send duplicates a bubble | Outbox that prefers a missing bubble over a repeated one |
| Anyone who learns the number can spend your budget | Allowlist from phase 1 |
| Tools act on text the agent merely read | Injection filter and confirm-before-act from phase 2 |
| Groq suspends the accounts for multi-account use | Dead keys are dropped from the pool without stopping the agent; pool slots can be switched to other providers or a paid key by config |
| The VM goes down or is reclaimed | `systemd` restarts, external uptime check, nightly off-VM backup; the VM is rebuilt from the repository and the backup |
| A free cloud tier bills you by accident | Budget alert on the cloud account; stay inside the free machine type, region and disk size |
| Personal messages and memory sit on a cloud VM | Disk encryption, SSH keys only, no inbound ports, media deleted after processing, retention windows |
| A laptop bridge and the cloud bridge both answer | Only one bridge per Photon project; develop on the terminal harness |

## 7. Decisions for you

1. **Three Groq accounts.** The plan builds the key pool you asked for. Before approving, weigh that rotating between accounts to get past limits is prohibited by Groq's acceptable-use policy, and that Groq logs requests to investigate rate-limit circumvention; the realistic cost is all three accounts being suspended. Two ways to get the same capacity without that risk: fill the extra slots with other providers' free tiers, or put one Groq key on the paid tier (about $0.14 a day for 100 tool-using replies). Which do you want in the pool?
2. **Photon line.** Shared (Free or Pro) or dedicated (Business)? Run `photon spectrum lines list`. On a shared line, register yourself as a project user in the Photon dashboard or reminders cannot reach you.
3. **Who uses it.** Just you, or family and friends too? This decides whether fair-share quotas and invites are phase 1 or phase 2.
4. **Which cloud host.** Google Cloud's free `e2-micro` is the recommendation and needs a card on file. Oracle's free tier is roomier with a reclaim risk. Fly.io is about $2 a month with the least fuss. Which one?
5. **Which integrations first.** Calendar, email, smart home, Todoist or Notion — pick one or two for phase 3. Apple Reminders and Notes are out of reach from the cloud.
6. **Telemetry.** Keep sending trace data (including contacts' phone numbers inside chat identifiers) to Photon, or turn it back off?
7. **Repository.** Make `imessage-agent/` one repository holding the bridge, the server and the shared protocol, or keep the bridge's own git repo separate?

## 8. Sources

Dated claims above were read from these on 2026-10-08; re-check them before relying on a number.

- Groq limits and models: `console.groq.com/docs/rate-limits`, `/docs/models`, `/docs/deprecations`, and your own `console.groq.com/settings/limits`
- Groq features: `console.groq.com/docs/tool-use/overview`, `/docs/structured-outputs`, `/docs/vision`, `/docs/speech-to-text`, `/docs/prompt-caching`, `/docs/reasoning`
- Groq terms and data: `console.groq.com/docs/legal/services-agreement`, `/docs/legal/ai-policy`, `/docs/your-data`
- Photon plans and quotas: `photon.codes/pricing`, `photon.codes/docs/webhooks`, `photon.codes/docs/spectrum-ts`
- Cloud hosts: `docs.cloud.google.com/free/docs/free-cloud-features`, Oracle Cloud's Always Free documentation, and the Fly.io, Render and Railway pricing pages
- Spectrum behaviour: the installed code in `imessage-chatbot/node_modules/@spectrum-ts/imessage/dist/index.js` and `@spectrum-ts/core/dist/index.js` (version 12.10.1)
- Package versions: `npm view` for `ai`, `@ai-sdk/groq`, `groq-sdk`, `hono`, `@libsql/client`, `drizzle-orm`

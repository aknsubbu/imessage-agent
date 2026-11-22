<img src="assets/logo.svg" width="72" align="right" alt="imessage-agent logo">

# Security

This is a personal project that texts on your behalf, so the useful questions are what it will and won't do for a stranger, a hostile web page or a hostile message. The design is in [PLAN.md](PLAN.md#safety-privacy-and-access); this file records what is checked and what is knowingly left open.

## What is enforced

- **Who can talk to it.** Only allow-listed senders reach the model. Strangers are ignored.
- **The two processes.** Every request from the bridge to the server is signed with HMAC-SHA256 over a timestamp and the body, with a five-minute window and a constant-time comparison. Each route also refuses to run unless the signature check passed. The server binds to `127.0.0.1` by default, and a request body over 1 MB is refused before it is read.
- **Web content is untrusted.** The page fetcher refuses non-public addresses at connect time on every redirect, including IPv6 forms that wrap an IPv4 address (IPv4-mapped, NAT64, 6to4, Teredo), credentials in a URL and unusual ports. Page text is parsed in one linear pass with a size cap, so a hostile page cannot stall the server. Once web text is in a turn, every tool that saves, schedules, deletes or reaches the internet is refused until the next message, and only links the person wrote can be opened.
- **Private by chat type.** Briefings, check-ins, the Sunday review and event follow-ups are only sent to one-on-one chats, whichever chat a goal or setting came from.
- **Secrets.** `.env` files are git-ignored and the deploy script refuses to start without the required values. Todoist and Notion stay off unless named in `INTEGRATIONS` with a token.

## Known and accepted

- **OpenTelemetry advisories in the bridge (moderate).** `npm audit` reports 18 moderate findings in `@opentelemetry/*`, reached through Photon's `spectrum-ts`. The only fix `npm audit` offers is `spectrum-ts@4.2.0`, an older major version that would break the bridge. They concern unbounded memory in baggage propagation, which needs a hostile peer; the bridge talks only to Photon. Revisit when Photon updates its dependency.
- **The bridge has no automated tests**, so SDK upgrades are done by hand against a live line. The high-severity advisories (`undici`, `zod`) were fixed by patch bumps only; `spectrum-ts` was deliberately left at its current version.
- **A shared Photon line** means Photon's cloud sees message content, as with any hosted iMessage bridge.

## Reporting

Open a private security advisory on the GitHub repository, or message the maintainer directly. Please don't open a public issue for a vulnerability.

# 0007. Security: operator token, signed links, no actor front doors

Status: accepted · Since: 0.1.1 · Revised: 0.1.2, 0.2.0, 0.3.0

## Context

The function's URL is public: it's in every email (feedback links, icons). In 0.1.0 anyone with the URL could start digests (emailed to the configured recipients) or read conversation state, including the vote log. 0.1.1 required a token for RPC, but the runtime still streamed state to callers it granted no claims; 0.1.2 closed that in our class. The digests page (0.3.0) then needed a way for a person, not a script, to sign in.

## Decision

- **Three kinds of access, nothing else:**

| Who | How | For |
|---|---|---|
| Anyone | no credentials | `/v1/health`, icons |
| A reader with a link | HMAC-signed link (`FEEDBACK_KEY`), with expiry | thumbs, reasons, an issue's web view |
| The operator | `Authorization: Bearer <hex HMAC-SHA256(AGENT_AUTH_KEY, "telnyx-acp operator")>` | the `/v1` API: definitions, runs, status |
| The admin, in a browser | magic link emailed to `ADMIN_EMAIL` (once, 15 minutes, at most one a minute), then a signed `HttpOnly; Secure; SameSite=Lax` session cookie for 30 days | the read-only digests page |

- **The operator token is derived, not stored**: the key never crosses the wire, and it matches what the `telnyx-acp` CLI sends.
- **Page keys are derived from `AGENT_AUTH_KEY`** per purpose ("magic", "session"), so the page needs no new secret, and rotating the key signs every browser out.
- **Actors have no public route** (0.2.0, 0001): the router calls them in-process; the only request forwarded to an actor is the signed feedback page, and the actor checks the token itself for anything else (defence in depth).
- **Secrets never on a command line**: the deploy stores them through `POST /v2/compute/secrets` with the value in the body; `.env` is git-ignored; the repo has no account data (AGENTS.md rules).
- **User text never becomes configuration**: a one-off topic is cleaned to one line and only fills placeholders after the template is parsed (0009).

## Alternatives

- **The platform's own auth only.** In the beta it admitted every caller to RPC.
- **Passwords for the page.** Another secret to manage and leak; the admin already has an inbox.
- **API keys per caller.** One operator today; the derived token is enough and rotates with one setting.

## Consequences

- Changing `FEEDBACK_KEY` breaks links in emails already sent, so the deploy never rotates it.
- A leaked operator token allows starting runs (emails to the configured recipients) and reading definitions, not reading votes or memory over HTTP.
- The sign-in email is sent by the `digests` actor right after the response (0.4.2), so the page answers quickly; see 0008 for why its link needs `PUBLIC_URL`.

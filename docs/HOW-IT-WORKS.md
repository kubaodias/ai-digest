# How AI Digest works

## The pieces

| Piece | Runs on | Code |
|---|---|---|
| The function and its API | Telnyx Edge Compute, shipped with `telnyx-edge` | `src/index.ts`, `src/router.ts` |
| Digest definitions | The `digests` actor (durable state) | `src/profile.ts`, `src/agent.ts` |
| Research and writing | Telnyx Inference (`deepseek-ai/DeepSeek-V4.1-Flash`) with Telnyx Web Search (`web_search`, `fetch_page`) | `src/instructions.ts`, `src/agent.ts` |
| Runs | One actor per issue, named `<digest>--<run>` | `src/agent.ts` |
| Picking pictures | Telnyx Inference (`Qwen/Qwen3.8-27B`, vision) | `src/images.ts` |
| Delivery | Telnyx Email (`POST /v2/emails`) | `src/agent.ts` |
| Feedback | The `feedback` actor: votes and sent issues | `src/feedback.ts`, `src/preferences.ts` |
| Preference summary | Telnyx Agent Memory (namespace `ai-digest`, one profile per digest) | `docs/memory-summary-instructions.md` |

The agent class extends the managed agent loop from `@telnyx/acp` (harness, tools, durable state). The function has its own entry point: the router is the only HTTP surface, and actors are only called in-process.

## The API (v1)

| Route | Who | What |
|---|---|---|
| `GET /v1/health` | anyone | `{"ok": true, "version": …}` |
| `GET /v1/assets/thumb-up.png`, `thumb-down.png` | anyone | Icons for emails and pages |
| `GET /v1/feedback?p=…&s=…` | signed links | A thumbs click or reason: records the vote, shows the feedback page |
| `GET /v1/feedback?view=…&s=…` | signed links | A sent issue's web view |
| `GET /v1/digests` | operator token | Stored digests (id, title, window, items, schedule, versions) |
| `GET /v1/digests/<id>` | operator token | One definition (Markdown) |
| `PUT /v1/digests/<id>` | operator token | Store a definition (body: Markdown); validated, the last 10 versions kept |
| `DELETE /v1/digests/<id>` | operator token | Delete a definition (its issues, votes and memory stay) |
| `POST /v1/digests/<id>/runs` | operator token | Start an issue: `{"message"?: "focus for this issue", "run"?: "name"}` → `202 {"conversation": …}` |
| `GET /v1/runs/<conversation>` | operator token | The conversation's recent runs: `{"runs": [{status, durationMs, toolCalls, tokens, …}]}` |
| `GET /v1/app`, `/v1/app/digests/<id>` | session cookie | The digests page (read-only) |
| `GET`/`POST /v1/app/sign-in`, `GET /v1/app/auth?t=…`, `GET /v1/app/sign-out` | anyone | Magic-link sign-in: email a link (at most one a minute), use it (once, 15 minutes), sign out |
| `GET /agents/ai-digest/feedback?…` | signed links | Same as `/v1/feedback`, for emails sent before 0.2.0 |

The operator token is `Authorization: Bearer <hex HMAC-SHA256 of "telnyx-acp operator", keyed with AGENT_AUTH_KEY>` (`src/auth.ts`); `npm run digests` sends it. Errors are JSON: `{"error": …, "message": …}`.

## A digest, step by step

1. **A run starts:** `npm run digests -- run agent-memory` → `POST /v1/digests/agent-memory/runs`. The router loads the definition, builds the request from it (`runMessage` in `src/profile.ts`: title, time window, item range, closing section, the description, and any focus for this issue) and hands it to a new actor, `agent-memory--<run>`.
2. **Preferences:** the model calls `reader_preferences` first. It returns *this digest's* entity, topic and source preferences from the vote log, plus the summary of its Agent Memory profile (named after the digest). It asks the memory service to rebuild a stale summary and waits up to a minute for it.
3. **Research:** up to about 25 `web_search` and `fetch_page` calls, 3–5 in parallel, starting from the sources the definition names. The instructions require items found in this run, inside the window, links to the specific article (never a front page), and primary sources over reposts.
4. **Writing:** numbered items (`## N. Headline`, *Why it matters*, *Source*) within the item range, and the closing section the definition names (or none).
5. **Delivery is deterministic.** The model has no email tool. When a run completes, the agent's post-run hook (`rememberRun`) checks whether the reply is a digest, i.e. it has numbered `## N.` items. If so, it reads the digest's definition again and:
   - picks pictures (below), judged for the reader the definition describes (unless `images: off`);
   - adds a feedback row to each item and tags each item with topics and entities (one text-only Qwen call);
   - renders an email-safe HTML version (inline styles; images as captioned blocks);
   - sends it through `POST /v2/emails` with `text_body` (the Markdown) and `html_body`, to the definition's `to:` or else `DIGEST_EMAIL_TO`;
   - stores the issue (digest id, items, article URLs, tags, pictures, HTML) with the `feedback` actor, keeping the newest 12;
   - records `emailedAt`, so a retried hook doesn't send twice.

   The sender, default recipients and public URL come from secrets (`src/config.ts`), never from the model.

## Picking pictures

For each item, `src/images.ts`:

1. **Finds the article.** It uses the first non-HN link; HN threads are followed to the story via the HN API.
2. **Collects candidates from the article body** (the largest `<article>`, else `<main>`), best first:
   - figures with a caption or descriptive alt text;
   - in-body images with descriptive alt text;
   - other figures and images;
   - the `og:image` share image last, since it's usually a branded banner.

   Logos, icons, avatars, "card image" teasers and tracking pixels are skipped. Up to 6 candidates.
3. **Fixes URLs:**
   - SVG diagrams are converted to PNG when the host can render one; Contentful's image API does it with `fm=png`, e.g. OpenAI's diagrams. Other SVGs are dropped, because Gmail doesn't render SVG.
   - GitHub's signed `private-user-images` links expire in 5 minutes, so they're rewritten to the permanent `github.com/user-attachments/assets/<id>`. Other signed, expiring links are dropped.
4. **Checks the shape from the image header:** at least 500 px wide, and not taller than wide.
5. **Asks Qwen3.8** to score each one 0–10 for how much it helps an engineer understand *this* item: charts, diagrams and screenshots score high; stock, logos and banners score low. Qwen reasons by default and can spend the whole token budget before answering, so the request sets `reasoning_effort: "none"`; it then answers in about a second.
6. **Keeps up to 2 pictures scoring 7 or more**, with a short caption: the page's own caption, or the model's one-sentence description.

The whole step has a 75-second budget. Items whose articles fail, or have nothing relevant, simply get no picture.

## Feedback

### The links

Each item ends with **Useful? 👍 👎**. The grey icons are served by the agent itself. A link carries a signed payload, HMAC-SHA256 with the `FEEDBACK_KEY` secret:

```
{ d: digest id, i: item number, v: "up" | "down", e: expiry (90 days), r?: reason, x?: entity index }
```

Links are about 170 characters, because the item's details stay on the server, in the stored digest. A click is a `GET` to the agent's `feedback` conversation. The actor checks the signature and expiry, records the vote, and returns a page showing:

1. the article title, linked;
2. the vote, with reason options to toggle, plus change, undo and *View the digest* (the stored email);
3. the article's summary, picture, source, entities and tags;
4. *What this feeds*: one sentence on what the vote changes, and your current preferences for this item's entities and topics.

Clicking a reason, change or undo updates the page in place and replaces its history entry, so one Back returns to the email.

### Reasons

A thumb alone doesn't say *why*. The 👎 page offers:

- **I don't use *X***: one option per entity, since an item about Postman also mentions Codex and Claude Code;
- **Not interested in *topics***;
- **I already knew this**.

The 👍 page offers *More on topics*, *More about X* and *X is a good source*. Any number can be selected, and clicking a selected one deselects it. Clicking the same thumb again keeps them; flipping 👍/👎 clears them.

### Per digest

Votes, preferences and memory belong to one digest. A vote is tagged with its issue's digest, `reader_preferences` only counts that digest's votes, and each digest has its own Agent Memory profile. Liking retrieval papers in *agent-memory* doesn't change *ai-swe*. Votes from before 0.2.0 count toward `ai-swe`.

### From votes to preferences (`src/preferences.ts`)

Each vote adds weight toward the item's main entity (or the entity you picked), its other entities, its topics and its source:

| Reason | Main or chosen entity | Other entities | Topics | Source |
|---|---|---|---|---|
| none | 0.7 | 0.2 | 0.25 | 0.1 |
| I don't use X / more about X | 1 (that entity) | 0 | 0 | 0 |
| not interested / more on topics | 0.3 | 0 | 1 | 0 |
| good source | 0 | 0 | 0 | 1 |
| already knew | 0 | 0 | 0 | 0 |

With several reasons on one vote, each entity, topic and source takes the strongest weight any of them gives it, so nothing is counted twice.

- **An entity** becomes a preference from one vote (score ≥ 0.7).
- **A topic** needs a score of 0.75 *and* either an explicit topic reason or 3 votes the same way. Until then it's listed as *tentative* and ignored. One 👎 on a Postman story means "skip Postman", not "less dev tooling".
- **A source** needs an explicit reason or many votes.

The model is told to apply entity preferences strictly, topic preferences softly, ignore tentative topics, and never drop major news because of a preference.

### Agent Memory

Each vote also writes sentences to [Agent Memory](https://developers.telnyx.com/docs/agent-memory) (namespace `ai-digest`, profile named after the digest, e.g. `agent-memory`; session `fb-<issue>-<item>`), one per reason, e.g. *"I don't use Postman — skip news mainly about Postman. This says nothing about the wider topic."* Changing a vote re-ingests the same session in place.

Undo deletes the memory source, and again two minutes later: ingestion is asynchronous, so a memory still being extracted could otherwise land after the first delete.

The memory service turns these into a profile summary. Two details matter:

- **It only builds the summary when asked** (`GET …/summary?refresh=true`). A plain read of a stale summary returns `null` and builds nothing. `reader_preferences` asks, and waits.
- **The summary's shape is set by namespace instructions** (`PATCH /v2/ai/memory/namespaces/ai-digest/settings`). [Ours](memory-summary-instructions.md) restricts it to *Wants more of / Wants less of / Sources / Patterns* and rules out identity, location and remarks about the data itself.

The vote log is the source of truth. The memory summary is a softer, readable view of it.

## What's stored where

| Data | Where | Kept |
|---|---|---|
| Your settings (sender, default recipients, URL, signing and operator keys) | Telnyx secrets on your account; locally in `.env` | until you change them |
| Digest definitions | The `digests` actor's durable state (and your git-ignored `digests/`) | last 10 versions each |
| Votes (with digest, reasons, entities, tags) | The `feedback` actor's durable state | until undone |
| Sent issues (items + email HTML) | The `feedback` actor's durable state | newest 12 |
| Preference sentences and profile summaries | Agent Memory, namespace `ai-digest`, one profile per digest | until deleted |
| Research conversations | Each run's actor | per the platform |
| The function's id and URL | `.edge/function.json` (git-ignored) | until you delete it |

Nothing is kept outside your Telnyx account and your machine. The agent never writes conversations to memory; the only memory writes are the feedback sentences.

## Security notes

- **One HTTP surface.** The function's entry point routes every request; actors are only called in-process. Their own front doors (state streams, RPC) aren't reachable from outside, and the agent class refuses them without the operator token as a second line.
- **The operator token** guards everything that changes or reveals data: managing digests, starting runs, run status. It's derived from `AGENT_AUTH_KEY`, which lives only in your `.env` and Telnyx secrets; the key itself never crosses the wire.
- **The digests page** signs in by magic link: a signed token (HMAC-SHA256, purpose "magic", 15 minutes) emailed to `ADMIN_EMAIL` or the first `DIGEST_EMAIL_TO`, usable once (its nonce is recorded by the `digests` actor), at most one sent per minute. Using it sets a signed session cookie (purpose "session", 30 days, `HttpOnly; Secure; SameSite=Lax; Path=/v1/app`). Both keys are derived from `AGENT_AUTH_KEY`. The page is read-only and `noindex`.
- **Feedback links** are signed (HMAC-SHA256 with `FEEDBACK_KEY`) and expire after 90 days. Without the key, nobody can forge votes. The feedback pages are `noindex` and `no-store`.
- **The model can't choose who gets email:** recipients come from the digest's definition (stored privately on your function) or a secret.
- **Your digests stay private:** `digests/` is git-ignored, and definitions are stored on your own function.

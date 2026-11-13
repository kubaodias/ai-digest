# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.2] - 2026-11-13

### Fixed

- Editorial illustrations no longer illustrate items. A cartoon of a hand with a Goldman Sachs cufflink unplugging a device labelled "Claude Code" passed as a picture of the subject, because it showed the product's name. Pictures credited as illustrations, photo illustrations or cartoons are no longer candidates; the vision model scores commissioned art as decorative and can call it an `illustration`; and illustrations, stock photos and logos are never shown, whatever their score.
- Picture captions say what the picture tells the reader (the numbers, structure or interface it shows) instead of describing how it looks.

## [0.6.1] - 2026-11-10

### Fixed

- Checks and issues of different digests no longer run at the same time, which crashed the runtime (two checks started by hand within seconds of each other took both down, and the actors froze for about 10 minutes). They take turns through a lease held by the `digests` actor: a run that finds it taken waits and asks again within 1–2½ minutes, a check hands it to the issue it starts, and a run that crashes loses it after 10 minutes.

### Changed

- Tests use a neutral example address (`kim.reader@example.com`).
- The example Agent Memory digest describes its sources by kind (frameworks and services, new open-source projects, research, discussion), with names only as examples, and asks for projects it hasn't seen before, so newcomers aren't missed because the list didn't name them.

## [0.6.0] - 2026-11-09

### Added

- The `ai-digest` command (`npm link` once): `ai-digest list`, `run`, `watch`, `pool`, `ask`, `deploy`, `release` and the rest, from any folder, instead of `npm run digests -- …`; `ai-digest help` lists them. The npm scripts still work. Docs, CLI messages and the digests page use the new form.

### Changed

- The example Agent Memory digest is titled "Agent Memory — {range}" instead of "Agent Memory Weekly": a watching digest goes out when there's enough to read, not on a weekly beat.

## [0.5.1] - 2026-11-09

### Changed

- **Renamed to watching**, with no old names kept: the setting is `watch: 6h`; one look for new stories is a **check**, run in `<digest>--check-<time>`; `POST /v1/digests/<id>/check` starts one (`npm run digests -- watch <id>`); `"check": false` on a run writes from the pool (`npm run digests -- run <id> --from-pool`); a run's `mode` is `check-then-write`, a digest that doesn't watch answers `not_watching`; responses have `watch`, `watching`, `checks`, `lastCheckAt`, `nextCheckAt`, `checkRunning`; the digests page shows a "Watching" card; the design is [spec 0010](docs/spec/0010-watching.md). A pool from 0.5.0 keeps its stories but not its timer or counters: put `watch:` in the definition and push it to arm the new timer. The 0.5.0 entry below uses the new names.
- README: watching in the definition example, the commands, the diagram and the project layout.

### Fixed

- A run can't be named `pool`, `check-…` or `issue-…` any more (`--run`, `"run"`): those are a watching digest's own conversations, so such a run reached the pool actor or got a check's tool budget. It gets the time-based name instead.
- A one-off digest whose topic starts with "check" or "issue" (`ask "Check Point …"`) no longer gets a check's or an issue's web tool budget.

## [0.5.0] - 2026-11-09

### Added

- **Watching digests** ([spec 0010](docs/spec/0010-watching.md), phase 1). A digest with `watch: 6h` (1h–24h) runs a short research check at that interval and keeps what it finds in a candidate pool; an issue goes out when `send_at` stories score at least `strong` (and `min_gap` has passed), or at `max_gap` at the latest with whatever the pool holds (an empty pool sends a short "nothing new" note). Defaults: `send_at` = the lower bound of `items`, `strong: 7`, `min_gap: 2d`, `max_gap: 7d`.
- **The pool** merges stories by canonical URL (or a model-suggested match that shares an entity or most title words), counts independent sources and repeat sightings (checks report known stories they see again), and scores them by importance, corroboration, sightings, primary source, your feedback (a product you don't use drops a story) and age. Stories older than the digest's `window` expire.
- **Issues** are written from the chosen stories only, without new searching; pictures are picked at that point, never during checks. Stories the writer drops return to the pool. The title's date range comes from the stories' publication dates ("November 4–7, 2026").
- **Quality and variety:** forced and `max_gap` issues leave out stories scoring below 5 unless none reach it; a check adds at most 2 candidates about the same product and searches news and communities, not only release notes; an issue takes at most 2 stories about the same product (the rest wait for the next one) and merges consecutive releases into one item.
- **Several sources per story:** checks report the other outlets covering a story; issues list up to 3 sources per item (the maker's page first, then reporting, then discussion; no link roundups; the writer looks for the maker's page when a story only has write-ups) and call a story widely covered only from 4 independent sources; the writer never mentions stories it dropped.
- **Hard budgets:** a check may make 8 web tool calls and an issue's writer 3 link checks and no searches, enforced in code (calls over budget are refused and the model answers with what it has).
- **Timers** are spread out (the first check 1–16 minutes after watching is turned on, then every interval ± 10 minutes) and kept across deploys, so checks of different digests rarely run at the same time.
- **Robustness:** a check's candidates reach the pool through a durable, retried task; a check whose reply never arrived (e.g. after a runtime restart) is re-delivered or given up the next time a check is due; requests that start checks or issues return at once. Deleting a digest stops its timer and empties its pool.
- `GET /v1/digests/<id>/pool`, `POST /v1/digests/<id>/check` (`since`/`until` replay a past window, `decide: false` only fills the pool); `npm run digests -- pool <id>`, `watch <id> [--since] [--until] [--no-send]`, `run <id> [--from-pool]`; a watching card on the digests page.
- `docs/spec/`: decision records for the choices made so far (own entry point and v1 API, deterministic email, digest files, feedback and preferences, Agent Memory, pictures, security, public URL and custom domains, the General digest and shared preferences) and the watching design.

### Changed

- `POST /v1/digests/<id>/runs` on a watching digest runs a check and then writes from its pool (`"check": false` writes from the pool right away).
- Storing a definition (`PUT`, so every `npm run digests -- push` and deploy) arms, re-arms or cancels its watch timer; the response includes `watching`.
- `GET /v1/digests` returns `watch` (the settings or null) instead of `schedule`.
- Source lines say "Sources:" before several links and "Source:" before one, in every digest.
- `npm run deploy` and the other scripts retry Telnyx API calls that are rate limited (429), which happened when a deploy stored its secrets.
- The screenshot fixture moved from `docs/fixtures/` to `scripts/fixtures/`, next to `npm run screenshots`, its only user.

### Fixed

- Pictures: the same picture served at several sizes (`chart-medium.jpg`, `chart-small.jpg`, `chart-1024x576.png`) or under two names with the same shape in one folder is shown once; an article's share image (og/twitter) is used only when it has no picture of its own, since it usually repeats the main figure; and a picture is never repeated in a later item of the same issue.
- `GET /v1/runs/<conversation>` answers 400 for a name that isn't a conversation instead of passing it to an actor (which failed with a 500).

### Removed

- The `schedule:` setting (never active). A file that still has it gets an error pointing to `watch:`.

## [0.4.2] - 2026-11-09

### Fixed

- On a custom domain, sign-in links (and the feedback page's links) pointed to the function's `*.telnyxcompute.com` address: requests reach the function with that host. With `PUBLIC_URL` set, links are now built from it.
- "Email me a sign-in link" waited for the email API before answering. The `digests` actor now sends the email right after the request returns (an immediate scheduled call), with a direct send as the fallback.

### Changed

- The masked address on "Check your inbox" shows the first and last character with a fixed number of stars (`k*****t@example.com`), so the length stays hidden.

## [0.4.1] - 2026-11-09

### Fixed

- The 0.4.0 memory summary instructions were over Agent Memory's 2000-character limit, so `npm run deploy` failed at its last step (`422 … at most 2000 characters`). Shortened, and a test now checks the limit.

## [0.4.0] - 2026-11-09

### Added

- **One-off digests on any topic:** `npm run digests -- ask "<topic>" [--window 14d] [--items 5-8] [--run name]`, or `POST /v1/runs {"topic", "window"?, "items"?, "run"?}`. They run the built-in **General** digest (id `__general`), a template in `src/general.ts` whose `{topic}` is filled in after parsing, in the title and description only. The topic is cleaned to one line of at most 200 characters, so it can't add settings or recipients. Each run has its own conversation (`__general--<topic>-<time>`) holding its topic, and is emailed to `DIGEST_EMAIL_TO` like any digest.
- General has its own votes, preferences and Agent Memory profile (`__general`); its issues and votes carry their topic, and its memory sentences name it. The id starts with `_`, which digest ids can't, so it never clashes with a stored digest: `PUT`/`DELETE`/`…/runs` on `/v1/digests/__general` answer `400 built_in`, `GET` shows the template, and `GET /v1/digests` lists it last with `"builtIn": true`.
- **Shared between digests:** `reader_preferences` returns a `shared` section computed from the vote log. One-off runs read the explicit "I don't use X" and "More about X" reasons from every other digest; regular digests read only "I don't use X" from General issues. Bare thumbs, topics and "already knew" never cross; the newest vote per product wins, a digest's own preference wins over a shared one, a one-off's own topic is never hidden, and names are matched loosely. Nothing is written twice.
- The digests page has a **General** card and page (how to ask, the template, recent one-off issues, what it learned, its memory).
- Custom domains: when `PUBLIC_URL` is a custom domain, `npm run deploy` declares it in the function's manifest (`[[domains]]`). `docs/SETUP.md` has a "Custom domain" section: mapping, verification, a certificate (e.g. Let's Encrypt) and switching `PUBLIC_URL`.

### Changed

- The research instructions describe the `shared` section: it refines choices within a digest's scope and never widens or narrows it.
- The Agent Memory summary instructions (`docs/memory-summary-instructions.md`) no longer have a Sources section and keep a one-off topic in its bullet's evidence; `npm run deploy` applies them.
- A run's or file's `window` also accepts plain days (`14` as well as `14d`).

### Fixed

- A conversation whose digest id wasn't in the stored-digest format was treated as `ai-swe` when emailing and reading preferences (`profileIdOf`); General runs are recognised.

### Removed

- The "good source" reason on 👍 and source preferences altogether (`sources` in `reader_preferences`, the Sources row on the digests page). Older votes that ticked a source reason count as if it weren't there; a vote whose only reason was one counts for nothing. Its old reason links are refused.

## [0.3.0] - 2026-11-07

### Added

- **The digests page**, `/v1/app` on your function (read-only). The overview shows every digest with its settings, last issue, vote count and memory size. A digest's page shows its settings, description and raw definition file, its recent issues (each opens the sent email via a signed view link), what it learned from your votes (products and companies, topics, tentative topics, sources) and its Agent Memory summary.
- **Magic-link sign-in** for the page: the link is emailed to `ADMIN_EMAIL` (new, optional) or the first `DIGEST_EMAIL_TO`, works once, expires in 15 minutes, and at most one is sent per minute. It sets a signed session cookie for 30 days. Keys are derived from `AGENT_AUTH_KEY`, so no new secret is needed.
- `npm run deploy` prints the page's address; screenshots of the page in the docs.

### Fixed

- `npm run deploy` overwrote a `PUBLIC_URL` set in `.env` with the address Telnyx reports (and shipped twice). A `PUBLIC_URL` in `.env` now always wins, so a custom domain can be used for the links in emails; Telnyx's own address is recorded as `invokeUrl` in `.edge/function.json`.

- (Unreleased page, caught before release) The overview showed every digest as an invalid definition: it parsed definition text that the list doesn't include. It now uses the list's summary fields.

- Links built from the incoming request said `http://`, because TLS ends before the function: the feedback page's change, undo and reason links and its "View the digest" link. The router now treats every request except localhost as `https://` (the platform's `X-Forwarded-Proto: http` describes its internal hop, so it's ignored), so these links and the new sign-in links are `https://` and the `Secure` session cookie works.

## [0.2.1] - 2026-11-07

### Fixed

- `GET /v1/runs/<conversation>` returned the actor's `{ runs }` object as `traces`, so `npm run digests -- status` always said "No runs yet". It now returns `runs` as a list, and `status` prints each run's status, duration, tool calls and tokens.

## [0.2.0] - 2026-11-07

Digests on any topic, each defined in its own file, on a function with its own entry point and a versioned API.

### Added

- **Digest definitions:** one Markdown file per digest (`digests/<id>.md`, git-ignored) with `title` (`{range}` for the dates), `window`, `items`, `closing`, `images`, `to` and a free-text description of what to cover, for whom, sources and exclusions. Examples in `examples/digests/` (`ai-swe`, `agent-memory`). Validated with precise errors (`src/profile.ts`).
- Definitions are stored on the function (a `digests` actor, last 10 versions kept), so editing one needs `npm run digests -- push`, not a deploy.
- **`npm run digests`:** `list`, `push`, `pull`, `show`, `delete`, `run <id> [focus]`, `status <conversation>`.
- **v1 HTTP API:** `/v1/health`, `/v1/assets/*`, `/v1/feedback`, `/v1/digests[/<id>]` (GET, PUT, DELETE), `POST /v1/digests/<id>/runs`, `GET /v1/runs/<conversation>`. Operator routes need the operator token.
- Each run happens in its own conversation, `<digest>--<run>`, and gets a request built from the digest's definition.
- Per-digest email: a digest's `to:` overrides `DIGEST_EMAIL_TO`; `images: off` turns pictures off; pictures are judged for the reader the digest describes.

### Changed

- **Per-digest learning:** votes, preferences and Agent Memory are kept separately for each digest. The memory profile is named after the digest (`ai-swe`, `agent-memory`). Votes from before 0.2.0 count toward `ai-swe`; its memory profile starts fresh.
- **Own entry point instead of the ACP-generated one:** the function is built from `src/index.ts` and shipped with `telnyx-edge` by `npm run deploy`, which registers the function on first use, stores secrets through the API, records the public URL in `.edge/function.json`, pushes `digests/` and applies the memory settings. `agent.json` and `telnyx-acp` are no longer used (the managed loop from `@telnyx/acp` still is).
- The research instructions are topic-neutral; what used to be AI- and software-engineering-specific moved into `examples/digests/ai-swe.md`.
- The operator key lives in `.env` (`AGENT_AUTH_KEY`); the first deploy moves the key `telnyx-acp` had saved there.
- Feedback links use `/v1/feedback` and icons `/v1/assets/…`. Links in emails sent earlier keep working.

### Removed

- `DIGEST_MEMORY_PROFILE` (memory profiles are named after digests), the git filter for `agent.json`, and the `telnyx-acp eval` cases.

### Security

- Actors are no longer reachable over HTTP at all: the router calls them in-process, so state streams and RPC have no public route.

## [0.1.2] - 2026-11-07

### Security

- State streams (`GET …?subscribe=state`) now need the operator token too. In 0.1.1 the runtime still streamed conversation state, including the feedback vote log, to callers it granted no claims. The agent now checks the token itself before its HTTP front door, and answers 403 without it.

## [0.1.1] - 2026-11-07

### Security

- The agent's public URL now requires the operator token for RPC (starting runs, traces) and state reads. Before, anyone with the URL could start digests (emailed to the configured recipients) or read conversation state, including the vote log. The token is the one the `telnyx-acp` CLI already sends, derived from the agent's auth key (`AGENT_AUTH_KEY` secret, saved locally by `npm run deploy`). Feedback links, the digest view and icons are unaffected; they carry their own signatures.

### Added

- `AGENT_AUTH_KEY` setting in `.env.example`; `npm run deploy` generates the key, stores it on Telnyx and saves it to `~/.telnyx-acp/auth-keys.json`.
- Tests for the token derivation (matches the CLI's) and the claims.

## [0.1.0] - 2026-11-07

First public version.

### Added

- Research agent for AI and software engineering news on Telnyx Edge Compute (code-kind ACP agent): weekly digests or any topic, 5–15 items with *why it matters* and specific source links.
- Deterministic email delivery through Telnyx Email: every reply that is a digest is emailed by the agent's post-run hook, with no email tool for the model.
- Pictures from the source articles, judged by a vision model (`Qwen/Qwen3.8-27B`): described figures first, SVG diagrams converted to PNG where the host supports it, permanent URLs for GitHub attachments, size and shape checks, up to two per item.
- Feedback: grey 👍/👎 links under each item, signed with HMAC and expiring after 90 days; a feedback page with toggleable reasons (per-entity "I don't use X", topics, already known; on 👍 also good source), change, undo and a web view of the digest; one Back returns to the email.
- Preferences from votes: entity, topic and source weights by reason, with an evidence threshold for topics; exposed to the model through the `reader_preferences` tool.
- Agent Memory integration: one sentence per vote and reason, rewritten in place on change, deleted (twice) on undo; summary rebuilt on read; namespace summary instructions focused on interests (`docs/memory-summary-instructions.md`).
- Configuration through Telnyx secrets (`DIGEST_EMAIL_FROM`, `DIGEST_EMAIL_TO`, `PUBLIC_URL`, `DIGEST_MEMORY_PROFILE`, `FEEDBACK_KEY`) and a local `.env` (`.env.example`).
- `npm run deploy` (tests, secrets, deploy, first-deploy URL, memory settings), `npm run release` (semver bump, changelog, commit and tag), `npm run screenshots`.
- Git clean filter that strips the `deployed` block from `agent.json`.
- Documentation (`README.md`, `docs/SETUP.md`, `docs/HOW-IT-WORKS.md`) with screenshots, and regression tests (`npm test`).
- Licensed under GPL-3.0-or-later.

[Unreleased]: https://github.com/kubaodias/ai-digest/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kubaodias/ai-digest/releases/tag/v0.1.0

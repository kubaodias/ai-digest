# 0010. Watching

Status: **accepted**: phase 1 shipped in 0.5.0 (named watching in 0.5.1); phases 2 (breaking alerts) and 3 (rising subjects) are proposed.

## Summary

Today a digest is one big research run, started by hand (`npm run digests -- run`) or by an external cron, that writes and emails an issue in one go. This spec replaces the fixed schedule with a **watch loop**: each digest looks for new stories at a fixed interval (e.g. every 6 hours) with a small research check, keeps what it finds in a **candidate pool**, and sends an issue when the pool has enough strong stories, or when the longest gap between issues is reached, whatever the pool holds. A confirmed, very important story can go out right away as a one-item **breaking alert**. Because the pool sees the same subjects across many checks, it can also tell which areas are **rising**.

Pictures are only fetched when an issue is sent, from the stories chosen for it, never while watching.

## Goals

- An issue when there's enough worth reading, not on a fixed day; quiet periods don't produce padded issues, busy ones don't wait a week.
- At least one issue per `max_gap`, even when little happened.
- Important news within hours, at most once a day, without false alarms.
- Signals that a single run can't see: how many independent sources covered a story, how many checks found it again, which subjects keep coming back.
- Predictable cost: a fixed check interval and a small, fixed budget per check.

## Non-goals

- Adaptive check intervals (more often when busy). The interval is fixed per digest.
- Real-time feeds (RSS, webhooks, social streams). Watching is web search and page reads, as today.
- Watching for the built-in General digest. One-off topics stay on demand (`ask`).
- A different delivery channel for alerts. Alerts are emails to the digest's recipients.

## The digest definition

New optional settings in a digest's front matter. A digest without `watch:` works exactly as today (manual runs only).

```yaml
watch: 6h          # look for new stories every 6 hours (1h–24h). Turns the loop on.
send_at: 6         # send an issue once this many strong stories are in the pool (1–30)
strong: 7          # the score a story needs to count as strong (1–10)
min_gap: 2d        # never send issues more often than this (0d–30d)
max_gap: 7d        # send an issue at least this often, even with too few strong stories (1d–30d, ≥ min_gap)
breaking: on       # one-item alerts for confirmed, very important stories (on/off, default off)
timezone: Europe/Warsaw   # the digest's time zone (IANA name, default UTC): when "morning" is
morning: 07:00     # alerts found at night wait until this local time (default 07:00)
```

- `items` keeps its meaning: the most stories an issue includes (and the least it aims for when the pool allows).
- `window` becomes the pool's freshness limit: a story older than the window (by publication date, or by first sighting when the date is unknown) leaves the pool unsent.
- `schedule` is retired. A file that still has it gets a validation error: `"schedule" was replaced by "watch" (see docs/SETUP.md)`.
- Defaults when `watch:` is set and the rest isn't: `send_at` = the lower bound of `items`, `strong: 7`, `min_gap: 2d`, `max_gap: 7d`, `breaking: off`, `timezone: UTC`, `morning: 07:00`.
- `timezone` is checked when the file is pushed (`Intl.DateTimeFormat` with that zone must work in the runtime), so a typo fails at `push`, not at night. Phase 2 starts by confirming the Edge runtime's `Intl` has the full time zone database; if it doesn't, only `UTC` and fixed offsets (`+01:00`) are accepted.

## Architecture

```
          every `watch` (durable task, fixed interval)
                      │
   <id>--pool  ───────┤  watchTick
   (pool actor)       │     └─▶ starts a check in <id>--check-<slot>
        ▲             │                 │  small research run (≈8 tool calls)
        │             │                 ▼  reply: JSON candidates
        │  addCandidates(slot, items) ◀─ post-run hook parses the reply
        │
        ├─ merge, score, expire
        ├─ decide:  nothing │ issue │ alert
        │                     │
        │                     └─▶ starts a writer run in <id>--<slot>
        │                         message: the chosen stories (no new search)
        │                                   │  re-checks links, writes the digest
        │                                   ▼
        │                         post-run hook: pictures (now, for these stories only),
        │                         thumbs links, email, register the issue
        └──────────── markSent(slot, story ids) ◀┘
```

- **Pool actor**, one per digest, conversation `<id>--pool` (so `profileIdOf` still yields the digest id). It owns the pool, the watch timer and the release decision. It never calls the model itself.
- **Checks** run in their own conversations, `<id>--check-<slot>`, like any run, with the managed agent loop and its tools. A fresh conversation per check keeps context small; the check gets what it needs to know (known stories) in its request.
- **Writer runs** are ordinary digest runs (`<id>--<slot>`), so email delivery, pictures, feedback links and issue registration are unchanged. Only their request differs: it lists the chosen stories instead of asking for research.
- **The timer** is a chain of durable tasks with a stable id (`schedule(…, "watchTick", {}, { id: "watch" })`): each tick runs a check and books the next one an interval later, ± 10 minutes, and the first check runs 1–16 minutes after watching is turned on, so different digests' checks rarely coincide; since 0.6.1 they also take turns through a lease held by the `digests` actor, so even checks started by hand never run at once (the runtime crashed twice under three parallel checks in testing). Storing a definition (every `push` and deploy) keeps an armed timer with the same interval, re-arms a missing one and cancels it when `watch:` is gone.
- **Slots** name checks and issues by their due time (`2026-11-16t0600`). They make at-least-once delivery safe: the pool records the last slot it handled and ignores a repeat.

## The pool

One entry per story:

| Field | Meaning |
|---|---|
| `id` | Hash of the canonical URL of the story's primary link |
| `headline`, `summary` | From the check that found it first; updated when a later check has a better (primary) source |
| `url`, `source` | The primary link and its domain |
| `sources` | Every distinct domain seen covering it, with links |
| `published` | Publication date when known |
| `firstSeen`, `lastSeen`, `sightings` | When and how many checks found it |
| `importance` | The model's 1–10 estimate, latest check wins |
| `tags`, `entities` | From the tagger (as for items today) |
| `score` | Computed (below), kept for display |
| `state` | `candidate` → `reserved` (chosen for an issue being written) → `sent`; or `held` (an alert waiting for the morning); or `expired` |

Limits: at most 200 candidates (lowest scores dropped first); sent and expired ids are kept for 90 days so a story is never sent twice.

### Deduplication

1. **Canonical URL:** lowercase host without `www.`, no fragment, no tracking parameters (`utm_*`, `ref`, `fbclid`, …), no trailing slash, AMP links mapped to the article. Same canonical URL → same story.
2. **Same story, different outlet:** the check request lists the pool's current headlines (compact, newest 60) and the model may mark a candidate `sameAs: <id>`. The pool accepts that only if the two share an entity or most title words (token overlap ≥ 0.5), so a model mistake can't merge unrelated stories. A merged sighting adds its domain to `sources` and counts as a sighting.

### Scoring

```
score = importance
      + min(2,   independentSources − 1)            corroboration
      + min(1.5, 0.5 × (sightings − 1))             found again by later checks
      + 0.5 if the primary link is a primary source (maker's post, paper, release notes)
      + preferences:  entity "more" +1 · topic "more"/"less" ±0.5 · shared entity "more" +0.5
      − 1 per full week since publication
```

- An entity preference "less" (the digest's own, or a shared "I don't use X") **removes** the story, as today: strict.
- The score is capped to 0–10 for display; `strong` compares against it.
- The formula lives in one pure function with table tests; its weights are constants in `src/pool.ts`, tuned from feedback later.

### When to send

Evaluated after every check and on every `run`:

1. **Breaking alert** (phase 2, only with `breaking: on`): a candidate with `importance ≥ 9`, **at least 2 independent sources**, first seen within the last 48 hours, and no alert sent in the last 24 hours → a one-item alert. Alerts ignore `min_gap`. The story is marked sent; the next issue lists it in one line under "Already sent as an alert".
   - **Held until morning:** an alert decided between 21:00 and `morning` in the digest's `timezone` isn't sent then. The story is marked `held` and a one-off task (`schedule(…, "releaseHeld", …, { id: "alert" })`) fires at the next `morning`. At that point the pool re-checks it (still not sent, still within the window, still the strongest unsent alert candidate) and sends it; later checks during the night can confirm it further or replace it with a stronger one, never add a second. An issue that falls due during the night includes held stories instead, and then no alert is sent for them.
2. **Issue:** at least `send_at` strong candidates **and** at least `min_gap` since the last issue → send the strongest, up to `items`.
3. **Issue anyway:** `max_gap` reached since the last issue → send what the pool has, strongest first, up to `items`, leaving out stories scoring below 5 unless none reach it (then the best three). If the pool is empty, send a short issue saying nothing new met the bar since the last one, with the date range covered. Manual runs pick the same way. In every case an issue takes at most 2 stories about the same product or company (the main entity); the others stay in the pool for the next issue.
4. Otherwise nothing; the page shows why (`4 of 6 strong stories · next check 14:00 · an issue by Mon 16 Nov at the latest`).

The first issue's clock starts when the loop is turned on.

### Expiry

A candidate older than `window` leaves the pool as `expired`. Expiry runs before every decision, so an issue never includes a story from outside its window.

## The check

The request, built by the pool actor (`checkMessage` in `src/pool.ts`; wording in `src/watch-instructions.ts`, not in the class file):

- the digest's description (what it covers, for whom, sources, what to leave out);
- **since when to look:** the last check's time minus an hour of overlap (the first check: the digest's window);
- **known stories:** the newest 60 pool headlines with their ids, and "skip these unless you have a better primary source or a new independent source";
- **budget:** at most 8 tool calls, then answer. Phase 1 showed the prompt alone isn't enough (12–14 calls), so the agent counts web tool calls per run and refuses the rest (`toolBudget`, `spendTool`); the refusal reaches the model as the tool's error and it answers with what it has;
- **answer format:** JSON only, no prose:

```json
{"candidates": [
  {"headline": "…", "url": "https://…", "source": "example.com", "published": "2026-11-15",
   "summary": "one or two sentences", "importance": 7, "why": "for this digest's reader, because …",
   "otherSources": ["https://…"], "sameAs": null}
]}
```

The post-run hook recognises a check reply by its conversation name (`--check-`), validates it (URL required and parseable, `importance` 1–10, dates in the window, at most 15 candidates; anything malformed is dropped with a log line), tags the candidates (the existing tagger, one call per check) and hands them to the pool actor. A check reply is never emailed.

The research instructions keep their rules (only items found in this run, specific links, primary sources first, never invent). The check variant drops the output format and the item count.

## The writer run

When the pool decides to send, it marks the chosen stories `reserved` with the issue's slot and starts a run in `<id>--<slot>` with:

- the digest's title, item range and closing section, as today;
- the chosen stories in score order: headline, primary link, other sources, summary, why it matters, tags;
- for issues sent at `max_gap` with few strong stories: that this is the regular issue for a quieter period, so it may be shorter;
- phase 3: the rising subjects (below), for a "What's rising" section;
- the rule: **no new web search**; `fetch_page` only to confirm a link still works and what it says; drop a story whose link is dead or doesn't match; never add stories that aren't in the list.

The reply is a normal digest, so the existing post-run hook emails it. **Pictures are picked at this point**, from the chosen stories' articles, exactly as today; checks never fetch images. After the email is sent the hook calls `markSent(slot, ids)` on the pool actor. If the writer run fails, the reservation expires after an hour and the stories return to the pool.

`npm run digests -- run <id> [focus]` keeps working: it runs a fresh check first, then writes an issue from the pool (plus any focus), whatever the thresholds say. `ask` is unchanged.

## Rising subjects (phase 3)

The pool and the sent history (90 days) record each story's tags and entities with dates. A subject is **rising** when it appears in at least 3 stories from at least 2 sources in the last 7 days, and at least twice as often as in the 7 days before. The writer gets up to 3 rising subjects with their counts and writes 1–3 bullets under "What's rising" (or leaves the section out). The digests page lists them too. Votes don't change what counts as rising; they already change what gets sent.

## Feedback

Unchanged: thumbs and reasons on every item, per-digest preferences, Agent Memory, shared reasons between digests. Preferences now act earlier, in the pool's score (and the strict entity "less" removes stories before they're ever written up), as well as in the writer's ranking. A 👎 "already knew this" on an alert or an item counts toward lowering `importance` trust later (an open question below).

## API, CLI, page

| Addition | What |
|---|---|
| `GET /v1/digests/<id>/pool` | The pool: candidates with scores and states, last check, next check, last issue, the decision and why |
| `POST /v1/digests/<id>/check` | Run a check now (doesn't send unless the policy says so) |
| `POST /v1/digests/<id>/runs` | As today, now "check now, then write from the pool" for digests with `watch:` |
| `npm run digests -- pool <id>` | The pool, as a table |
| `npm run digests -- watch <id>` | A check now |
| Digests page | Per digest: next check, pool counts (strong / all), the strongest stories, why no issue yet, the latest alert, rising subjects |

All additive, so they stay under `/v1`.

## Failures and guarantees

| Situation | Behaviour |
|---|---|
| A task fires twice (at-least-once delivery) | The slot was already handled → ignored |
| A check fails or returns nothing valid | Logged; the pool is unchanged; the next tick runs as usual |
| The function was down at tick time | The task fires late, one check runs, the interval continues from there; no backlog |
| A timer is lost | `npm run deploy` re-arms every digest's timer (`reconcile`); any pool API call re-arms its own |
| The writer run fails | Reservation expires after an hour; the stories return; the next decision retries |
| The email fails after the writer succeeds | As today: logged, not resent automatically; `emailedAt` prevents doubles |
| `max_gap` reached while a check is running | The decision runs after the check, so the issue includes it |

## Cost

A check has a budget of 8 tool calls against about 28 for today's full run (which used about 295k tokens), so a check should take roughly a quarter to a third of that; this is an estimate to confirm in phase 1 from `status` token counts. At `watch: 6h` that's four checks a day per digest, plus one writer run per issue (no search, a few page reads, plus pictures). Expect several times today's weekly cost per digest; `watch: 12h` or `24h` for slow topics brings it down proportionally. The page shows tokens per day per digest so the effect of `watch:` is visible.

## Testing

Pure modules, covered without network:

- definition parsing: the new settings, their ranges and defaults, the `schedule` error;
- `canonicalUrl` (tracking parameters, AMP, `www`, fragments);
- merging: same URL, `sameAs` accepted and refused, sources and sightings counted;
- scoring: a table of cases, including strict entity removal and shared preferences;
- the release decision: a table over pool states and times (send at threshold, `min_gap` holds, `max_gap` forces with few or no stories, alert conditions, one alert per 24 h);
- expiry, reservation timeout, slot idempotency;
- holding alerts: decided at night (in the digest's time zone, across a daylight-saving change) → held and released at `morning`; replaced by a stronger one overnight; absorbed by an issue that falls due first;
- check reply validation (malformed JSON, missing URL, out-of-window dates, too many candidates);
- the writer request (chosen stories, the no-search rule, the quiet-period note);
- rising subjects (thresholds, two-source rule).

Router tests for the new routes; app tests for the pool card.

## Phases

1. **0.5.0: watch loop and pool.** Settings, pool actor, timer and reconcile, checks, merge, score, expiry, issue and issue-anyway decisions, writer runs, pictures at send time, pool API, CLI and page card, `schedule` retired.
2. **0.6.0: breaking alerts.** Once phase 1 shows how stable `importance` is across checks.
3. **0.7.0: rising subjects.** Once the pool has a few weeks of history.

## Open questions

- **Learning the thresholds:** should "already knew this" on alerts raise the alert bar, and 👎 rates on issues sent at `max_gap` lower `send_at`?
- **A cheaper model for checks:** checks mostly search and summarise; a smaller model could cut the cost further.
- **Empty issues:** the short "nothing new" issue at `max_gap` is the default; should a digest be able to turn it off?

# 0004. Feedback and preferences

Status: accepted · Since: 0.1.0 · Revised: 0.2.0 (per digest), 0.4.0 (no source reasons, sharing in 0009)

## Context

A digest should get better for its reader without them editing prompts. Email limits what we can ask: links, no forms, no scripts. And a thumb alone is ambiguous: a 👎 on "Postman's desktop app silently installed plugins into Codex and Claude Code" could mean "I don't use Postman", "less security news", "less dev tooling" or "I knew this already". Treating it as all of them taught the agent the wrong things quickly.

## Decision

- **Grey 👍/👎 links under each item**, each a signed URL (HMAC-SHA256 with `FEEDBACK_KEY`, 90-day expiry) carrying only `{digest issue, item, vote, expiry}`.
- **A thanks page with optional reasons**, any number, toggled in place (one Back returns to the email):
  - 👎: "I don't use *X*" (one option per product or company in the item), "not interested in *topics*", "I already knew this";
  - 👍: "more about *X*", "more on *topics*".
- **The vote log is the source of truth** (the `feedback` actor's state, one vote per item, editable and undoable). Preferences are computed from it on every run (`src/preferences.ts`), with the weights in this table:

| Reason | Main or chosen entity | Other entities | Topics |
|---|---|---|---|
| none | 0.7 | 0.2 | 0.25 |
| I don't use X / more about X | 1 | 0 | 0 |
| not interested / more on topics | 0.3 | 0 | 1 |
| already knew | 0 | 0 | 0 |

- **Entities count from one vote and apply strictly** (skip items mainly about something the reader doesn't use). **Topics need evidence** (score ≥ 0.75 and an explicit reason or 3 votes the same way) and apply softly; until then they're *tentative* and ignored.
- **Per digest** (0.2.0): votes are tagged with their issue's digest and count only there. Liking retrieval papers in one digest doesn't change another.
- **Items are tagged at send time** with topics and entities (one text-only call to a small model), so votes have something to attach to.

## Alternatives

- **Thumbs only.** Too ambiguous, as above.
- **A free-text "why" box.** Needs a form and parsing; few readers type.
- **Source reasons** ("weak source", then "good source"). "Weak source" was dropped before the first release because the reader didn't want it; "good source" was removed in 0.4.0 for the same reason. Older votes keep their stored reason; it counts for nothing (a vote whose only reason was a source counts as no vote, not as an unexplained one).
- **Learning in the model's memory only.** Unstructured, hard to undo, can't be applied strictly. Memory became the secondary view (0005).

## Consequences

- The reader controls what a vote means, at the cost of one optional tap.
- Undo and change are exact, because the log is structured.
- Entity names come from separate tagger calls and vary ("claude-code", "Claude Code"); sharing between digests (0009) compares them loosely.
- A single unexplained 👎 is enough to make the item's main entity "avoid". That's intended within a digest, and the reason unexplained votes never cross between digests.

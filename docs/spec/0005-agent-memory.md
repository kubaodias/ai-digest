# 0005. Agent Memory as a secondary, readable view

Status: accepted · Since: 0.1.0 · Revised: 0.2.0 (one profile per digest), 0.4.0 (instructions)

## Context

The managed agent loop can attach Telnyx Agent Memory to conversations, so the model recalls past exchanges. For a digest that wasn't what we needed: research runs aren't conversations with the reader, and remembering past runs mostly stored the agent's own output. What the agent should know is the reader's interests, which live in the vote log (0004).

## Decision

- **The loop's own memory is off.** Runs don't store or recall conversation history.
- **Votes write to Agent Memory** (namespace `ai-digest`): one sentence per vote and reason, worded by the reason ("I don't use Postman — skip news mainly about Postman. This says nothing about the wider topic."), session `fb-<issue>-<item>` so a change rewrites it in place.
- **One memory profile per digest**, named after the digest (0.2.0); the built-in General digest has `__general` (0009), and its sentences name the one-off topic.
- **The research model reads the profile's summary** through the `reader_preferences` tool, next to the structured preferences. The summary is the readable view; the structured preferences carry the strict rules.
- **Namespace summary instructions** (`docs/memory-summary-instructions.md`, applied by `npm run deploy`) restrict the summary to *Wants more of / Wants less of / Patterns* and rule out identity, location and remarks about the data itself.

## Alternatives

- **Memory as the only store.** Can't be applied strictly, can't be undone exactly, and its summary is a model's paraphrase.
- **No memory at all.** Loses a compact, human-readable profile that the page also shows; and the agent reads prose interests better than raw weights for nuance.

## Consequences

Learned the hard way, now handled in code:

- **Summaries are built only on request** (`GET …/summary?refresh=true`); a plain read of a stale summary returns `null`. `reader_preferences` asks and waits up to a minute.
- **Ingestion is asynchronous**: a memory can land after it was deleted, so undo deletes the source twice, two minutes apart.
- **Instructions are capped at 2000 characters** (only documented by the 422 error); a test checks ours (0.4.1).
- **Without strict instructions the summary editorialises** ("not established", how often the reader votes); three rounds of wording got it to interests only.
- Old memories from before per-digest profiles were moved into the matching digest's profile by hand, once.

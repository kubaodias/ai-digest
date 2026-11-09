# 0009. One-off General digest and preferences shared between digests

Status: accepted · Since: 0.4.0

## Context

Every run needed a stored definition, so a one-off topic ("agent harnesses", once) had no home: either write and push a file for it, or squeeze it into an existing digest with a focus (`run ai-swe "only about agent harnesses"`), which would also teach that digest the one-off's interests. The question that followed: should what the reader says in one digest help the others?

## Alternatives considered

Two independent reviews (one on learning quality, one on engineering cost against the code) rated these:

| | Option | Verdict |
|---|---|---|
| A | No feature: `run <digest> "<focus>"` | Worst for learning: an explicit topic reason on a focused run settles permanently into that digest |
| B | One-offs without learning (no thumbs, or votes ignored) | Safe, but wastes the rarest signal; votes are recorded anyway, so ignoring them buys nothing |
| C | A built-in General digest with its own votes and memory, read only by one-offs | Safe; each new topic starts from nothing |
| D | C, and every digest also reads General | Leaks: one unexplained 👎 on a one-off would block a product everywhere; one-off topic interests would pull regular digests off scope |
| E | D, and every digest writes product and source reasons to General too | Leaks more, and every vote would need two memory sources (undo, change and re-delete all double) |
| F | A shared "reader" profile for cross-cutting facts, read by all | Changes what every digest's data means; needs a migration |
| G | C, plus a read-only view of explicit product reasons computed from the vote log | Recommended by both reviews: no new writes, no second memory profile |

Naming was a separate question: a reserved word (`general`) needs a deny-list that someone eventually forgets; a configurable id strands votes when changed.

## Decision

G, refined in a second review round (both scored it 8/10):

- **A built-in General digest**, id `__general`. Ids of stored digests can't start with `_` (0003), so it can't collide, with no deny-list; it's a fixed constant, not a setting. `PUT`/`DELETE`/`…/runs` on it are refused.
- **A template, not a generated definition**: `src/general.ts`, in the digest file format, with `{topic}` in the title and description. It's parsed first and filled after, so a topic containing `to: …` stays text. Topics are cleaned to one line of at most 200 characters.
- **`npm run digests -- ask "<topic>" [--window] [--items]`** → `POST /v1/runs`. Each run is its own conversation (`__general--<topic slug>-<time>`) and stores its topic in its own state, so concurrent asks never share anything.
- **General learns like any digest**: its own votes, preferences and memory profile; its issues and votes carry their topic, and memory sentences name it so the summary doesn't blend topics.
- **A `shared` section in `reader_preferences`**, computed from the vote log at read time (nothing written twice):
  - a one-off reads explicit "I don't use X" and "More about X" from every other digest (a new topic has nothing else to go on);
  - a regular digest reads only explicit "I don't use X" from General ("more about X" there was interest in that one topic);
  - never bare thumbs, topic reasons or "already knew";
  - the newest vote per product wins; a digest's own preference wins over a shared one; a shared product that is the one-off's own topic is left out ("I don't use Postman" never hides `ask "Postman alternatives"`); names are compared loosely;
  - the model is told the shared section refines choices within the digest's scope and never widens or narrows it.
- **"Good source" removed** at the same time: the reader didn't want source preferences (0004).

## Consequences

- One-offs need no file and teach the regular digests only "I don't use X".
- The review also caught a real bug before release: conversations of an id outside the file format fell back to the legacy digest (its recipients and memory) silently; `profileIdOf` now recognises built-ins, with tests.
- Possible later step, if the data shows it helps: regular digests reading more of General (D, with the same filters).

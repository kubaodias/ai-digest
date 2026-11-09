# 0003. Digests defined in files, stored on the function

Status: accepted · Since: 0.2.0

## Context

The first versions were one digest (AI and software engineering news) with its topic, audience, sources and item count written into the research instructions. A second topic (agent memory systems) would have meant a second agent or a fork of the prompt, and the instructions mixed general research rules with one reader's interests. Publishing the repo also meant a deployer's own topics and recipients must not end up in git.

## Decision

- **One Markdown file per digest**: front matter for settings (`title` with `{range}`, `window`, `items`, `closing`, `images`, `to`), the body for what to cover, for whom, where to look and what to leave out (`src/profile.ts`, validated with precise errors).
- **The research instructions are topic-neutral** (`src/instructions.ts`); each run's request is built from its definition (`runMessage`).
- **Definitions live on the function** (a `digests` actor, last 10 versions kept): editing one is `npm run digests -- push`, not a deploy.
- **The deployer's files are git-ignored** (`/digests/`); examples to copy are committed in `examples/digests/`.
- **Each run is its own conversation**, `<digest>--<run>`, so the digest a run belongs to is in its name (`profileIdOf`).

## Alternatives

- **Settings as environment variables or secrets.** Fine for one digest, unreadable for several, and descriptions don't fit.
- **One agent per digest.** Multiplies deploys, secrets and actors for what is only a different request.
- **Definitions in the repo, deployed with the code.** Leaks private topics into a public repo and couples content edits to deploys.

## Consequences

- New topics are a file and a `push`. The built-in General digest (0009) reuses the same format as a template.
- Ids are file names (lowercase letters, digits, single dashes; `--` separates the run name), which later made a collision-free namespace for built-ins possible (0009).
- `schedule:` was accepted from the start but unused, waiting for a scheduler; continuous scouting (0010) proposes replacing it.

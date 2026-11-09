# 0001. Own entry point and a versioned API

Status: accepted · Since: 0.2.0

## Context

Up to 0.1.x the agent was an ACP "code kind" agent: `telnyx-acp` generated the function's entry point and deployed it, and every conversation actor answered HTTP on its own mount (`/agents/ai-digest/<conversation>/…`): RPC, state streams, traces. That gave us a working agent quickly, but:

- the public surface was whatever the generated entry exposed, and it changed with the toolkit; in 0.1.1 state streams (including the vote log) were readable without a token, fixed in 0.1.2 with a guard in our class;
- configurable digests needed routes the generated entry didn't have (store a definition, start a run of a digest, read a run's status);
- there was no way to version the HTTP API for the CLI and scripts that call it.

## Decision

- The function has its own entry point, `src/index.ts`, and every request goes through one router, `src/router.ts`.
- The API lives under `/v1`. Additive changes stay in v1; a breaking change gets a new version path (AGENTS.md rule).
- Actors are reached **in-process only** (`env.AI_DIGEST.idFromName(name).method()`); the router never forwards a request to an actor's own HTTP front door, except the signed feedback pages.
- `@telnyx/acp` stays, but as a library: its managed agent loop (model, tools, steps, traces). Its generated entry and deploy are no longer used.
- `npm run deploy` (`scripts/deploy.mjs`) builds `.edge/` (manifest and entry) and ships with `telnyx-edge`, registering the function on first use and keeping the same function (and its actors' state) for existing deployments.

## Alternatives

- **Keep the generated entry and add guards.** Every new route would fight the generator, and the attack surface would stay what the toolkit decides.
- **A separate API function in front of the agent.** Two deploys, cross-function auth, and actors still exposed on their own mount.

## Consequences

- One place to read for what's public (the route table at the top of `src/router.ts`).
- We own deployment details the toolkit used to hide: secrets, the manifest, first-deploy URL discovery, migrating `agent.json` deployments.
- Old links in sent emails (`/agents/ai-digest/feedback`) keep a compatibility route.

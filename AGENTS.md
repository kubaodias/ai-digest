# AGENTS.md

Context for a coding agent working in this repository: an AI agent on Telnyx Edge Compute with its own entry point and a versioned HTTP API, published as open source. It uses the managed agent loop from `@telnyx/acp` as a library and ships with `telnyx-edge` (`npm run deploy`).

| file | what it is | who changes it |
|---|---|---|
| `src/index.ts`, `src/router.ts` | The function's entry point and the v1 API (the only HTTP surface) | you |
| `src/agent.ts` | The agent class: post-run email delivery, the `feedback`, `digests` and pool actors, web tool budgets, the email template | you |
| `src/profile.ts` | Digest definitions: parsing, validation, the run request | you |
| `src/instructions.ts` | How the research model researches and writes any digest | you |
| `src/pool.ts`, `src/watch-instructions.ts` | Watching digests (`watch:`): the candidate pool, scoring and send decisions; the check and issue-writing requests | you |
| `src/general.ts` | The built-in General digest's template (one-off topics, `npm run digests -- ask`) | you |
| `src/images.ts`, `src/feedback.ts`, `src/preferences.ts`, `src/digest.ts`, `src/config.ts`, `src/auth.ts` | Pictures, feedback, preference scoring, digest detection, settings from secrets, the operator token | you |
| `test/*.test.ts` | Regression tests, `npm test` (node:test, no network) | you |
| `examples/digests/` | Example digest definitions (committed) | you |
| `digests/` | The deployer's own digest definitions; git-ignored | the person deploying |
| `docs/` | Setup and design docs, screenshots (`npm run screenshots`), memory summary instructions | you |
| `docs/spec/` | Decision records and design specs, numbered; a new decision or a feature design gets the next number | you |
| `CHANGELOG.md` | Keep a Changelog; every change gets an entry under Unreleased | you |
| `.env` | Local settings and keys; git-ignored. `.env.example` documents them | the person deploying |
| `.edge/` | Build output and deploy state (function id, URL) from `npm run deploy`; git-ignored | never by hand |

Rules

- No account-specific data in committed files: no real domains or email addresses (use `example.com`), function ids, public URLs, account ids or IPs. They belong in `.env`, `digests/`, `.edge/` and Telnyx secrets.
- Keep the class's file free of long template strings with backticks; long prompts live in their own modules.
- HTTP changes go through `src/router.ts` under `/v1`. A breaking API change means a new version path, not changing `/v1`.
- Run `npm test` before deploying; `npm run deploy` does it for you.
- Semver: add a CHANGELOG entry with every behaviour change; cut releases with `npm run release -- patch|minor|major` (it also updates the version `/v1/health` reports).
- Secrets: the deploy stores them through `POST /v2/compute/secrets` with the value in the body. Never pass a secret value on a command line or write it into a committed file.

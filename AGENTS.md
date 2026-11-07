# AGENTS.md

Context for a coding agent working in this repository: a Telnyx ACP agent of the **code** kind (`telnyx-acp`), published as open source.

| file | what it is | who changes it |
|---|---|---|
| `agent.json` | The AgentSpec: name, kind, model, tools, limits, secrets (names only). `deploy` adds a `deployed` block locally; a git filter strips it on commit | `telnyx-acp`, or you |
| `src/agent.ts` | The agent class: post-run email delivery, the `feedback` HTTP routes, the email template | you |
| `src/instructions.ts` | The research model's instructions | you |
| `src/images.ts`, `src/feedback.ts`, `src/preferences.ts`, `src/digest.ts`, `src/config.ts` | Pictures, feedback, preference scoring, digest detection, settings from secrets | you |
| `test/*.test.ts` | Regression tests, run with `npm test` (node:test, no network) | you |
| `docs/` | Setup and design docs, screenshots (`npm run screenshots`), memory summary instructions | you |
| `CHANGELOG.md` | Keep a Changelog; every change gets an entry under Unreleased | you |
| `.env` | Local settings and keys; git-ignored. `.env.example` documents them | the person deploying |
| `.telnyx/` | Build output from `telnyx-acp deploy`; git-ignored | never by hand |

Rules

- No account-specific data in committed files: no real domains or email addresses (use `example.com`), function ids, public URLs, memory profile names, account ids or IPs. They belong in `.env` and Telnyx secrets.
- Keep the class's file free of long template strings with backticks: `telnyx-acp` scans `src/agent.ts` to find the agent class.
- Run `npm test` before deploying; `npm run deploy` does it for you. Run `telnyx-acp validate` after editing `agent.json`.
- Semver: add a CHANGELOG entry with every behaviour change; cut releases with `npm run release -- patch|minor|major`.
- Secrets: `telnyx-acp add secret NAME` (value on stdin) stores the value on the platform and records only the name. Never write a value into a committed file.
- Each `deploy` is a new immutable version; `telnyx-acp versions` lists them.

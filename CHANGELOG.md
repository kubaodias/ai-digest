# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

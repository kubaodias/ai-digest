# AI Digest

Email digests on any topic, researched and written by an AI agent on [Telnyx Edge Compute](https://developers.telnyx.com/docs/edge-compute/platform-overview). You describe each digest in a short Markdown file: what to cover, for whom, where to look, how far back, how many items. The agent researches it, writes it, illustrates it with the articles' own diagrams and charts, emails it, and learns what you care about from one-tap feedback, separately for each digest.

It runs entirely on Telnyx: Edge Compute for hosting and durable state, Telnyx Inference for the models, Web Search for research, Email for delivery and [Agent Memory](https://developers.telnyx.com/docs/agent-memory) for preferences.

<p align="center">
  <img src="docs/images/email-top.png" width="420" alt="A digest email: a numbered list of stories, each with why it matters, its sources and a screenshot from the article">
  &nbsp;
  <img src="docs/images/feedback-page.png" width="300" alt="The feedback page after a thumbs-down: reason options such as 'I don't use Postman', the article, and what the vote changes">
</p>

## What it does

- **Digests you define.** One file per digest, e.g. `digests/agent-memory.md`, with its title, topic and audience, sources, time window, length and closing section. Your digests stay private: the folder is git-ignored and stored on your own function.
- **Researches** each issue with about 25 web searches and page reads, using only items from the requested window and linking to the specific articles.
- **Illustrates** items with pictures from the source articles, only when a vision model judges them informative for that digest's reader: charts, diagrams, product screenshots.
- **Emails** every finished digest from your own domain, to the digest's recipients. Sending is done by code, not left to the model.
- **Shows your digests on a page** at `/v1/app` on your function, behind a magic-link sign-in: each digest's settings and description, its recent issues, what it learned from your votes, and its Agent Memory summary.
- **Learns per digest** from grey 👍/👎 links under each item. After a click you can say why, picking any number of reasons ("I don't use Postman", "not interested in this topic", "already knew it"). Each digest keeps its own vote log and Agent Memory profile, named after the digest.

<p align="center">
  <img src="docs/images/email-diagrams.png" width="420" alt="A digest item about OpenAI's Git backend, illustrated with two diagrams taken from the article">
</p>

<p align="center">
  <img src="docs/images/app-digest.png" width="560" alt="The digests page for one digest: settings, what it covers, recent issues, learned preferences and the Agent Memory summary">
</p>

## A digest definition

```markdown
---
title: "Agent Memory Weekly — {range}"
window: 14d
items: 5-10
closing: Takeaways
---
Memory systems for AI agents, for an engineer building agents: long-term memory
APIs and services, memory architectures, retrieval and context management.

## Sources
- Letta, Mem0, Zep, LangGraph, Telnyx Agent Memory; arXiv cs.AI and cs.CL.

## Leave out
- Chatbot launches with no memory angle.
```

Examples to copy: [`examples/digests/`](examples/digests). All settings are described in [docs/SETUP.md](docs/SETUP.md#5-define-your-digests).

```sh
npm run digests -- push               # upload digests/*.md to your function
npm run digests -- run agent-memory   # start an issue now (3–5 minutes, then it's emailed)
npm run digests -- list
```

Then open `https://<your function>/v1/app` and sign in with the link it emails you.

## How it works

```mermaid
flowchart LR
  CLI[npm run digests] -->|"/v1 API, operator token"| R
  subgraph EC[Telnyx Edge Compute: your function]
    R[v1 router]
    D[digests actor<br/>definitions]
    A["run actors<br/>one per issue: &lt;digest&gt;--&lt;run&gt;"]
    F[feedback actor<br/>votes + sent issues]
  end
  R --> D
  R -->|start run| A
  A -->|research| WS[Web Search]
  A -->|write| LLM[Inference<br/>DeepSeek V4.1 Flash]
  A -->|pick pictures| V[Inference<br/>Qwen3.8 vision]
  A -->|send| EM[Telnyx Email]
  EM --> Reader((Reader))
  Reader -->|"👍/👎 signed link"| R
  R --> F
  F -->|per-digest sentences| M[Agent Memory<br/>profile = digest id]
  A -->|reader_preferences| F
```

The function has its own entry point and a versioned HTTP API (`/v1/…`). See [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) for the API, the research loop, picture selection, signed feedback links, how votes become preferences, and what's stored where.

## Set it up on your Telnyx account

About 30 minutes, most of it waiting for DNS. The full guide with links is **[docs/SETUP.md](docs/SETUP.md)**. In short:

1. [Create a Telnyx account](https://telnyx.com/sign-up) and an [API key](https://developers.telnyx.com/development/api-fundamentals/create-api-keys); install the [Edge Compute CLI](https://developers.telnyx.com/docs/edge-compute/platform-overview) (`telnyx-edge`).
2. [Verify a sending domain](https://developers.telnyx.com/docs/messaging/email/domains) in Telnyx Email (ownership, DKIM and SPF records).
3. Clone, `npm install`, `cp .env.example .env` and set your sender and recipient.
4. Copy a digest from `examples/digests/` into `digests/` and edit it.
5. `npm run deploy`, then `npm run digests -- run <digest>`.

## Project layout

| Path | What it is |
|---|---|
| `src/index.ts`, `src/router.ts` | The function's entry point and its v1 HTTP API |
| `src/agent.ts` | The agent: research loop, deterministic email delivery, the `feedback` and `digests` actors, the email template |
| `src/profile.ts` | Parsing digest definitions and turning one into a run's request |
| `src/instructions.ts` | How to research and write any digest |
| `src/images.ts` | Picking pictures from the source articles |
| `src/feedback.ts`, `src/preferences.ts` | Signed thumbs links, the feedback pages, votes into preferences |
| `src/app.ts` | The digests page and its magic-link sign-in |
| `src/config.ts`, `src/auth.ts` | Settings from Telnyx secrets; the operator token |
| `examples/digests/` | Digest definitions to copy (your own go in the git-ignored `digests/`) |
| `docs/memory-summary-instructions.md` | How Agent Memory summarises a digest reader's interests |
| `scripts/` | `deploy`, `digests`, `release`, `screenshots` |
| `test/` | Regression tests (`npm test`) |

## Development

```sh
npm install
npm test                         # node:test, no network
npm run screenshots              # regenerate docs/images from docs/fixtures (needs Chrome)
npm run deploy                   # tests, secrets, build, ship, push digests
npm run release -- minor         # bump version, date the changelog, commit and tag
```

Requires Node.js 23.6 or newer (it runs TypeScript directly) and the [`telnyx-edge`](https://developers.telnyx.com/docs/edge-compute/platform-overview) CLI.

## Versioning

[Semantic versioning](https://semver.org). The HTTP API is versioned in its path (`/v1`). Changes are listed in [CHANGELOG.md](CHANGELOG.md); add yours under *Unreleased*, and `npm run release` dates them.

## License

[GPL-3.0-or-later](LICENSE). You can use, change and share it; if you distribute a modified version, it must stay under the GPL.

## Notes

This is an independent project built on Telnyx's public APIs, not an official Telnyx product. Agent Memory is in beta, so its API may change.

# 0002. Deterministic email delivery

Status: accepted · Since: 0.1.0

## Context

The first version gave the research model an email tool. Sending then depended on the model deciding to call it, with the right arguments, at the end of a long run; it sometimes ended with a plan or a status update instead, and nothing was sent. The model could also, in principle, choose recipients or content we didn't intend.

## Decision

- The model has **no email tool**. Its job ends with a reply.
- After every completed run, the agent's post-run hook (`rememberRun` in `src/agent.ts`) checks whether the reply is a digest (numbered `## N.` items, `src/digest.ts`). If it is, code sends it: pictures, thumbs links, HTML rendering, `POST /v2/emails`, registering the issue with the feedback actor.
- Sender, default recipients and the public URL come from Telnyx secrets (`src/config.ts`); a digest's `to:` can override recipients. Never from the model.
- `emailedAt` in the conversation's state stops a second send when the hook runs again for the same run.

## Alternatives

- **An email tool with stricter instructions.** Still probabilistic; the failure mode (no email) is silent.
- **A separate "send" step called by the CLI after the run.** Needs the caller to wait for the run and know when it's done; scheduled or remote runs would need the same orchestration again.

## Consequences

- A run that produces a digest always sends exactly one email; a run that produces an answer, a question or an error sends nothing.
- The Telnyx Email API silently drops unknown fields: our first emails had no body because the fields are `text_body` / `html_body` (and `to` is an array). The request shape is now covered by the code path every digest uses.
- Anything that should happen to every issue (pictures, feedback links, registration) belongs in this hook, not in the prompt.

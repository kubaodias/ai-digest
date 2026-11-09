# Telnyx platform notes

What we ran into on Telnyx while building ai-digest (late 2026, `telnyx-edge` 0.5.x, `@telnyx/acp` beta), most important first, with what we do about it. Bugs that were ours are left out. These are observations at the time; check the current docs before relying on them.

## Blocking or silently wrong

| Issue | Workaround here |
|---|---|
| **No certificates for custom domains.** A custom domain needs a certificate you bring and renew yourself. | Let's Encrypt with a DNS challenge, uploaded per hostname with `telnyx-edge domains cert upload`; manual renewal (`docs/SETUP.md`). |
| **The Email API drops unknown fields silently.** Wrong field names give a success response and an empty email. | The body fields are `text_body` / `html_body` and `to` is an array; one code path sends every email (0002). |
| **Custom domains drop the original host.** `req.url`, `Host`, `X-Forwarded-Host` and `Forwarded` all carry the function's `*.telnyxcompute.com` host; `@telnyx/acp`'s own `X-Forwarded-Host` logic gets it wrong too. Undocumented. Reported. | `PUBLIC_URL`, and the router rewrites requests to it (0008). |
| **The forwarding headers say `http`** (`X-Forwarded-Proto: http`, `Forwarded: proto=http`, with `X-Forwarded-Port: 443`), though clients use HTTPS. | Everything except localhost is treated as `https://` (0008). |

## Costly, with workarounds

| Issue | Workaround here |
|---|---|
| **Deploys:** `409 Function Busy` while an interrupted ship still builds, with no way to cancel; occasional `deploy_failed` with no reason in the build log, where an identical retry succeeds; builds take minutes and `ship` blocks. | Wait for the pending revision (`telnyx-edge revisions list`), retry once. |
| **Agent Memory summaries are built only on `?refresh=true`**; a plain read of a stale one returns `null`; building takes up to ~40 s. | Ask and poll (0005). |
| **Agent Memory ingestion is asynchronous**: a memory can land after its delete; new profiles appear in listings late. | Delete twice, two minutes apart (0005). |
| **Agent Memory instructions are capped at 2000 characters**, documented only by the 422 error. | A test checks the length (0.4.1). |
| **The actor binding answered 401** after the first deploy. | Fixed once with `PUT /v2/compute/bindings/{id}`. |
| **`telnyx-edge secrets add` takes the value as an argument** (shell history, process list); `429` on `POST /v2/compute/secrets` during a deploy that sets about six. | The deploy uses the API with the value in the body; retry later on 429. |

## Friction

| Issue | Workaround here |
|---|---|
| **No `waitUntil`**: a function can't finish work after responding. | An actor task scheduled with delay 0 (the sign-in email, 0.4.2). |
| **No cron triggers** for functions. | Durable actor tasks (`schedule`, `every`), proposed for scouting (0010). |
| **Logs:** `actors logs` is capped at 250 lines and 24 hours and has no filters; a run's status endpoint can time out (504) while its actor is busy. | grep, and retry the status call. |
| **The class scanner breaks on backticks** in the actor's source file. | Long prompts live in their own modules (AGENTS.md rule). |
| **Qwen's reasoning used up the token budget** and returned empty answers. | `reasoning_effort: "none"` for the vision and tagging calls (0006). |
| **`conversationName` is private** in `@telnyx/acp`'s types though subclasses need it. | Ignored type errors (no type-check in the build). |
| **The generated entry point and managed deploy** were too rigid once the app grew, and in the beta exposed actor state streams without a token. | Own entry point and router; the loop used as a library (0001, 0007). |

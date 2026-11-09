# 0008. Public URL, TLS and custom domains

Status: accepted · Since: 0.3.0 · Revised: 0.4.0, 0.4.2

## Context

Every link the function produces has to be the address the reader uses: thumbs links in emails, the feedback page's change and undo links, view links, sign-in links. Two platform behaviours got in the way:

1. **TLS ends before the function.** Requests arrive as `http://`, and `X-Forwarded-Proto` and `Forwarded` say `http` too (they describe an internal hop). Links built from the request said `http://`, and the page's `Secure` session cookie didn't work.
2. **On a custom domain the original host is dropped.** We checked with a temporary debug route (removed afterwards), calling it through the custom domain and through the function's own address: in both cases `req.url`, `Host`, `X-Forwarded-Host` and `Forwarded` carried the function's `*.telnyxcompute.com` host, and `X-Forwarded-Proto: http` came with `X-Forwarded-Port: 443`. The custom domain appears nowhere, and the platform docs don't say what host a function sees. `@telnyx/acp`'s own link building reads `X-Forwarded-Host`, so it would get the wrong host too.

## Decision

- **`PUBLIC_URL` is the source of truth for the public address**, a Telnyx secret set by `npm run deploy`: from `.env` when set (a custom domain), otherwise the function's address (`Invoke URL`). Emails always use it.
- **The router rewrites every incoming request to the public address** before anything builds a link (`asPublic` in `src/router.ts`): the origin of `PUBLIC_URL` when set, otherwise the request's host as `https://`. Localhost (development) is left alone. (0.3.0 forced `https://`; 0.4.2 added the origin, after sign-in links pointed to the function's own address.)
- **A custom domain in `PUBLIC_URL` is declared in the manifest** (`[[domains]]` in the generated `telnyx.toml`, 0.4.0), next to `telnyx-edge domains add` / `verify`.
- **Certificates are brought, not issued**: Telnyx doesn't issue certificates for custom domains yet, so one is obtained elsewhere (e.g. Let's Encrypt with a DNS challenge) and uploaded with `telnyx-edge domains cert upload`; renewal is manual (`docs/SETUP.md`, "Custom domain").

## Alternatives

- **Trust `X-Forwarded-Proto` / `X-Forwarded-Host`.** They're overwritten by the platform's proxies (see above).
- **Build links only from `PUBLIC_URL`, never from the request.** Equivalent for links, but the feedback actor builds its page's links from the request it gets; rewriting the request once in the router fixes every such place at the same time.
- **Stay on the function's own address.** Works, but the address is long and tied to the function's id.

## Consequences

- A deployment on a custom domain needs `PUBLIC_URL` set; without it, links point to the function's own address (still working, just not the custom one).
- If the platform starts passing the original host, nothing breaks: `PUBLIC_URL` still wins.
- Reported to Telnyx; see [platform notes](telnyx-platform-notes.md).

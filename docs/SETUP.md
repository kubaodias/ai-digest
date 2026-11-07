# Setting up AI Digest on your Telnyx account

This guide takes you from nothing to a digest in your inbox. Everything runs on your own Telnyx account. Expect about 30 minutes, most of it waiting for DNS.

Throughout, `example.com` stands for your own domain.

## What you need

- A [Telnyx account](https://telnyx.com/sign-up) with billing set up. Edge Compute has a free monthly tier; inference, search and email are pay-as-you-go.
- A domain whose DNS you control, for sending email.
- Node.js 23.6 or newer, and git.
- Optional: Google Chrome, only to regenerate the documentation screenshots.

## 1. Create an API key

In the [Mission Control Portal](https://portal.telnyx.com), click your name (top right), then **API Keys**, then create a key. Copy it now; it's shown only once. See [Create and manage API keys](https://developers.telnyx.com/development/api-fundamentals/create-api-keys).

## 2. Install the CLI and sign in

```sh
npm install -g @telnyx/acp
telnyx-acp login
```

`telnyx-acp` is the [Agent Control Plane](https://developers.telnyx.com/docs/agents) CLI. It builds the agent, deploys it to [Edge Compute](https://developers.telnyx.com/docs/edge-compute/platform-overview) and manages its secrets. Check it works with `telnyx-acp models`, which lists the inference models on your account. This agent uses `deepseek-ai/DeepSeek-V4.1-Flash` for writing and `Qwen/Qwen3.8-27B` for judging pictures; both are hosted by Telnyx and need no other provider key.

## 3. Verify a sending domain

The digest is sent from an address on your domain, such as `digest@example.com`, through [Telnyx Email](https://developers.telnyx.com/docs/messaging/email/domains).

1. In the portal, open **Messaging → Email → Domains** and add your domain (or `POST /v2/email_domains` with `{"domain": "example.com"}`).
2. Telnyx shows the DNS records to publish. Add them at your DNS provider:

   | Record | Host | Value |
   |---|---|---|
   | TXT (ownership) | `example.com` | `telnyx-domain-verification=…` |
   | TXT (DKIM) | `telnyx1._domainkey.example.com` | `v=DKIM1; k=rsa; p=…` |
   | TXT (SPF) | `example.com` | add `include:spf.telnyx.com` to your SPF record |

   - **SPF:** if the domain already has an SPF record (for example for Google Workspace or your host's mail), *edit* it to add `include:spf.telnyx.com`, e.g. `v=spf1 include:_spf.google.com include:spf.telnyx.com ~all`. Two SPF records invalidate each other.
   - **MX:** you don't need Telnyx's MX record for sending. Leave your existing MX records alone, or your incoming mail would move to Telnyx.
   - **DKIM:** add the key as one TXT value, even if it's long; most DNS editors split it for you. Use the TXT type, not a provider-specific "DKIM" form that might reformat it.
   - **Existing TXT records:** keep them. Add the ownership record next to them.
3. Wait for the domain to show **verified** (Telnyx re-checks every 30 minutes, or trigger a check with `POST /v2/email_domains/{id}/verify`). Keep all three records afterwards: receivers check DKIM and SPF on every message.

More in [Domains](https://developers.telnyx.com/docs/messaging/email/domains) and [Deliverability](https://developers.telnyx.com/docs/messaging/email/deliverability).

## 4. Get the code and configure it

```sh
git clone https://github.com/kubaodias/ai-digest.git
cd ai-digest
npm install
git config filter.strip-deployed.clean "node scripts/strip-deployed.mjs"
git config filter.strip-deployed.smudge cat
cp .env.example .env
```

Edit `.env`:

| Setting | Required | What it is |
|---|---|---|
| `DIGEST_EMAIL_FROM` | yes | Sender on your verified domain, e.g. `digest@example.com` |
| `DIGEST_EMAIL_TO` | yes | Recipient(s), comma-separated |
| `TELNYX_API_KEY` | recommended | Your API key from step 1. Used to apply the Agent Memory settings |
| `PUBLIC_URL` | no | Leave empty; the first deploy fills it in |
| `DIGEST_MEMORY_PROFILE` | no | Agent Memory profile for your feedback (default `reader`) |
| `FEEDBACK_KEY` | no | Leave empty; a random link-signing key is generated and stored on Telnyx |
| `AGENT_AUTH_KEY` | no | Leave empty; an operator key is generated, stored on Telnyx and saved for the CLI (see below) |

`.env` is git-ignored. The deploy script stores these values as [Edge Compute secrets](https://developers.telnyx.com/docs/agents) on your account, where the agent reads them. `agent.json` only lists their names.

## 5. Deploy

```sh
npm run deploy
```

This:
1. runs the tests;
2. stores your settings as secrets;
3. deploys the agent (the first build takes a few minutes);
4. on the first deploy, sets `PUBLIC_URL` to the address it got and deploys again, since the thumbs links in emails need it;
5. creates the `ai-digest` [Agent Memory](https://developers.telnyx.com/docs/agent-memory) namespace and applies [the summary instructions](memory-summary-instructions.md), which keep the profile about your interests only.

`npx telnyx-acp status` shows the deployment and its address.

**Who can use the address.** Starting runs and reading the agent's state need an operator token. The deploy stores an auth key as the `AGENT_AUTH_KEY` secret and saves it in `~/.telnyx-acp/auth-keys.json`, where `telnyx-acp invoke`, `chat`, `eval` and `traces` find it and send the token for you. Anyone else gets refused. The feedback links in emails work for whoever has the email: each one carries its own signature.

## 6. Get your first digest

```sh
npx telnyx-acp invoke ai-digest --conversation first-digest \
  "Weekly digest: the most important AI and software engineering news from the past 7 days."
```

A digest takes 3–5 minutes. `invoke` stops waiting after about 30 seconds and may print *cannot reach … no answer in 30s*, but the run carries on, and the email arrives when it's done. Follow it with:

```sh
npx telnyx-acp traces first-digest      # steps, tool calls, timing
npx telnyx-acp logs --tail              # look for {"digestEmail":"sent"}
```

Any topic works the same way: `"Articles about agent frameworks from the last two weeks."`. Every reply that is a digest (numbered items) is emailed; other replies aren't.

## 7. Run it every week

There's no built-in schedule, so trigger it from anywhere that can run the CLI. Use a new conversation name each time. For example, a GitHub Actions workflow in your fork (`.github/workflows/weekly-digest.yml`):

```yaml
name: Weekly digest
on:
  schedule:
    - cron: "0 7 * * 1"   # Mondays 07:00 UTC
  workflow_dispatch:
jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm install -g @telnyx/acp
      - run: |
          telnyx-acp invoke ai-digest --conversation "weekly-$(date +%G-W%V)" \
            "Weekly digest: the most important AI and software engineering news from the past 7 days." || true
        env:
          TELNYX_API_KEY: ${{ secrets.TELNYX_API_KEY }}
          TELNYX_ACP_AUTH_KEY: ${{ secrets.TELNYX_ACP_AUTH_KEY }}
```

Add `TELNYX_API_KEY` and `TELNYX_ACP_AUTH_KEY` under the repository's **Settings → Secrets and variables → Actions**. The auth key is the value saved for your agent's address in `~/.telnyx-acp/auth-keys.json`; the CLI also reads it from the `TELNYX_ACP_AUTH_KEY` variable, which is how a CI runner or a teammate's machine authenticates. The `|| true` is because `invoke` returns before the run finishes; the email is sent regardless. Plain `cron` on any machine with the CLI works the same way.

## 8. Give feedback

Each item ends with grey **Useful? 👍 👎** links. A click records the vote and opens a page where you can say why: one or more of "I don't use *product*", "not interested in *topics*", "already knew this" (or, on 👍, "more about *company*", "*source* is a good source"). Click a selected reason again to deselect it. The next digest calls `reader_preferences`, gets your preferences, and ranks with them.

## Updating

```sh
git pull && npm install && npm run deploy
```

Each deploy is a new immutable version (`npx telnyx-acp versions ai-digest`). Your votes, stored digests and memory carry over.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `invoke` is refused (no reply, or an authorization error) and the log shows `{"auth":"refused"}` | This machine doesn't have the agent's auth key. Copy it into `~/.telnyx-acp/auth-keys.json` under the agent's address, or set `TELNYX_ACP_AUTH_KEY`. If it's lost, set a new `AGENT_AUTH_KEY` in `.env` and run `npm run deploy`. |
| `cannot reach … no answer in 30s` from `invoke` | Expected for long runs; the run continues. Check `traces` and `logs`. |
| Log says `missing secrets: …` | Add them to `.env` and run `npm run deploy`, or `telnyx-acp add secret NAME`. |
| Email arrives with no body | Something sent `text`/`html` instead of `text_body`/`html_body`; the Email API ignores unknown fields. This repo sends the right ones. |
| Email lands in spam or fails DMARC | Check the domain shows ownership, DKIM and SPF **verified**, and that there's only one SPF record. |
| Every request returns 500 with `hydration failed … fence … 401` | A stale storage token on the platform side. Updating the function's binding forces a new one: `GET /v2/compute/bindings`, then `PUT /v2/compute/bindings/{id}` with the same `binding_type` and `env_name`. |
| `reader_preferences` shows no memory summary | Agent Memory only builds the summary when asked; the agent asks (`refresh=true`) and waits up to a minute. It appears after your first votes. |
| Feedback links say *invalid or expired* | The link-signing key changed, or the link is older than 90 days. Keep `FEEDBACK_KEY` stable. |

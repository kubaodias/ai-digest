# Setting up AI Digest on your Telnyx account

This guide takes you from nothing to a digest in your inbox, on your own Telnyx account. Expect about 30 minutes, most of it waiting for DNS.

Throughout, `example.com` stands for your own domain.

## What you need

- A [Telnyx account](https://telnyx.com/sign-up) with billing set up. Edge Compute has a free monthly tier; inference, search and email are pay-as-you-go.
- A domain whose DNS you control, for sending email.
- Node.js 23.6 or newer, and git.
- Optional: Google Chrome, only to regenerate the documentation screenshots.

## 1. Create an API key

In the [Mission Control Portal](https://portal.telnyx.com), click your name (top right), then **API Keys**, then create a key. Copy it now; it's shown only once. See [Create and manage API keys](https://developers.telnyx.com/development/api-fundamentals/create-api-keys).

## 2. Install the Edge Compute CLI

Install `telnyx-edge` following the [Edge Compute docs](https://developers.telnyx.com/docs/edge-compute/platform-overview), then store your key:

```sh
telnyx-edge auth api-key set        # paste the key when asked
telnyx-edge status                  # checks the key and connectivity
```

The deploy script uses `telnyx-edge` to register and ship the function, and the key it stored for Telnyx API calls (secrets, Agent Memory settings). Alternatively, put the key in `.env` as `TELNYX_API_KEY` (step 4).

The agent uses two models hosted by Telnyx, with no other provider key needed: `deepseek-ai/DeepSeek-V4.1-Flash` for researching and writing, and `Qwen/Qwen3.8-27B` for judging pictures.

## 3. Verify a sending domain

Digests are sent from an address on your domain, such as `digest@example.com`, through [Telnyx Email](https://developers.telnyx.com/docs/messaging/email/domains).

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
cp .env.example .env
```

Edit `.env`:

| Setting | Required | What it is |
|---|---|---|
| `DIGEST_EMAIL_FROM` | yes | Sender on your verified domain, e.g. `digest@example.com` |
| `DIGEST_EMAIL_TO` | yes | Default recipient(s), comma-separated. A digest can override it with `to:` |
| `TELNYX_API_KEY` | no | Only if you didn't store it with `telnyx-edge auth api-key set` |
| `AGENT_AUTH_KEY` | no | Leave empty; the first deploy creates it and writes it here |
| `FEEDBACK_KEY` | no | Leave empty; a random link-signing key is generated and stored on Telnyx |
| `ADMIN_EMAIL` | no | Where sign-in links for the digests page go (default: the first `DIGEST_EMAIL_TO` address) |
| `FUNCTION_NAME` | no | The function's name on Edge Compute (default `ai-digest`) |

`.env` is git-ignored. The deploy stores the agent's settings as [Edge Compute secrets](https://developers.telnyx.com/docs/edge-compute/platform-overview) on your account, where the function reads them.

## 5. Define your digests

Each digest is one Markdown file in `digests/` (git-ignored, so your digests stay private). Start from an example:

```sh
mkdir -p digests
cp examples/digests/ai-swe.md digests/
cp examples/digests/agent-memory.md digests/
```

The file name is the digest's id (lowercase letters, digits and dashes). It's also the name of the digest's Agent Memory profile and the prefix of its runs. A file has settings between `---` lines, then a plain-English description:

```markdown
---
title: "Agent Memory Weekly — {range}"   # required: email subject and heading; {range} becomes the dates
window: 14d                               # optional: days to look back (1d–90d, default 7d)
items: 5-10                               # optional: how many items (default 5-15)
closing: Takeaways                        # optional: closing section heading, or "none" (default "Themes this week")
images: on                                # optional: pictures from the articles (default on)
to: team@example.com                      # optional: recipients instead of DIGEST_EMAIL_TO
scout: 6h                                 # optional: look for new stories every 6 hours (see step 9)
---
What to cover and who it's for, in a sentence or two (the first sentence is also
used to judge which pictures help this reader).

## Sources
Where to start looking.

## Leave out
What isn't wanted.
```

Only `title` and the description are required. Unknown settings or invalid values stop the upload with the file and the reason.

## 6. Deploy

```sh
npm run deploy
```

This:
1. runs the tests;
2. on the first run, registers the function on Edge Compute (`telnyx-edge new-func`);
3. stores your settings as secrets, creating `AGENT_AUTH_KEY` (written to `.env`) and `FEEDBACK_KEY`;
4. builds the function from `src/index.ts` and ships it (`telnyx-edge ship`); the first build takes a few minutes;
5. records the function's public URL in `.edge/function.json` (git-ignored) and, the first time, ships again so the links in emails point to it;
6. pushes your `digests/*.md`;
7. creates the `ai-digest` [Agent Memory](https://developers.telnyx.com/docs/agent-memory) namespace and applies [the summary instructions](memory-summary-instructions.md).

At the end it prints `…/v1/health`, which should return `{"ok": true, …}`.

## 7. Get your first digest

```sh
npm run digests -- run ai-swe
npm run digests -- run agent-memory "anything new on MCP memory servers"   # optional focus for this issue
```

Each run takes 3–5 minutes and is emailed when it's done. Follow one with the conversation name `run` prints:

```sh
npm run digests -- status agent-memory--2026-11-07t2155
telnyx-edge actors logs AiDigest --type runtime    # look for {"digestEmail":"sent"}
```

Other commands:

```sh
npm run digests -- list               # what's stored on the function
npm run digests -- push [id…]         # after editing files in digests/ (no redeploy needed)
npm run digests -- pull [id…]         # download what's stored into digests/
npm run digests -- show <id>
npm run digests -- delete <id>        # its sent issues, votes and memory stay
```

Editing a digest only needs `push`, not a deploy. The function keeps the last 10 versions of each definition.

### One-off digests on any topic

```sh
npm run digests -- ask "agent harnesses"
npm run digests -- ask "voice AI latency" --window 14d --items 5-8   # optional: window (1–90 days), items (1–30)
```

`ask` runs the built-in **General** digest (id `__general`): a template in [`src/general.ts`](../src/general.ts) whose `{topic}` is filled with yours, in the title and the description, and nothing else. It's emailed to `DIGEST_EMAIL_TO` with pictures and 👍/👎 links like any digest, and `status` follows it the same way (`ask` prints the conversation, e.g. `__general--agent-harnesses-2026-11-09t0712`). The topic is one line of at most 200 characters.

General has its own votes and Agent Memory profile, `__general`. A one-off run also reads the products and companies you explicitly marked "I don't use" or "more about" in your other digests; your regular digests read only the "I don't use" ones from one-offs ([how](HOW-IT-WORKS.md#shared-between-digests)). The id starts with `_`, which digest file names can't, so it never clashes with one of yours; `push`, `PUT` and `DELETE` refuse it.

## 8. Your digests page

The deploy prints its address: `https://<your function>/v1/app`. Open it and click **Email me a sign-in link**. The link goes to `ADMIN_EMAIL` (or the first `DIGEST_EMAIL_TO` address), works once and expires in 15 minutes; clicking it signs you in for 30 days on that browser. At most one link is sent per minute.

The page is read-only. It shows:
- **every digest:** its settings, last issue, vote count and memory size, plus a **General** card for one-off digests;
- **each digest:** its settings and description (and the raw file), its recent issues (each opens the sent email), what it learned from your votes, and its Agent Memory summary.

Sign-in links and sessions are signed with keys derived from `AGENT_AUTH_KEY`, so changing that key signs every browser out.

## 9. Let a digest scout on its own

Add `scout:` to a digest and it looks for new stories at a fixed interval, keeps them in a pool, and sends an issue when enough strong ones have gathered, or after `max_gap` at the latest, whatever the pool holds ([design](spec/0010-continuous-scouting.md)):

```yaml
scout: 6h          # a small research pass every 6 hours (1h–24h)
send_at: 6         # an issue once 6 stories score at least `strong` (default: the lower bound of items)
strong: 7          # the score that counts as strong, 1–10 (default 7)
min_gap: 2d        # never more often than this (default 2d)
max_gap: 7d        # at least this often, even with few strong stories (default 7d); an empty pool sends a short "nothing new" note
```

Push the file and the timer starts; the first pass runs a minute later. Every deploy re-arms the timers, and removing `scout:` (or the digest) stops it.

- **Scores** combine the model's importance estimate with how many independent sources covered a story, how many passes found it again, primary sources, your feedback, and age. A story mainly about a product you said you don't use never gets in.
- **Pictures** are only picked when an issue is sent, for the stories in it.
- **Follow it:** `npm run digests -- pool <id>` shows the pool, the next pass and why no issue has gone out yet; the digests page has the same card.
- **By hand:** `npm run digests -- run <id>` runs a pass and then writes an issue from the pool whatever the thresholds say (`--no-scout`: write from the pool now). `npm run digests -- scout <id> [--since 2026-11-02 --until 2026-11-04] [--no-send]` runs a pass now, optionally over a past window and without sending.
- **Cost:** each pass is a short research run (a budget of about 8 searches and page reads), so `scout: 6h` costs several times one weekly run. Use `12h` or `24h` for slow topics.

A digest without `scout:` keeps working on request. To run those on a schedule, trigger runs from anywhere that has the repo and `.env`, e.g. cron on a machine you control:

```cron
0 7 * * 1  cd /path/to/ai-digest && npm run digests -- run ai-swe
0 8 * * 4  cd /path/to/ai-digest && npm run digests -- run agent-memory
```

Or call the API directly, which only needs the function URL and the operator token:

```sh
curl -X POST "$URL/v1/digests/ai-swe/runs" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{}'
```

where `$TOKEN` is the hex HMAC-SHA256 of the text `telnyx-acp operator` keyed with `AGENT_AUTH_KEY` (`node -e "console.log(require('crypto').createHmac('sha256', process.env.AGENT_AUTH_KEY).update('telnyx-acp operator').digest('hex'))"`). In GitHub Actions, store `AGENT_AUTH_KEY` and the URL as repository secrets.

## 10. Give feedback

Each item ends with grey **Useful? 👍 👎** links. A click records the vote and opens a page where you can say why: one or more of "I don't use *product*", "not interested in *topics*", "already knew this" (or, on 👍, "more about *company*", "more on *topics*"). Click a selected reason again to deselect it. Votes count toward the digest they came from; the next issue of that digest ranks with them. Explicit "I don't use" / "more about" reasons are also shared between digests as described above.

## Custom domain (optional)

Your function's address looks like `https://ai-digest-xxxx.telnyxcompute.com`. To use your own, e.g. `digest.example.com`:

1. Map it to the function and verify it ([Telnyx custom domains](https://developers.telnyx.com/docs/edge-compute/custom-domains)):
   ```sh
   telnyx-edge domains add digest.example.com <function id from .edge/function.json>
   ```
   Publish the TXT record it prints, plus a CNAME from `digest` to your function's `…telnyxcompute.com` host, then run `telnyx-edge domains verify digest.example.com`.
2. Upload a certificate for the name. Telnyx doesn't issue certificates for custom domains yet. A free [Let's Encrypt](https://letsencrypt.org) certificate works, e.g. obtained with certbot and your DNS provider's plugin:
   ```sh
   telnyx-edge domains cert upload digest.example.com --cert fullchain.pem --key privkey.pem
   ```
   Let's Encrypt certificates last 90 days, so renew and upload again before they expire.
3. Set `PUBLIC_URL=https://digest.example.com` in `.env` and run `npm run deploy`. New emails, the digests page and sign-in links use the domain, and the deploy declares it in the function's manifest (`[[domains]]` in `.edge/telnyx.toml`). The `…telnyxcompute.com` address keeps working, so links in older emails do too.

## Updating

```sh
git pull && npm install && npm run deploy
```

Each ship is a new revision (`telnyx-edge revisions list ai-digest`). Votes, sent issues, digest definitions and memory carry over.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `npm run digests` says `401 … operator token` | `AGENT_AUTH_KEY` in `.env` doesn't match the function's secret. Run `npm run deploy` to store it again. |
| `push` says `✗ <id>: …` | The definition has a mistake; the message names the setting. |
| `run` says `no digest "<id>"` | Push it first: `npm run digests -- push <id>`. |
| `ask` says `invalid_run` | The topic is empty or over 200 characters, or `--window`/`--items` is out of range (1–90 days, 1–30 items). |
| No email after a run | `telnyx-edge actors logs AiDigest --type runtime`: look for `digestEmail` and `missing secrets`. Check the sender's domain is verified. (`telnyx-edge logs ai-digest` shows the function's own requests.) |
| Email lands in spam or fails DMARC | Check the domain shows ownership, DKIM and SPF **verified**, and that there's only one SPF record. |
| Every request returns 500 with `hydration failed … fence … 401` | A stale storage token on the platform side. Updating the function's binding forces a new one: `GET /v2/compute/bindings`, then `PUT /v2/compute/bindings/{id}` with the same `binding_type` and `env_name`. |
| Feedback links say *invalid or expired* | The link-signing key changed, or the link is older than 90 days. Keep `FEEDBACK_KEY` stable. |

## Upgrading from 0.1.x

0.1.x was deployed with `telnyx-acp`. `npm run deploy` in 0.2.0 keeps the same function: it reads the old `agent.json` deploy data once, saves it to `.edge/function.json`, and moves the operator key into `.env`. After that you can delete `agent.json`. The old feedback links (`/agents/ai-digest/feedback`) keep working. Votes from before 0.2.0 count toward the `ai-swe` digest.

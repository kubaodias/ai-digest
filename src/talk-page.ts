// The talk page (src/talk.ts has the links, tokens and tools): the issue as it
// looked in the email (its own HTML), with a voice dock at the bottom. Each
// story gets 👍/👎 with reasons and a "Discuss" button; while a conversation
// is live, Discuss switches it to that story without reconnecting.

import type { DigestRecord } from "./feedback.ts";
import { esc } from "./pages.ts";
import { b64url } from "./signing.ts";
import { DOWN_REASONS, ENTITY_OPTIONS, UP_REASONS, reasonLabel, type DownReason, type UpReason } from "./preferences.ts";
import { AGENT_LIB, headerValue, issueBrief } from "./talk.ts";
import { talkGreeting } from "./talk-instructions.ts";
import { ICON, TALK_CSS, TALK_SCRIPT } from "./talk-client.ts";
import { ISSUE_END, ISSUE_START } from "./email.ts";

export interface TalkPageInput {
  token: string;
  assistantId: string;
  record: DigestRecord;
  /** The story the link came from (item number). */
  start?: number;
  /** The issue's email body (HTML, with its inline styles); built from the items when missing. */
  body?: string;
  /** Votes already given on this issue: item number → vote and reasons. */
  votes: Record<number, { vote: string; reasons: { r: string; target?: string }[] }>;
  /** Start the conversation on load (a talk link); false for a thumbs click or view link from the email. */
  autostart?: boolean;
  /** The story just voted on from the email: its reasons are shown open. */
  voted?: number;
}

/** The issue without the email's frame: between the marks renderEmailHtml puts around it. */
export function emailBody(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const from = html.indexOf(ISSUE_START), to = html.indexOf(ISSUE_END);
  if (from >= 0 && to > from) return html.slice(from + ISSUE_START.length, to).replace(/^\n|\n$/g, "");
  // Issues sent before the marks: the email's content cell.
  return html.match(/<td style="padding:28px 28px 8px;[^"]*">\n?([\s\S]*?)\n?<\/td><\/tr>\s*<tr><td style="padding:14px 28px 22px/)?.[1];
}

/** A plain body for an issue whose HTML isn't stored. */
function bodyFromItems(record: DigestRecord): string {
  const items = record.items
    .map((i) => `<h2>${i.n}. ${esc(i.headline)}</h2><p>${esc(i.why)}</p>${i.url ? `<p><a href="${esc(i.url)}">${esc(i.source || i.url)}</a></p>` : ""}`)
    .join("\n");
  return `<h1>${esc(record.subject)}</h1>\n${items}`;
}

/** The reason chips for each vote, as on the feedback page. */
function reasonOptions(entities: string[], tags: string[]) {
  const opts = (vote: "up" | "down", list: readonly (UpReason | DownReason)[]) =>
    list.flatMap((r) =>
      r === "entity" && entities.length
        ? entities.slice(0, ENTITY_OPTIONS).map((e, x) => ({ r, x, target: e, label: reasonLabel(vote, r, [e], tags) }))
        : [{ r, label: reasonLabel(vote, r, entities, tags) }],
    );
  return { up: opts("up", UP_REASONS), down: opts("down", DOWN_REASONS) };
}

/**
 * Only the page's own script runs: a nonce for it, and whatever it imports (the voice library from
 * esm.sh). Scripts or handlers that got into the issue's HTML don't, nor do plugins, a <base> or forms.
 * Other directives fall back to "allow": the email's images and the call's connections come from many hosts.
 */
export function talkCsp(nonce: string): string {
  return [
    `script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}


export function talkPage({ token, assistantId, record, start, body, votes, autostart = true, voted }: TalkPageInput): Response {
  const brief = issueBrief(record);
  const greet = (s?: string) => headerValue(talkGreeting(brief.digest, brief.sent, brief.stories.length, s));
  const data = {
    token,
    assistantId,
    lib: AGENT_LIB,
    brief,
    start: start ?? null,
    autostart,
    voted: voted ?? null,
    digest: headerValue(brief.digest, 120),
    greeting: greet(),
    items: record.items.map((i) => ({
      n: i.n,
      headline: i.headline,
      greeting: greet(i.headline),
      reasons: reasonOptions(i.entities ?? [], i.tags ?? []),
    })),
    votes,
    icons: { mic: ICON.mic, micOff: ICON.micOff },
    // The issue's HTML goes to the page as data and is put in through an allowlist (cleanHtml below):
    // it was written by a model from web pages, and the page holds a talk token.
    body: body ?? bodyFromItems(record),
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#f5f5f4"><link rel="icon" href="data:,"><title>${esc(record.subject)}</title>
<style>${TALK_CSS}</style>
<script type="application/json" id="talk-data">${json}</script>
</head><body>
<div class="wrap"><article id="issue"></article></div>
<div class="dock" id="dock" data-s="idle"><div class="in">
<div class="viz" aria-hidden="true"><div class="ring" id="ring"></div><div class="orb" id="orb"></div></div>
<div class="txt"><div class="k" id="dk">Talk about this issue</div><div class="t" id="dt">${esc(brief.digest)} · ${esc(brief.sent)}</div></div>
<button class="start" id="go" type="button">Start</button>
<button class="round" id="mute" type="button" aria-pressed="false" aria-label="Mute" hidden>${ICON.mic}</button>
<button class="round end" id="end" type="button" aria-label="End" hidden>${ICON.end}</button>
</div></div>
<div class="toast" id="toast" role="status"></div>
<audio id="audio" autoplay playsinline></audio>
<script type="module" nonce="${nonce}">${TALK_SCRIPT}</script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer", "content-security-policy": talkCsp(nonce) } });
}

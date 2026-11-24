// Talking about an issue: signed links in the email, the conversation page,
// and the tools the voice assistant calls through it.
//
// The page starts a WebRTC conversation with a Telnyx AI Assistant (configured
// by `ai-digest deploy`). The assistant's tools are client-side: the page
// answers them, calling POST /v1/talk/tools/<name> with the link's signed
// token, so the assistant itself holds no credential and anyone without a
// link gets nothing from our tools.

import type { DigestItemRecord, DigestRecord } from "./feedback.ts";
import { b64url, fromB64url, hmac } from "./signing.ts";
import type { TelnyxPoster } from "./telnyx.ts";
import { ARTICLE_NOTES_PROMPT } from "./talk-instructions.ts";

/** How long a talk link works. */
export const TALK_TTL_S = 30 * 24 * 3600;

/**
 * The paid tools a talk link can use per day (UTC): per issue, and for the whole deployment. Counted per
 * issue, not per token, because opening the page mints a fresh token. A conversation uses a few of each.
 */
export const TALK_LIMITS = {
  issue: { search_web: 30, read_article: 15 },
  total: { search_web: 150, read_article: 60 },
} as const;
export type TalkTool = keyof typeof TALK_LIMITS.issue;
export interface TalkUsage {
  day: string;
  total: Partial<Record<TalkTool, number>>;
  issues: Record<string, Partial<Record<TalkTool, number>>>;
}

/**
 * Count one use of a paid tool for an issue: undefined when allowed (and counted), else what the assistant
 * should tell the listener. Mutates `use` synchronously, so callers sharing one object can't overspend.
 */
export function countTalkTool(use: TalkUsage, issue: string, tool: TalkTool, now = new Date()): string | undefined {
  const day = now.toISOString().slice(0, 10);
  if (use.day !== day) Object.assign(use, { day, total: {}, issues: {} });
  const mine = (use.issues[issue] ??= {});
  const what = tool === "search_web" ? "web searches" : "article reads";
  if ((use.total[tool] ?? 0) >= TALK_LIMITS.total[tool]) return `the daily limit of ${what} is used up; answer from what you know and say you can't look it up today`;
  if ((mine[tool] ?? 0) >= TALK_LIMITS.issue[tool]) return `the daily limit of ${what} for this issue is used up; answer from what you know and say you can't look it up again today`;
  use.total[tool] = (use.total[tool] ?? 0) + 1;
  mine[tool] = (mine[tool] ?? 0) + 1;
  return undefined;
}
/** The model that condenses an article (fast; answers in a few seconds without reasoning). */
const NOTES_MODEL = "Qwen/Qwen3.8-27B";
const ARTICLE_MAX_CHARS = 40_000;
/** The agent library, loaded by the page (it resolves the library's React import). */
export const AGENT_LIB = "https://esm.sh/@telnyx/ai-agent-lib@0.7.0";

export interface TalkClaim {
  /** The issue (DigestRecord id). */
  d: string;
  /** The story the listener came from (item number), if any. */
  i?: number;
  /** Expiry, unix seconds. */
  e: number;
}

// ── links ────────────────────────────────────────────────────────────────────

export function talkBase(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/v1/talk`;
}

export async function talkToken(key: string, claim: TalkClaim): Promise<string> {
  const encoded = b64url(new TextEncoder().encode(JSON.stringify(claim)));
  return `${encoded}.${await hmac(key, `talk:${encoded}`)}`;
}

export async function verifyTalkToken(key: string, token: string, now = Date.now()): Promise<TalkClaim | undefined> {
  const [encoded, sig] = (token ?? "").split(".");
  if (!encoded || !sig || (await hmac(key, `talk:${encoded}`)) !== sig) return undefined;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromB64url(encoded)));
    if (typeof c?.d !== "string" || typeof c?.e !== "number" || c.e < now / 1000) return undefined;
    if (c.i !== undefined && !Number.isInteger(c.i)) return undefined;
    return { d: c.d, e: c.e, ...(c.i !== undefined ? { i: c.i } : {}) };
  } catch {
    return undefined;
  }
}

/** The issue's talk link and one per story, in the order of `items`. */
export async function talkLinks(key: string, base: string, issueId: string, items: { n: number }[], now = Date.now()) {
  const e = Math.floor(now / 1000) + TALK_TTL_S;
  return {
    issue: `${base}?t=${await talkToken(key, { d: issueId, e })}`,
    stories: await Promise.all(items.map(async (it) => `${base}?t=${await talkToken(key, { d: issueId, i: it.n, e })}`)),
  };
}

const TOP_LINK = (href: string) =>
  `<p style="margin:0 0 18px;"><a href="${href}" style="display:inline-block;padding:8px 14px;border-radius:999px;background:#eef2ff;color:#3730a3;text-decoration:none;font-weight:600;font-size:14px;">🎧 Talk about this issue</a></p>`;
const STORY_LINK = (href: string) =>
  `<span style="padding:0 6px;color:#d1d5db;vertical-align:middle;">·</span><a href="${href}" style="color:#6b7280;text-decoration:none;vertical-align:middle;">🎧 Discuss</a>`;
/** The "Useful? 👍 👎" row closing each item (feedback.ts thumbsRow), as rendered. */
const THUMBS_ROW = /(<span[^>]*>Useful\?<\/span>(?:\s*<a\b[^>]*>[\s\S]*?<\/a>){2})/g;

/** Whether an issue (its HTML or text) already has talk links. */
export const hasTalkLinks = (s: string): boolean => s.includes("/v1/talk?t=");

/** The issue's own talk link in its HTML: the first one (the button under the title). */
export function issueTalkLink(html: string): string | undefined {
  return html.match(/href="([^"]*\/v1\/talk\?t=[^"]*)"/)?.[1];
}

/**
 * The email's HTML with a "Talk about this issue" button under the title and
 * a "Discuss" link in each story's thumbs row. Works on a stored issue's HTML
 * too; HTML that already has talk links is returned unchanged.
 */
export function addTalkLinks(html: string, links: { issue: string; stories: string[] }): string {
  if (hasTalkLinks(html)) return html;
  let k = 0;
  let out = html.replace(THUMBS_ROW, (row) => {
    const href = links.stories[k++];
    return href ? row + STORY_LINK(href) : row;
  });
  const h1 = out.indexOf("</h1>");
  if (h1 >= 0) out = out.slice(0, h1 + 5) + "\n" + TOP_LINK(links.issue) + out.slice(h1 + 5);
  return out;
}

/**
 * Point the issue's own links (thumbs, icons, view, talk) at `publicUrl`. Their signatures don't
 * include the host, so links built with a wrong public URL work again once rebased.
 */
export function rebaseLinks(html: string, publicUrl: string): string {
  const origin = new URL(publicUrl).origin;
  return html.replace(/https?:\/\/[a-z0-9.-]+(?::\d+)?(?=\/v1\/(?:feedback|assets|talk)\b)/gi, origin);
}

/** The plain-text part: the talk link first. */
export function addTalkLinkText(text: string, issueLink: string): string {
  return hasTalkLinks(text) ? text : `🎧 Talk about this issue: ${issueLink}\n\n${text}`;
}

// ── the issue as the assistant sees it ───────────────────────────────────────

/** "Agent Memory — Nov 1–14" → "Agent Memory". */
export function digestName(subject: string): string {
  return subject.split(/\s+[—–-]\s+/)[0]!.trim() || subject;
}

export function issueBrief(record: DigestRecord) {
  const day = new Date(record.sentAt).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return {
    digest: digestName(record.subject),
    subject: record.subject,
    sent: day,
    stories: record.items.map((i) => ({ story: i.n, headline: i.headline, summary: i.why, source: i.source })),
  };
}

/** SIP-safe (printable ASCII) header values: dynamic variables reach the assistant as X- headers. */
export function headerValue(s: string, max = 400): string {
  return s
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// ── tools ────────────────────────────────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** read_article: fetch the story's article and condense it into notes to talk from. */
export async function readArticle(telnyx: TelnyxPoster, item: DigestItemRecord, focus?: string) {
  if (!item.url) return { story: item.n, note: "This story has no article link." };
  const res: any = await telnyx.post("/web_search/contents", { body: { urls: [item.url], formats: ["markdown", "metadata"] } });
  const page = res?.data?.results?.[0];
  const text: string = page?.markdown ?? "";
  if (!text.trim()) return { story: item.n, source: item.source, note: "The article couldn't be read (the site may block readers)." };
  const answer: any = await telnyx.post("/ai/chat/completions", {
    body: {
      model: NOTES_MODEL,
      temperature: 0.2,
      max_tokens: 900,
      reasoning_effort: "none",
      messages: [{ role: "user", content: `${ARTICLE_NOTES_PROMPT(item.headline, focus)}\n\n---\n\n${clip(text, ARTICLE_MAX_CHARS)}` }],
    },
  });
  const notes = String(answer?.choices?.[0]?.message?.content ?? "").trim();
  return { story: item.n, source: item.source, ...(page?.title ? { title: page.title } : {}), notes: notes || "No notes: the model returned nothing." };
}

/** search_web: a few results with excerpts, for questions the article doesn't answer. */
export async function searchWeb(telnyx: TelnyxPoster, query: string) {
  const res: any = await telnyx.post("/web_search", { body: { query: clip(query, 300), count: 5 } });
  const all = [...(res?.data?.results?.web ?? []), ...(res?.data?.results?.news ?? [])].slice(0, 6);
  const results = all.map((r: any) => {
    let source = "";
    try {
      source = new URL(r.url).hostname.replace(/^www\./, "");
    } catch {}
    const excerpt = typeof r.description === "string" && r.description ? r.description : (Array.isArray(r.snippets) ? r.snippets.join(" ") : "");
    return { title: String(r.title ?? ""), source, excerpt: clip(excerpt, 500) };
  });
  return { results };
}

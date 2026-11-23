// Reader feedback: grey thumbs links under each digest item in the email.
//
// When a digest is emailed, its items (headline, summary, article URL, source,
// topic tags, entities, picked image) and the email itself are stored in the
// `feedback` conversation's durable state. Each thumbs link carries only a
// signed {digest, item, vote, expiry} (HMAC-SHA256, FEEDBACK_KEY secret); the
// thanks page offers reason links ("I don't use Postman", "not interested in
// this topic", "already knew"; on 👍 "more about Postman", "more on this
// topic"), signed the same way plus `r`.
// The `feedback` actor keeps every vote exactly (one per item) and writes one
// sentence per vote, worded by its reason, into Agent Memory (namespace
// ai-digest, profile = the digest's id, session fb-<digest>-<item>; rewritten in place on
// change, deleted on undo). preferences.ts turns the votes into entity and
// topic preferences, and shares explicit entity reasons between digests;
// `reader_preferences` hands them to the model.

import { digestSections } from "./digest.ts";
import { computePreferences, selectionsOf, toggleSelection, validEntityIndex, validReason, type Preferences, type Reason, type Selection, type Vote } from "./preferences.ts";
import { b64url, fromB64url, hmac } from "./signing.ts";
import type { TelnyxClient } from "./telnyx.ts";


/** The feedback URL under the function's public URL: thumbs links and the digest web view (API v1). */
export function feedbackBase(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/v1/feedback`;
}

/** Where the icons are served, for a feedback URL (old /agents/… links included). */
export function assetUrl(base: string, name: string): string {
  return `${new URL(base).origin}/v1/assets/${name}`;
}
/** Links stop working after this long. */
const LINK_TTL_S = 90 * 24 * 3600;
/** How many past digests the feedback actor keeps (with their email HTML). */
export const KEEP_DIGESTS = 12;
/** How many past issues it keeps at most (older than KEEP_DIGESTS without their HTML, and only while their talk links last). */
export const KEEP_ISSUES = 200;
/** How far talkUntil may lag behind the newest link: keepIssueUntil skips smaller moves, so retention adds this much. */
export const TALK_UNTIL_SLACK_MS = 86400_000;

/**
 * What to change in the stored issues when a new one is kept: the newest KEEP_DIGESTS stay as they are;
 * older ones lose their HTML and stay while their talk links are valid (ttlMs after sending, or until
 * talkUntil plus TALK_UNTIL_SLACK_MS), up to KEEP_ISSUES in all. `older` excludes the new issue. null drops an issue.
 */
export function retainIssues(older: DigestRecord[], now: number, ttlMs: number): Record<string, DigestRecord | null> {
  const out: Record<string, DigestRecord | null> = {};
  const until = (d: DigestRecord) => Math.max(Date.parse(d.sentAt) + ttlMs, d.talkUntil ? Date.parse(d.talkUntil) + TALK_UNTIL_SLACK_MS : 0);
  [...older].sort((a, b) => b.sentAt.localeCompare(a.sentAt)).forEach((d, i) => {
    const n = i + 1; // the new issue is first
    if (n < KEEP_DIGESTS) return;
    if (n >= KEEP_ISSUES || now > until(d)) out[d.id] = null;
    else if (d.html) out[d.id] = { ...d, html: "" };
  });
  return out;
}
const TAG_MODEL = "Qwen/Qwen3.8-27B";

export type { Reason, Vote } from "./preferences.ts";

/** What a thumbs link carries (signed). */
export interface FeedbackPayload {
  d: string; // digest id
  i: number; // item number, as in "## 3."
  v: Vote;
  e: number; // expiry, unix seconds
  r?: Reason; // why, chosen on the thanks page
  x?: number; // for r = "entity": which of the item's entities (index)
}

export interface DigestItemRecord {
  n: number;
  headline: string;
  why: string;
  url?: string;
  source: string;
  tags: string[];
  /** The specific products, companies or projects the item is about. */
  entities?: string[];
  image?: { url: string; caption: string };
}

export interface DigestRecord {
  id: string;
  /** Which digest (definition) this issue belongs to; preferences and memory are kept per digest. */
  profile?: string;
  /** For a General (one-off) issue: the topic it was asked about. */
  topic?: string;
  subject: string;
  sentAt: string;
  items: DigestItemRecord[];
  /** The email's HTML, served as the digest's web view. */
  html?: string;
  /** When talk links added after sending (a resend) expire; the issue is kept until then. */
  talkUntil?: string;
}

export interface StoredVote {
  digest: string;
  item: number;
  headline: string;
  tags: string[];
  entities?: string[];
  source: string;
  url?: string;
  vote: Vote;
  /** Which digest the voted item came from (votes count only toward that digest). */
  profile?: string;
  /** For a vote on a General (one-off) issue: its topic. */
  topic?: string;
  /** The reasons the reader selected on the thanks page (toggled one at a time). */
  reasons?: Selection[];
  /** Older single-reason votes; read through selectionsOf. */
  reason?: Reason;
  target?: string;
  at: string;
  memorySource?: string;
}

// ── signing ──────────────────────────────────────────────────────────────────

export async function verifyPayload(key: string, encoded: string, sig: string): Promise<FeedbackPayload | undefined> {
  if (!encoded || !sig || (await hmac(key, encoded)) !== sig) return undefined;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(encoded))) as FeedbackPayload;
    if ((p.v !== "up" && p.v !== "down") || typeof p.d !== "string" || typeof p.i !== "number") return undefined;
    if (p.e < Date.now() / 1000) return undefined;
    if (p.r !== undefined && !validReason(p.v, p.r)) return undefined;
    if (p.x !== undefined && (p.r !== "entity" || !validEntityIndex(p.x))) return undefined;
    return { d: p.d, i: p.i, v: p.v, e: p.e, ...(p.r ? { r: p.r } : {}), ...(p.x !== undefined ? { x: p.x } : {}) };
  } catch {
    return undefined;
  }
}

export async function feedbackLink(key: string, base: string, p: FeedbackPayload, extra = ""): Promise<string> {
  const encoded = b64url(new TextEncoder().encode(JSON.stringify(p)));
  return `${base}?p=${encoded}&s=${await hmac(key, encoded)}${extra}`;
}

/** The signed link to a stored digest's web view. */
export async function viewLink(key: string, base: string, digestId: string): Promise<string> {
  return `${base}?view=${encodeURIComponent(digestId)}&s=${await hmac(key, `view:${digestId}`)}`;
}

export async function verifyView(key: string, digestId: string, sig: string): Promise<boolean> {
  return !!digestId && !!sig && (await hmac(key, `view:${digestId}`)) === sig;
}

// ── items and tags ───────────────────────────────────────────────────────────

/** The digest's items: number, headline, summary, article URL (first non-HN link, else the HN thread) and its domain. */
export function digestItems(markdown: string): Omit<DigestItemRecord, "tags" | "entities" | "image">[] {
  const numbers = [...markdown.matchAll(/^##\s+(\d+)\./gm)].map((m) => Number(m[1]));
  return digestSections(markdown).map((s, k) => {
    const url = s.links.find((u) => !/news\.ycombinator\.com/.test(u)) ?? s.links[0];
    let source = "";
    try {
      source = url ? new URL(url).hostname.replace(/^www\./, "") : "";
    } catch {}
    return { n: numbers[k] ?? k + 1, headline: s.headline, why: s.context, url, source };
  });
}

export interface ItemTags {
  tags: string[];
  entities: string[];
}

/** Parse the tagger's answer; anything malformed becomes empty lists (feedback still works). */
export function parseTags(text: string, count: number): ItemTags[] {
  let items: unknown[] = [];
  try {
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    items = Array.isArray(j.items) ? j.items : [];
  } catch {}
  const clean = (x: unknown) => (Array.isArray(x) ? x.map((t) => String(t).toLowerCase().trim().slice(0, 30)).filter(Boolean).slice(0, 3) : []);
  return Array.from({ length: count }, (_, k) => {
    const it = (items[k] ?? {}) as { topics?: unknown; entities?: unknown };
    return { tags: clean(it.topics), entities: clean(it.entities) };
  });
}

/**
 * Per item, 2–3 topic tags (what it's about in general) and 0–3 entities (the
 * specific products, companies or projects it's about), from one text-only
 * model call. Empty lists on failure.
 */
export async function tagItems(telnyx: TelnyxClient, items: { headline: string; why: string }[]): Promise<ItemTags[]> {
  if (!items.length) return [];
  const list = items.map((it, k) => `${k + 1}. ${it.headline} — ${it.why.slice(0, 240)}`).join("\n");
  try {
    const res = await telnyx.post("/ai/chat/completions", {
      body: {
        model: TAG_MODEL,
        temperature: 0,
        max_tokens: 1200,
        reasoning_effort: "none",
        messages: [
          {
            role: "user",
            content: `For each news item give:\n- "topics": 2-3 short lowercase topic tags a reader could have a preference about (e.g. "open-weight models", "coding agents", "security", "funding", "c++", "voice ai", "dev tooling", "policy"). Reuse the same tag for the same topic across items.\n- "entities": 0-3 lowercase names of the specific products, companies, projects or people the item is about, the main subject FIRST (e.g. for "Postman silently installed plugins into Codex": ["postman", "codex"]). Leave out ones only mentioned in passing.\n\n${list}\n\nAnswer with JSON only: {"items": [{"topics": ["..."], "entities": ["..."]}, ...]} with exactly ${items.length} entries, in order.`,
          },
        ],
      },
    });
    return parseTags(res?.choices?.[0]?.message?.content ?? "", items.length);
  } catch (err) {
    console.log(JSON.stringify({ feedback: "tagging failed", error: err instanceof Error ? err.message : String(err) }));
    return items.map(() => ({ tags: [], entities: [] }));
  }
}

/** The thumbs row closing each item: grey outline icons with a small label, left-aligned and spaced away from any image above. */
export function thumbsRow(base: string, up: string, down: string): string {
  const icon = (href: string, name: string, label: string) =>
    `<a style="text-decoration:none;display:inline-block;padding:2px 4px;vertical-align:middle;" href="${href}" title="${label}" aria-label="${label}"><img src="${assetUrl(base, name)}" width="16" height="16" alt="${label}" style="display:block;width:16px;height:16px;border:0;"></a>`;
  return `\n\n<div style="margin:14px 0 0;line-height:16px;font-size:12px;color:#9ca3af;"><span style="vertical-align:middle;padding-right:4px;">Useful?</span>${icon(up, "thumb-up.png", "More like this")}${icon(down, "thumb-down.png", "Less like this")}</div>\n\n`;
}

/**
 * The email Markdown with a thumbs row closing each item, and the digest's
 * record for the feedback actor. `source` is the digest as written (its links
 * name the articles); `html` is the same digest with pictures inserted.
 */
export async function addFeedbackLinks(
  telnyx: TelnyxClient,
  key: string,
  base: string,
  digestId: string,
  subject: string,
  source: string,
  html: string,
  images: { url: string; caption: string }[][],
): Promise<{ markdown: string; record: DigestRecord }> {
  const items = digestItems(source);
  const tags = await tagItems(telnyx, items);
  const record: DigestRecord = {
    id: digestId,
    subject,
    sentAt: new Date().toISOString(),
    items: items.map((it, k) => ({ ...it, tags: tags[k]?.tags ?? [], entities: tags[k]?.entities ?? [], ...(images[k]?.[0] ? { image: images[k]![0] } : {}) })),
  };
  const e = Math.floor(Date.now() / 1000) + LINK_TTL_S;
  const sections = digestSections(html);
  let out = html;
  for (let k = sections.length - 1; k >= 0; k--) {
    const n = items[k]?.n ?? k + 1;
    const row = thumbsRow(base, await feedbackLink(key, base, { d: digestId, i: n, v: "up", e }), await feedbackLink(key, base, { d: digestId, i: n, v: "down", e }));
    const end = sections[k]!.end;
    out = out.slice(0, end).replace(/\s*$/, "") + row + out.slice(end);
  }
  return { markdown: out, record };
}

// ── recording ────────────────────────────────────────────────────────────────

/**
 * The vote after a click. A reason link (`r`, and `x` for which entity)
 * toggles that reason: selected → deselected, otherwise added; the direction
 * stays and several reasons can be selected. A plain thumbs click on an item
 * already voted the same way changes nothing (its reasons stay). A flip starts
 * a new vote without reasons. `changed` says whether memory needs rewriting.
 */
export function nextVote(
  prior: StoredVote | undefined,
  p: FeedbackPayload,
  item: DigestItemRecord | undefined,
  now: string,
): { vote: StoredVote; changed: boolean } {
  const base = (): StoredVote => ({
    digest: p.d,
    item: p.i,
    vote: p.v,
    at: now,
    headline: item?.headline ?? prior?.headline ?? "",
    tags: item?.tags ?? prior?.tags ?? [],
    entities: item?.entities?.length ? item.entities : (prior?.entities ?? []),
    source: item?.source ?? prior?.source ?? "",
    ...((item?.url ?? prior?.url) ? { url: item?.url ?? prior?.url } : {}),
  });
  if (p.r) {
    const same = prior && prior.vote === p.v;
    const v: StoredVote = same ? { ...prior!, at: now } : base();
    // "I don't use X": x picks the entity; without x (an item tagged before entities existed) it means the main one.
    const target = p.r === "entity" ? (p.x !== undefined ? v.entities?.[p.x] : v.entities?.[0]) : undefined;
    v.reasons = toggleSelection(selectionsOf(v), { r: p.r, ...(target ? { target } : {}) });
    delete v.reason;
    delete v.target;
    return { vote: v, changed: true };
  }
  if (prior && prior.vote === p.v) return { vote: prior, changed: false };
  return { vote: base(), changed: true };
}

/** The reader's preferences from the vote log (see preferences.ts). */
export function preferencesFrom(votes: StoredVote[]): Preferences {
  return computePreferences(votes);
}


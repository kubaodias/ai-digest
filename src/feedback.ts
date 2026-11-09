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

import { digestSections } from "./images.ts";
import {
  computePreferences, memorySentence, reasonLabel, selectionsOf, toggleSelection, validReason, DOWN_REASONS, UP_REASONS,
  type Preferences, type Reason, type Selection,
} from "./preferences.ts";

/** The conversation (actor) that owns the vote log and the stored digests. */
export const FEEDBACK_CONVERSATION = "feedback";
export const MEMORY_NAMESPACE = "ai-digest";

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
const TAG_MODEL = "Qwen/Qwen3.8-27B";

export type Vote = "up" | "down";
export type { Reason } from "./preferences.ts";

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

export interface TelnyxClient {
  get(path: string, opts?: unknown): Promise<any>;
  post(path: string, opts: { body?: unknown; query?: Record<string, string> }): Promise<any>;
  delete(path: string, opts?: unknown): Promise<any>;
}

// ── signing ──────────────────────────────────────────────────────────────────

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return b64url(sig.subarray(0, 18));
}

export async function verifyPayload(key: string, encoded: string, sig: string): Promise<FeedbackPayload | undefined> {
  if (!encoded || !sig || (await hmac(key, encoded)) !== sig) return undefined;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(encoded))) as FeedbackPayload;
    if ((p.v !== "up" && p.v !== "down") || typeof p.d !== "string" || typeof p.i !== "number") return undefined;
    if (p.e < Date.now() / 1000) return undefined;
    if (p.r !== undefined && !validReason(p.v, p.r)) return undefined;
    if (p.x !== undefined && (p.r !== "entity" || !Number.isInteger(p.x) || p.x < 0 || p.x > 2)) return undefined;
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
function thumbsRow(base: string, up: string, down: string): string {
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

const memoryBase = (profile: string) => `/ai/memory/namespaces/${MEMORY_NAMESPACE}/profiles/${encodeURIComponent(profile)}`;

/** Write (or rewrite in place) the memory for one vote; returns the memory source id. */
export async function rememberVote(telnyx: TelnyxClient, profile: string, v: StoredVote): Promise<string | undefined> {
  const res = await telnyx.post(`${memoryBase(profile)}/ingest`, {
    query: { session_id: `fb-${v.digest}-${v.item}` },
    body: { messages: [{ role: "user", content: memorySentence(v) }] },
  });
  return res?.data?.source_id ?? res?.source_id;
}

export async function forgetVote(telnyx: TelnyxClient, profile: string, memorySource: string | undefined): Promise<void> {
  if (memorySource) await telnyx.delete(`${memoryBase(profile)}/sources/${encodeURIComponent(memorySource)}`);
}

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

// ── pages ────────────────────────────────────────────────────────────────────

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const icon = (base: string, name: "thumb-up.png" | "thumb-down.png", size = 18) => `<img src="${assetUrl(base, name)}" width="${size}" height="${size}" alt="" style="vertical-align:-3px">`;

export function page(title: string, body: string, status = 200, opts: { css?: string; headers?: Record<string, string>; wide?: boolean } = {}): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{--bg:#f5f5f4;--card:#fff;--ink:#1f2937;--muted:#6b7280;--faint:#9ca3af;--line:#e5e7eb;--link:#2563eb;--chip:#f3f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--card:#1b1e21;--ink:#e5e7eb;--muted:#a1a7b0;--faint:#7c838d;--line:#2c3036;--link:#7aa7ff;--chip:#262a2f}}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:620px;margin:6vh auto;padding:0 16px}
.card{background:var(--card);border-radius:12px;padding:24px;margin-bottom:14px;border:1px solid var(--line)}
h1{font-size:20px;line-height:1.35;margin:0 0 14px}h1 a{color:var(--ink)}h2{font-size:18px;margin:0 0 6px;display:flex;align-items:center;gap:10px}
p{line-height:1.55;margin:8px 0}.card>:first-child{margin-top:0}.muted{color:var(--muted);font-size:14px}.faint{color:var(--faint);font-size:13px}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.chip{background:var(--chip);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--muted)}
.row{display:flex;flex-wrap:wrap;gap:18px;margin-top:14px;font-size:14px}
img.pic{display:block;width:100%;height:auto;border-radius:8px;border:1px solid var(--line);margin:12px 0 4px;background:#fff}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 0;border-top:1px solid var(--line)}td.n{text-align:right;color:var(--muted);white-space:nowrap;padding-left:12px}
.label{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);margin:0 0 8px}
.reasons{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.reason{border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-size:13px;color:var(--muted)}
.reason.on{border-color:var(--link);color:var(--link)}.reason:hover{text-decoration:none;border-color:var(--faint)}
footer{display:flex;align-items:center;justify-content:center;gap:8px;margin:22px 0 40px;font-size:12px;color:var(--faint)}footer a{color:var(--faint);text-decoration:underline}footer img{width:18px;height:18px}
${opts.wide ? "main{max-width:880px}" : ""}${opts.css ?? ""}
</style></head><body><main>${body}<footer><span>AI Digest · made with <a href="https://telnyx.com/products/edge-compute">Telnyx Edge Compute</a></span><img src="https://www.activepieces.com/piece-icon/telnyx" width="18" height="18" alt="Telnyx"></footer></main>
<script>
// Reason, change and undo links update this page in place and replace its history entry,
// so one Back goes to the email however many times the reader clicked. Without JS they're plain links.
document.addEventListener("click", async (e) => {
  const a = e.target.closest && e.target.closest("a[data-inplace]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  try {
    const r = await fetch(a.href, { credentials: "same-origin" });
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    const next = doc.querySelector("main");
    if (!next) throw new Error("no page");
    document.querySelector("main").replaceWith(next);
    document.title = doc.title;
    history.replaceState(null, "", a.href);
  } catch {
    location.replace(a.href);
  }
});
</script></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...(opts.headers ?? {}) } },
  );
}

export interface ThanksContext {
  /** This page's feedback URL (icons are served from it). */
  base: string;
  vote: StoredVote;
  item?: DigestItemRecord;
  digest?: DigestRecord;
  prefs: Preferences;
  /** Reason links by option: "entity:0".."entity:2" (one per entity), "entity" (no entities known), "topic", "known". */
  links: { undo: string; flip: string; view?: string; reasons: Record<string, string> };
}

/** What the selected reasons (or none) do with the vote, one sentence each. */
export function effect(v: StoredVote, entities: string[], tags: string[]): string {
  const more = v.vote === "up";
  const top = tags.join(", ") || "its topics";
  const sels = selectionsOf(v);
  if (!sels.length) {
    return `Without a reason this counts mostly toward ${entities[0] || "this product or company"}, and only a little toward ${top}. Topics need a few votes the same way before they change anything.`;
  }
  const parts = sels.map((sel) => {
    const ent = sel.target ?? entities[0] ?? "this product or company";
    switch (sel.r) {
      case "entity":
        return more ? `Items mainly about ${ent} will rank higher.` : `Items mainly about ${ent} will be skipped.`;
      case "topic":
        return more ? `${top} will rank higher.` : `${top} will rank lower. Major news still gets through.`;
      default:
        return "Noted as too obvious.";
    }
  });
  if (!sels.some((x) => x.r === "topic") && sels.some((x) => x.r === "entity")) parts.push(`Its topics (${top}) aren't affected.`);
  return parts.join(" ");
}

export function thanksPage(c: ThanksContext): Response {
  const up = c.vote.vote === "up";
  const it = c.item;
  const headline = it?.headline ?? c.vote.headline;
  const tags = it?.tags ?? c.vote.tags;
  const entities = it?.entities?.length ? it.entities : (c.vote.entities ?? []);
  const source = it?.source ?? c.vote.source;
  const sels = selectionsOf(c.vote);
  const options: { key: string; label: string; on: boolean }[] = [];
  for (const r of up ? UP_REASONS : DOWN_REASONS) {
    if (r === "entity") {
      entities.slice(0, 3).forEach((e, k) => {
        if (c.links.reasons[`entity:${k}`]) options.push({ key: `entity:${k}`, label: reasonLabel(c.vote.vote, r, [e], tags), on: sels.some((x) => x.r === "entity" && (x.target ?? entities[0]) === e) });
      });
      if (!entities.length && c.links.reasons.entity) options.push({ key: "entity", label: reasonLabel(c.vote.vote, r, [], tags), on: sels.some((x) => x.r === "entity") });
    } else if (c.links.reasons[r]) {
      options.push({ key: r, label: reasonLabel(c.vote.vote, r, entities, tags), on: sels.some((x) => x.r === r) });
    }
  }
  const chips = options
    .map((o) => `<a class="reason${o.on ? " on" : ""}" data-inplace href="${c.links.reasons[o.key]}" aria-pressed="${o.on}" title="${o.on ? "Selected: click to deselect" : "Click to select"}">${o.on ? "✓ " : ""}${esc(o.label)}</a>`)
    .join("");
  const relevant = (list: { name: string; direction: string; score: number; votes: number }[], names: string[]) =>
    list.filter((p) => names.includes(p.name)).map((p) => `<tr><td>${esc(p.name)}</td><td class="n">${p.direction === "more" ? icon(c.base, "thumb-up.png", 14) : icon(c.base, "thumb-down.png", 14)} ${p.direction} · ${p.votes} vote${p.votes > 1 ? "s" : ""}</td></tr>`);
  const rows = [
    ...relevant(c.prefs.entities, entities),
    ...relevant(c.prefs.topics, tags),
    ...relevant(c.prefs.tentativeTopics, tags).map((r) => r.replace("</td><td", " <span class=\"faint\">(not enough votes yet)</span></td><td")),
  ].join("");
  return page(
    up ? "More like this" : "Less like this",
    `<h1>${it?.url ? `<a href="${esc(it.url)}">${esc(headline)}</a>` : esc(headline)}</h1>
<div class="card">
  <h2>${icon(c.base, up ? "thumb-up.png" : "thumb-down.png", 22)} ${up ? "More like this" : "Less like this"}</h2>
  <p class="muted">Saved. ${sels.length ? "Your reasons are selected below; click one to deselect it." : "Why? Select all that apply:"}</p>
  ${chips ? `<div class="reasons">${chips}</div>` : ""}
  <div class="row"><a data-inplace href="${c.links.flip}">${up ? "Change to less like this" : "Change to more like this"}</a><a data-inplace href="${c.links.undo}">Undo</a>${c.links.view ? `<a href="${c.links.view}">View the digest</a>` : ""}</div>
</div>
<div class="card">
  ${it?.why ? `<p>${esc(it.why)}</p>` : ""}
  ${it?.image ? `<img class="pic" src="${esc(it.image.url)}" alt="${esc(it.image.caption)}"><p class="faint">${esc(it.image.caption)}</p>` : ""}
  <p class="faint">${it?.url ? `<a href="${esc(it.url)}">${esc(source || it.url)}</a>` : esc(source)}</p>
  ${entities.length || tags.length ? `<div class="chips">${[...entities.map((e) => `<span class="chip"><strong>${esc(e)}</strong></span>`), ...tags.map((t) => `<span class="chip">${esc(t)}</span>`)].join("")}</div>` : ""}
</div>
<div class="card">
  <p class="label">What this feeds</p>
  <p class="muted">${esc(effect(c.vote, entities, tags))}</p>
  ${rows ? `<table>${rows}</table>` : ""}
  <p class="faint">${c.prefs.votes} vote${c.prefs.votes === 1 ? "" : "s"} so far. Kept in the agent's vote log and its Agent Memory.</p>
</div>`,
  );
}

export function undonePage(headline: string, view?: string): Response {
  return page(
    "Feedback removed",
    `<div class="card"><h2>Feedback removed</h2><p class="muted">${esc(headline)}</p>${view ? `<div class="row"><a href="${view}">View the digest</a></div>` : ""}</div>`,
  );
}

export function errorPage(status: number, message: string): Response {
  return page("Feedback", `<div class="card"><h2>That link didn't work</h2><p class="muted">${esc(message)}</p></div>`, status);
}

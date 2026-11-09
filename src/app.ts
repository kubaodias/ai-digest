// The digests page (read-only): /v1/app. Sign-in is a magic link emailed to
// the admin address; a click sets a signed session cookie. Tokens are signed
// with keys derived from AGENT_AUTH_KEY (no extra secret), so rotating that
// key signs everyone out.
//
//   GET  /v1/app                  your digests          (session)
//   GET  /v1/app/digests/<id>     one digest            (session; __general is the built-in General digest)
//   GET  /v1/app/sign-in          the sign-in page
//   POST /v1/app/sign-in          email a sign-in link   (rate-limited)
//   GET  /v1/app/auth?t=…         use a sign-in link     (15 minutes, once)
//   GET  /v1/app/sign-out

import { marked } from "marked";
import { esc, errorPage, page, viewLink } from "./feedback.ts";
import type { Preferences } from "./preferences.ts";
import { GENERAL_ID, generalProfile, isDigestId, parseProfile, type DigestProfile } from "./profile.ts";
import { GENERAL_TEMPLATE } from "./general.ts";

export const SESSION_COOKIE = "aid_session";
export const SESSION_DAYS = 30;
export const MAGIC_MINUTES = 15;
export const MAGIC_EVERY_SECONDS = 60;
const APP = "/v1/app";

// ── tokens ───────────────────────────────────────────────────────────────────

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function mac(key: string, purpose: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`ai-digest ${purpose}:${data}`))));
}

/** A signed, expiring token for one purpose ("session" or "magic"). */
export async function signToken(key: string, purpose: string, payload: Record<string, unknown>): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await mac(key, purpose, body)}`;
}

export async function verifyToken(key: string, purpose: string, token: string | undefined, now = Date.now()): Promise<Record<string, any> | undefined> {
  if (!token || !key) return undefined;
  const [body, sig] = token.split(".");
  if (!body || !sig || (await mac(key, purpose, body)) !== sig) return undefined;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return typeof p.exp === "number" && p.exp * 1000 > now ? p : undefined;
  } catch {
    return undefined;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${APP}; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearCookie = `${SESSION_COOKIE}=; Path=${APP}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/** k*****t@example.com: the first and last character, and a fixed number of stars (the length stays hidden). */
export function maskEmail(a: string): string {
  const at = a.lastIndexOf("@");
  const user = a.slice(0, at);
  const domain = a.slice(at + 1);
  if (at < 1 || !domain) return "your address";
  return `${user[0]}*****${user.length > 1 ? user[user.length - 1] : ""}@${domain}`;
}

// ── what the pages show ─────────────────────────────────────────────────────

export interface StoredDigest {
  id: string;
  markdown: string;
  updatedAt: string;
  versions: number;
}
/** What the digests actor's listDigests() returns: a summary per digest (no definition text). */
export interface DigestSummary {
  id: string;
  title: string | null;
  windowDays: number | null;
  items: { min: number; max: number } | null;
  schedule: string | null;
  updatedAt: string;
  versions: number;
}
export interface IssueSummary {
  id: string;
  profile: string;
  /** For General (one-off) issues: the topic. */
  topic?: string;
  subject: string;
  sentAt: string;
  items: number;
}
export interface Overview {
  issues: IssueSummary[];
  votes: Record<string, number>;
}

const css = `
.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:0 0 18px}.top h1{margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.grid .card{margin:0;display:flex;flex-direction:column;gap:6px}.grid .card h2{font-size:17px;margin:0}
.id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--faint)}
.kv{width:100%;border-collapse:collapse;font-size:14px}.kv td{padding:6px 0;border-top:1px solid var(--line);vertical-align:top}.kv td:first-child{color:var(--muted);width:34%;padding-right:12px}
.desc{line-height:1.6}.desc h2,.desc h3{font-size:15px;margin:16px 0 6px}.desc ul{padding-left:20px;margin:6px 0}
pre{white-space:pre-wrap;font-size:12.5px;background:var(--chip);padding:12px;border-radius:8px;overflow:auto}
details summary{cursor:pointer;color:var(--muted);font-size:14px}
.memory{font-size:14px;line-height:1.55}.memory h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);margin:14px 0 4px}.memory ul{padding-left:18px;margin:4px 0}
button{font:inherit;font-size:15px;background:var(--link);color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}
.pill{display:inline-block;font-size:12px;border-radius:999px;padding:2px 9px;background:var(--chip);color:var(--muted);margin:2px 4px 2px 0}
.more{color:#15803d}.less{color:#b91c1c}`;

const chrome = (body: string) => `<div class="top"><h1>Your digests</h1><a class="faint" href="${APP}/sign-out">Sign out</a></div>${body}`;

function settings(p: DigestProfile): string {
  const rows: [string, string][] = [
    ["Title", esc(p.title)],
    ["Time window", `${p.windowDays} days`],
    ["Items", p.items.min === p.items.max ? `${p.items.min}` : `${p.items.min}–${p.items.max}`],
    ["Closing section", p.closing ? esc(p.closing) : "none"],
    ["Pictures", p.images ? "on" : "off"],
    ["Recipients", p.to.length ? p.to.map(esc).join(", ") : "default (DIGEST_EMAIL_TO)"],
    ["Schedule", p.schedule ? `${esc(p.schedule)} <span class="faint">(not active yet)</span>` : "manual (npm run digests -- run)"],
  ];
  return `<table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function signInPage(message?: string): Response {
  return page(
    "Sign in",
    `<div class="card"><h2>AI Digest</h2><p class="muted">Sign in to see your digests. We'll email you a link that works once, for ${MAGIC_MINUTES} minutes.</p>
${message ? `<p>${message}</p>` : ""}
<form method="post" action="${APP}/sign-in"><button type="submit">Email me a sign-in link</button></form></div>`,
    200,
    { css },
  );
}

export function checkInboxPage(address: string): Response {
  return page("Check your inbox", `<div class="card"><h2>Check your inbox</h2><p class="muted">A sign-in link is on its way to ${esc(maskEmail(address))}. It works once, for ${MAGIC_MINUTES} minutes.</p></div>`, 200, { css });
}

/** The built-in General digest's card: one-off topics, asked for with `npm run digests -- ask`. */
function generalCard(overview: Overview, memory: Record<string, number>): string {
  const mine = overview.issues.filter((i) => i.profile === GENERAL_ID);
  const topics = [...new Set(mine.map((i) => i.topic).filter(Boolean))].slice(0, 3) as string[];
  return `<a class="card" href="${APP}/digests/${GENERAL_ID}" style="text-decoration:none;color:inherit">
  <span class="id">built in · on demand</span>
  <h2>General</h2>
  <span class="muted" style="font-size:14px">${topics.length ? `Recent: ${topics.map(esc).join(", ")}` : `Any topic: <code>npm run digests -- ask "…"</code>`}</span>
  <span class="faint">${mine[0] ? `Last issue ${date(mine[0].sentAt)} · ${plural(mine.length, "issue")}` : "No issues yet"}</span>
  <span class="faint">${plural(overview.votes[GENERAL_ID] ?? 0, "vote")} · ${plural(memory[GENERAL_ID] ?? 0, "memory", "memories")}</span>
</a>`;
}

export function listPage(digests: DigestSummary[], overview: Overview, memory: Record<string, number>): Response {
  const empty = digests.length ? "" : `<div class="card"><p class="muted">No digests of your own yet. Add a file to <code>digests/</code> and run <code>npm run digests -- push</code>.</p></div>`;
  const cards = digests
    .map((d) => {
      const last = overview.issues.find((i) => i.profile === d.id);
      const shape = d.windowDays && d.items ? `${d.windowDays} days · ${d.items.min === d.items.max ? d.items.min : `${d.items.min}–${d.items.max}`} items${d.schedule ? ` · ${esc(d.schedule)}` : ""}` : "";
      return `<a class="card" href="${APP}/digests/${d.id}" style="text-decoration:none;color:inherit">
  <span class="id">${esc(d.id)}</span>
  <h2>${d.title ? esc(d.title.replace("{range}", "…").replace(/\s*—\s*…$/, "")) : `<span class="less">Invalid definition</span>`}</h2>
  <span class="muted" style="font-size:14px">${shape}</span>
  <span class="faint">${last ? `Last issue ${date(last.sentAt)} · ${last.items} items` : "No issues yet"}</span>
  <span class="faint">${plural(overview.votes[d.id] ?? 0, "vote")} · ${plural(memory[d.id] ?? 0, "memory", "memories")} · updated ${date(d.updatedAt)} (v${d.versions})</span>
</a>`;
    })
    .join("");
  return page("Your digests", chrome(`${empty}<div class="grid">${cards}${generalCard(overview, memory)}</div>`), 200, { css, wide: true });
}

export interface DigestPageData {
  digest: StoredDigest;
  issues: { issue: IssueSummary; view?: string }[];
  prefs: Preferences;
  memorySummary: string | null;
  memoryCount: number;
}

export function digestPage(d: DigestPageData): Response {
  let p: DigestProfile | undefined;
  let invalid = "";
  try {
    p = parseProfile(d.digest.id, d.digest.markdown);
  } catch (e) {
    invalid = e instanceof Error ? e.message : String(e);
  }
  const pref = (list: { name: string; direction: string; votes: number }[]) =>
    list.length ? list.map((x) => `<span class="pill ${x.direction}">${x.direction === "more" ? "↑" : "↓"} ${esc(x.name)} · ${x.votes}</span>`).join("") : `<span class="faint">none yet</span>`;
  const issues = d.issues.length
    ? `<table class="kv">${d.issues.map(({ issue, view }) => `<tr><td>${date(issue.sentAt)}</td><td>${view ? `<a href="${esc(view)}">${esc(issue.subject)}</a>` : esc(issue.subject)} <span class="faint">· ${issue.items} items</span></td></tr>`).join("")}</table>`
    : `<p class="faint">No issues sent yet. Start one: <code>npm run digests -- run ${esc(d.digest.id)}</code></p>`;
  const title = p ? p.title.replace("{range}", "…").replace(/\s*—\s*…$/, "") : d.digest.id;
  return page(
    title,
    `<div class="top"><h1>${esc(title)}</h1><a class="faint" href="${APP}">All digests</a></div>
<div class="card"><p class="label">Settings <span class="id">· ${esc(d.digest.id)} · v${d.digest.versions} · updated ${date(d.digest.updatedAt)}</span></p>
${p ? settings(p) : `<p class="less">${esc(invalid)}</p>`}</div>
${p ? `<div class="card"><p class="label">What it covers</p><div class="desc">${marked.parse(p.description, { async: false }) as string}</div>
<details><summary>Definition file</summary><pre>${esc(d.digest.markdown)}</pre></details></div>` : ""}
<div class="card"><p class="label">Recent issues</p>${issues}</div>
<div class="card"><p class="label">Learned from your votes · ${d.prefs.votes} vote${d.prefs.votes === 1 ? "" : "s"}</p>
<table class="kv"><tr><td>Products &amp; companies</td><td>${pref(d.prefs.entities)}</td></tr>
<tr><td>Topics</td><td>${pref(d.prefs.topics)}</td></tr>
<tr><td>Not enough votes yet</td><td>${pref(d.prefs.tentativeTopics)}</td></tr></table></div>
<div class="card"><p class="label">Agent Memory · profile ${esc(d.digest.id)} · ${d.memoryCount} entr${d.memoryCount === 1 ? "y" : "ies"}</p>
${d.memorySummary ? `<div class="memory">${marked.parse(d.memorySummary, { async: false }) as string}</div>` : `<p class="faint">${d.memoryCount ? "The summary is being built; reload in a minute." : "Nothing yet: it fills in as you vote on this digest's issues."}</p>`}</div>`,
    200,
    { css, wide: true },
  );
}

export interface GeneralPageData {
  issues: { issue: IssueSummary; view?: string }[];
  prefs: Preferences;
  memorySummary: string | null;
  memoryCount: number;
}

/** The built-in General digest: how to ask, its template, its one-off issues and what it learned. */
export function generalPage(d: GeneralPageData): Response {
  const p = generalProfile("{topic}");
  const pref = (list: { name: string; direction: string; votes: number }[]) =>
    list.length ? list.map((x) => `<span class="pill ${x.direction}">${x.direction === "more" ? "↑" : "↓"} ${esc(x.name)} · ${x.votes}</span>`).join("") : `<span class="faint">none yet</span>`;
  const issues = d.issues.length
    ? `<table class="kv">${d.issues.map(({ issue, view }) => `<tr><td>${date(issue.sentAt)}</td><td>${view ? `<a href="${esc(view)}">${esc(issue.subject)}</a>` : esc(issue.subject)} <span class="faint">· ${issue.items} items</span></td></tr>`).join("")}</table>`
    : `<p class="faint">No one-off digests yet. Ask for one: <code>npm run digests -- ask "agent harnesses"</code></p>`;
  const rows: [string, string][] = [
    ["Start one", `<code>npm run digests -- ask "&lt;topic&gt;" [--window 14d] [--items 5-8]</code>`],
    ["Title", esc(p.title)],
    ["Time window", `${p.windowDays} days, unless the request says otherwise`],
    ["Items", `${p.items.min}–${p.items.max}, unless the request says otherwise`],
    ["Recipients", "default (DIGEST_EMAIL_TO)"],
  ];
  return page(
    "General",
    `<div class="top"><h1>General</h1><a class="faint" href="${APP}">All digests</a></div>
<div class="card"><p class="label">Built in · on demand <span class="id">· ${GENERAL_ID}</span></p>
<table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
<details><summary>Template</summary><pre>${esc(GENERAL_TEMPLATE)}</pre></details></div>
<div class="card"><p class="label">Recent issues</p>${issues}</div>
<div class="card"><p class="label">Learned from your votes · ${d.prefs.votes} vote${d.prefs.votes === 1 ? "" : "s"}</p>
<table class="kv"><tr><td>Products &amp; companies</td><td>${pref(d.prefs.entities)}</td></tr>
<tr><td>Topics</td><td>${pref(d.prefs.topics)}</td></tr>
<tr><td>Not enough votes yet</td><td>${pref(d.prefs.tentativeTopics)}</td></tr></table>
<p class="faint">Your other digests read only the products and companies you marked "I don't use" here.</p></div>
<div class="card"><p class="label">Agent Memory · profile ${GENERAL_ID} · ${d.memoryCount} entr${d.memoryCount === 1 ? "y" : "ies"}</p>
${d.memorySummary ? `<div class="memory">${marked.parse(d.memorySummary, { async: false }) as string}</div>` : `<p class="faint">${d.memoryCount ? "The summary is being built; reload in a minute." : "Nothing yet: it fills in as you vote on one-off issues."}</p>`}</div>`,
    200,
    { css, wide: true },
  );
}

// ── the routes ───────────────────────────────────────────────────────────────

export interface AppDeps {
  /** AGENT_AUTH_KEY: signs sessions and sign-in links. */
  authKey?: string;
  /** FEEDBACK_KEY: signs the issue view links. */
  feedbackKey?: string;
  /** Where sign-in links go. */
  adminEmail?: string;
  digests: { listDigests(): Promise<DigestSummary[]>; getDigest(id: string): Promise<StoredDigest | null>; magicRequested(now: number): Promise<{ ok: boolean; retryIn?: number }>; consumeMagic(nonce: string, exp: number): Promise<boolean> };
  feedback: { appOverview(): Promise<Overview>; feedbackStats(profile: string): Promise<Preferences> };
  memory: { counts(): Promise<Record<string, number>>; summary(profile: string): Promise<string | null> };
  sendEmail(to: string, subject: string, text: string, html: string): Promise<void>;
  now?: () => number;
}

const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store", ...headers } });

export async function app(req: Request, deps: AppDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();
  const now = deps.now?.() ?? Date.now();
  if (!deps.authKey) return errorPage(503, "The page isn't configured: AGENT_AUTH_KEY is missing.");

  if (path === `${APP}/sign-in` && method === "GET") return signInPage();
  if (path === `${APP}/sign-in` && method === "POST") {
    if (!deps.adminEmail) return errorPage(503, "No admin address: set ADMIN_EMAIL or DIGEST_EMAIL_TO.");
    const gate = await deps.digests.magicRequested(now);
    if (!gate.ok) return signInPage(`A link was sent less than a minute ago. Try again in ${gate.retryIn ?? MAGIC_EVERY_SECONDS} seconds.`);
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const exp = Math.floor(now / 1000) + MAGIC_MINUTES * 60;
    const link = `${url.origin}${APP}/auth?t=${await signToken(deps.authKey, "magic", { n: nonce, exp })}`;
    await deps.sendEmail(
      deps.adminEmail,
      "Your AI Digest sign-in link",
      `Sign in to AI Digest: ${link}\n\nIt works once, for ${MAGIC_MINUTES} minutes. If you didn't ask for it, ignore this email.`,
      `<p>Sign in to AI Digest:</p><p><a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">Open your digests</a></p><p style="color:#6b7280;font-size:13px">It works once, for ${MAGIC_MINUTES} minutes. If you didn't ask for it, ignore this email.</p>`,
    );
    return checkInboxPage(deps.adminEmail);
  }
  if (path === `${APP}/auth` && method === "GET") {
    const t = await verifyToken(deps.authKey, "magic", url.searchParams.get("t") ?? undefined, now);
    if (!t || typeof t.n !== "string" || !(await deps.digests.consumeMagic(t.n, t.exp))) {
      return signInPage("That sign-in link has expired or was already used. Request a new one.");
    }
    const session = await signToken(deps.authKey, "session", { sub: "admin", exp: Math.floor(now / 1000) + SESSION_DAYS * 86400 });
    return redirect(APP, { "set-cookie": sessionCookie(session) });
  }
  if (path === `${APP}/sign-out`) return redirect(`${APP}/sign-in`, { "set-cookie": clearCookie });

  // Signed in from here on.
  const session = await verifyToken(deps.authKey, "session", parseCookies(req.headers.get("cookie"))[SESSION_COOKIE], now);
  if (!session) return redirect(`${APP}/sign-in`);
  if (method !== "GET") return errorPage(405, "The page is read-only.");

  if (path === APP) {
    const [digests, overview, memory] = await Promise.all([deps.digests.listDigests(), deps.feedback.appOverview(), deps.memory.counts().catch(() => ({}))]);
    return listPage(digests, overview, memory);
  }
  const m = path.match(/^\/v1\/app\/digests\/([^/]+)$/);
  if (m && isDigestId(m[1])) {
    const id = m[1]!;
    const digest = id === GENERAL_ID ? null : await deps.digests.getDigest(id);
    if (!digest && id !== GENERAL_ID) return errorPage(404, `There's no digest "${id}".`);
    const [overview, prefs, counts, memorySummary] = await Promise.all([
      deps.feedback.appOverview(),
      deps.feedback.feedbackStats(id),
      deps.memory.counts().catch(() => ({}) as Record<string, number>),
      deps.memory.summary(id).catch(() => null),
    ]);
    const base = `${url.origin}/v1/feedback`;
    const issues = await Promise.all(
      overview.issues.filter((i) => i.profile === id).slice(0, 12).map(async (issue) => ({ issue, view: deps.feedbackKey ? await viewLink(deps.feedbackKey, base, issue.id) : undefined })),
    );
    if (!digest) return generalPage({ issues, prefs, memorySummary, memoryCount: counts[id] ?? 0 });
    return digestPage({ digest, issues, prefs, memorySummary, memoryCount: counts[id] ?? 0 });
  }
  return errorPage(404, "That page doesn't exist.");
}

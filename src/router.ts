// The function's HTTP API (v1). Actors are reached in-process only; nothing
// here forwards a request to an actor's own HTTP front door except the
// signed feedback pages.
//
//   GET    /v1/health                     anyone           liveness and version
//   GET    /v1/assets/<icon>.png          anyone           thumbs icons for emails and pages
//   GET    /v1/feedback?p=…|view=…        signed links     thumbs, reasons, digest web view
//   GET    /v1/talk?t=…                   signed links     talk about an issue with the voice assistant (src/talk.ts)
//   POST   /v1/talk/tools/<name>          signed token     the assistant's tools, called by the talk page: {"t", "args"}
//   GET    /v1/digests                    operator token   list digest definitions (and the built-in General one)
//   GET    /v1/digests/<id>               operator token   one definition (Markdown)
//   PUT    /v1/digests/<id>               operator token   store a definition (body: Markdown)
//   DELETE /v1/digests/<id>               operator token   delete a definition
//   POST   /v1/digests/<id>/runs          operator token   start a run: {"message"?, "run"?, "check"?}
//   GET    /v1/digests/<id>/pool          operator token   a watching digest's pool and its last decision
//   POST   /v1/digests/<id>/check         operator token   a check now: {"since"?, "until"?, "decide"?}
//   POST   /v1/runs                       operator token   a one-off General digest: {"topic", "window"?, "items"?, "run"?}
//   GET    /v1/runs/<conversation>        operator token   the conversation's recent runs
//   GET    /v1/issues                     operator token   sent issues, newest first
//   POST   /v1/issues/<id>/send           operator token   email a stored issue again, with talk links: {"to"?: ["…"]}
//
//   GET    /v1/app[/…]                    session cookie   the digests page (src/app.ts; magic-link sign-in)
//
//   GET    /agents/ai-digest/feedback?…   signed links     same as /v1/feedback (links in emails sent before 0.2.0)

import { THUMB_DOWN_PNG_BASE64, THUMB_UP_PNG_BASE64 } from "./assets.ts";
import { mayUseFrontDoor } from "./auth.ts";
import { SECRET, secret } from "./config.ts";
import { GENERAL_ID, ID_PATTERN, ProfileError, generalProfile, parseProfile, runConversation, runMessage } from "./profile.ts";
import { GENERAL_TEMPLATE } from "./general.ts";
import { app } from "./app.ts";
import { parseRecipients } from "./config.ts";
import { TALK_TTL_S, addTalkLinks, readArticle, rebaseLinks, searchWeb, talkBase, talkLinks, talkToken, verifyTalkToken } from "./talk.ts";
import { verifyPayload, verifyView } from "./feedback.ts";
import { emailBody, talkPage } from "./talk-page.ts";

export const VERSION = "0.6.2";
export const FEEDBACK_ACTOR = "feedback";
export const DIGESTS_ACTOR = "digests";

/** What the router needs from the environment: the actor namespace and secrets. */
export interface RouterEnv {
  AI_DIGEST: { idFromName(name: string): any };
  SECRETS?: { get(name: string): Promise<string> };
  TELNYX?: { get(path: string, opts?: unknown): Promise<any>; post(path: string, opts: { body: unknown }): Promise<any> };
  [k: string]: unknown;
}

const MEMORY = "/ai/memory/namespaces/ai-digest/profiles";

/** The digests page, with what it needs from the actors, Agent Memory and Email. */
async function appRoute(req: Request, env: RouterEnv): Promise<Response> {
  const s = (n: string) => secret(env as any, n);
  const [authKey, feedbackKey, admin, defaultTo, from] = await Promise.all([s(SECRET.authKey), s(SECRET.feedbackKey), s(SECRET.adminEmail), s(SECRET.emailTo), s(SECRET.emailFrom)]);
  const t = env.TELNYX;
  return app(req, {
    authKey,
    feedbackKey,
    adminEmail: admin || parseRecipients(defaultTo)[0],
    digests: env.AI_DIGEST.idFromName(DIGESTS_ACTOR),
    feedback: env.AI_DIGEST.idFromName(FEEDBACK_ACTOR),
    memory: {
      async counts() {
        const r = await t!.get(MEMORY);
        return Object.fromEntries((r?.data ?? []).map((p: any) => [p.profile_id, p.memory_count]));
      },
      async summary(profile: string) {
        const r = await t!.get(`${MEMORY}/${encodeURIComponent(profile)}/summary`);
        // Agent Memory builds a summary only when asked: ask for next time when it's missing or stale.
        if (!r?.data?.text || r?.data?.is_stale) await t!.get(`${MEMORY}/${encodeURIComponent(profile)}/summary`, { query: { refresh: "true" } }).catch(() => undefined);
        return r?.data?.text ?? null;
      },
    },
    pool: (id) => env.AI_DIGEST.idFromName(poolOf(id)).poolView(),
    async sendEmail(to, subject, text, html) {
      if (!t || !from) throw new Error("email isn't configured (DIGEST_EMAIL_FROM)");
      // The digests actor sends it right after this request returns (an immediate scheduled call),
      // so the page answers at once; sending directly is the fallback.
      const queued = await Promise.resolve()
        .then(() => env.AI_DIGEST.idFromName(DIGESTS_ACTOR).queueEmail({ to, subject, text, html }))
        .catch(() => false);
      if (!queued) await t.post("/emails", { body: { from, to: [to], subject, text_body: text, html_body: html } });
    },
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2) + "\n", { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const png = (b64: string) =>
  new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=2592000" } });

/**
 * Conversation names a watching digest uses itself ("<id>--pool", "<id>--check-…", "<id>--issue-…"):
 * a run named like one would reach the pool actor or get a check's tool budget.
 */
const RESERVED_RUN = /^(pool$|check-|issue-)/;

/** A run name: the caller's, or the current UTC time (e.g. 2026-11-07t2155), after `prefix` when given. */
export function runName(given: unknown, now = new Date(), prefix = ""): string {
  if (typeof given === "string" && /^[a-z0-9][a-z0-9-]{0,40}$/.test(given) && !given.includes("--") && !RESERVED_RUN.test(given)) return given;
  const time = now.toISOString().slice(0, 16).replace(/[:]/g, "").toLowerCase();
  return prefix ? `${prefix}-${time}` : time;
}

/** A topic as a short run-name prefix: "Agent harnesses!" → "agent-harnesses". */
export function topicSlug(topic: string): string {
  return topic.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
}

/** A digest's pool actor (watching; agent.ts). */
const poolOf = (id: string) => `${id}--pool`;
/** Call an actor method, turning a synchronous throw (e.g. a missing method) into a rejection. */
const attempt = <T>(f: () => Promise<T>) => Promise.resolve().then(f);

/** An ISO time from the request, or undefined; throws on a malformed one. */
function isoParam(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new ProfileError("request", `"${name}" must be a date or time (e.g. 2026-11-02 or 2026-11-02T06:00:00Z)`);
  return new Date(t).toISOString();
}

/** The talk page and its tools (signed by the link's token, not the operator token). */
async function talkRoute(req: Request, env: RouterEnv, path: string, method: string): Promise<Response> {
  const s = (n: string) => secret(env as any, n);
  const [key, assistantId] = await Promise.all([s(SECRET.feedbackKey), s(SECRET.talkAssistant)]);
  const feedback = env.AI_DIGEST.idFromName(FEEDBACK_ACTOR);
  if (!key || !assistantId) return json(503, { error: "not_configured", message: "the voice assistant isn't deployed (ai-digest deploy sets it up)" });
  if (method === "GET" && path === "/v1/talk") {
    const url = new URL(req.url);
    const token = url.searchParams.get("t") ?? "";
    const claim = await verifyTalkToken(key, token);
    if (!claim) return talkError(400, "This link is invalid or has expired.");
    const record = await feedback.issueRecord(claim.d);
    if (!record) return talkError(404, "This issue is no longer stored.");
    return issuePage(env, url.origin, key, assistantId, record, token, { start: claim.i, autostart: true });
  }
  const name = path.match(/^\/v1\/talk\/tools\/([a-z_]+)$/)?.[1];
  if (method !== "POST" || !name) return json(404, { error: "not_found" });
  const body = await req.json().catch(() => ({}));
  const claim = await verifyTalkToken(key, typeof body?.t === "string" ? body.t : "");
  if (!claim) return json(401, { error: "invalid_token" });
  const args = body?.args && typeof body.args === "object" ? body.args : {};
  const record = await feedback.issueRecord(claim.d);
  if (!record) return json(404, { error: "issue_gone" });
  const item = record.items.find((i: { n: number }) => i.n === Number(args.story));
  const telnyx = env.TELNYX as any;
  const started = Date.now();
  try {
    let out: unknown;
    if (name === "read_article") out = item ? await readArticle(telnyx, item, typeof args.focus === "string" ? args.focus.slice(0, 300) : undefined) : { error: "no such story" };
    else if (name === "search_web") out = typeof args.query === "string" && args.query.trim() ? await searchWeb(telnyx, args.query) : { error: "query is required" };
    else if (name === "record_vote") out = item && (args.vote === "up" || args.vote === "down") ? await feedback.talkVote({ d: claim.d, i: item.n, v: args.vote, via: "voice" }) : { error: "story and vote (up or down) are required" };
    // The page's own 👍/👎 and reasons (not one of the assistant's tools).
    else if (name === "feedback") out = item && (args.vote === "up" || args.vote === "down") ? await feedback.talkVote({ d: claim.d, i: item.n, v: args.vote, r: typeof args.reason === "string" ? args.reason : undefined, x: typeof args.x === "number" ? args.x : undefined, undo: args.undo === true, via: "page" }) : { error: "story and vote (up or down) are required" };
    else if (name === "log") {
      const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : v === null || v === undefined ? null : String(v).slice(0, n));
      console.log(JSON.stringify({ talk: "client error", issue: claim.d, stage: str(args.stage, 20), error: str(args.error, 300), code: str(args.code, 20), fatal: args.fatal === true, ua: str(args.ua, 200) }));
      return json(200, { ok: true });
    }
    else return json(404, { error: "unknown_tool" });
    console.log(JSON.stringify({ talk: "tool", tool: name, issue: claim.d, story: item?.n ?? null, ms: Date.now() - started }));
    return json(200, out);
  } catch (err) {
    console.log(JSON.stringify({ talk: "tool failed", tool: name, issue: claim.d, error: err instanceof Error ? err.message : String(err) }));
    return json(200, { error: "the tool failed; say so and continue" });
  }
}

/** The issue page for a plain thumbs click (the vote is recorded) or a view link; undefined to use the older pages. */
async function issuePageFor(req: Request, env: RouterEnv): Promise<Response | undefined> {
  const url = new URL(req.url);
  const q = url.searchParams;
  if (q.has("r") || q.has("undo") || q.has("x")) return undefined;
  const s = (n: string) => secret(env as any, n);
  const [key, assistantId] = await Promise.all([s(SECRET.feedbackKey), s(SECRET.talkAssistant)]);
  if (!key || !assistantId) return undefined;
  let d: string, voted: number | undefined, v: "up" | "down" | undefined;
  if (q.has("view")) {
    d = q.get("view") ?? "";
    if (!(await verifyView(key, d, q.get("s") ?? ""))) return undefined;
  } else {
    const p = await verifyPayload(key, q.get("p") ?? "", q.get("s") ?? "");
    if (!p || p.r) return undefined;
    ({ d, i: voted, v } = { d: p.d, i: p.i, v: p.v });
  }
  const feedback = env.AI_DIGEST.idFromName(FEEDBACK_ACTOR);
  const record = await feedback.issueRecord(d);
  if (!record) return undefined;
  if (voted !== undefined && v) await feedback.talkVote({ d, i: voted, v, via: "email" });
  const e = Math.floor(Date.now() / 1000) + TALK_TTL_S;
  const token = await talkToken(key, { d, e });
  // The page's links last TALK_TTL_S from now: keep the issue that long.
  await feedback.keepIssueUntil(d, new Date(e * 1000).toISOString()).catch(() => undefined);
  return issuePage(env, url.origin, key, assistantId, record, token, { start: voted, autostart: false, voted });
}

/** The issue page: the issue as emailed, with talk links and the voice dock. */
async function issuePage(env: RouterEnv, origin: string, key: string, assistantId: string, record: any, token: string, opts: { start?: number; autostart: boolean; voted?: number }): Promise<Response> {
  let html = record.html ? rebaseLinks(record.html, origin) : undefined;
  if (html) html = addTalkLinks(html, await talkLinks(key, `${origin}/v1/talk`, record.id, record.items));
  const votes = await env.AI_DIGEST.idFromName(FEEDBACK_ACTOR).issueVotes(record.id).catch(() => ({}));
  return talkPage({ token, assistantId, record, start: opts.start, body: emailBody(html), votes, autostart: opts.autostart, voted: opts.voted });
}

function talkError(status: number, message: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Talk</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;"><p>${message}</p></body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

/** Email a stored issue again (its stored HTML), adding talk links when it has none. */
async function resendIssue(env: RouterEnv, id: string, to?: string[]): Promise<Response> {
  const s = (n: string) => secret(env as any, n);
  const [key, assistantId, from, defaultTo, publicUrl] = await Promise.all([s(SECRET.feedbackKey), s(SECRET.talkAssistant), s(SECRET.emailFrom), s(SECRET.emailTo), s(SECRET.publicUrl)]);
  const feedback = env.AI_DIGEST.idFromName(FEEDBACK_ACTOR);
  const record = await feedback.issueRecord(id);
  if (!record?.html) return json(404, { error: "not_found", message: `no stored issue "${id}" (GET /v1/issues lists them)` });
  if (!env.TELNYX || !from || !publicUrl) return json(503, { error: "not_configured", message: "email isn't configured" });
  // Recipients given are used as given: a mistyped one is an error, never a reason to email the default audience.
  if (to) {
    // Every address in every entry ("a@example.com, b@example.com" is two), not just one per entry.
    const invalid = to.flatMap((a) => (typeof a !== "string" ? [a] : a.split(/[,;\s]+/).filter((x) => x && !parseRecipients(x).length)));
    if (to.some((a) => typeof a === "string" && !a.trim())) invalid.push("");
    if (invalid.length || !to.length) return json(400, { error: "invalid_recipients", message: to.length ? `not email addresses: ${invalid.map((a) => JSON.stringify(a)).join(", ")}` : "to is empty (leave it out to use the digest's recipients)" });
  }
  let recipients = (to ?? []).flatMap((a) => parseRecipients(a));
  if (!to && record.profile) {
    const d = await env.AI_DIGEST.idFromName(DIGESTS_ACTOR).getDigest(record.profile).catch(() => undefined);
    if (d) recipients = parseProfile(record.profile, d.markdown).to;
  }
  if (!recipients.length) recipients = parseRecipients(defaultTo);
  if (!recipients.length) return json(400, { error: "no_recipients" });
  let html = rebaseLinks(record.html, publicUrl);
  if (key && assistantId) {
    const had = html.includes("/v1/talk?t=");
    html = addTalkLinks(html, await talkLinks(key, talkBase(publicUrl), id, record.items));
    // New links last TALK_TTL_S from now: keep the issue that long.
    const added = !had && html.includes("/v1/talk?t=");
    if (html !== record.html) await feedback.setIssueHtml(id, html, added ? new Date(Date.now() + TALK_TTL_S * 1000).toISOString() : undefined);
  }
  const text = `${record.subject}\n\nThis digest is best read as HTML.${html.includes("/v1/talk?t=") ? `\n\n🎧 Talk about this issue: ${html.match(/href="([^"]*\/v1\/talk\?t=[^"]*)"/)?.[1] ?? ""}` : ""}`;
  const res: any = await env.TELNYX.post("/emails", { body: { from, to: recipients, subject: record.subject, text_body: text, html_body: html } });
  const data = res?.data ?? res;
  console.log(JSON.stringify({ issue: "resent", id, recipients: recipients.length, talk: html.includes("/v1/talk?t="), email: data?.id }));
  return json(200, { issue: id, recipients: recipients.length, talkLinks: html.includes("/v1/talk?t="), email: data?.id ?? null, status: data?.status ?? null });
}

/** How the built-in General digest appears in GET /v1/digests. */
function generalSummary() {
  const p = generalProfile("{topic}");
  return { id: GENERAL_ID, builtIn: true, title: p.title, windowDays: p.windowDays, items: p.items, watch: null, updatedAt: null, versions: null };
}

/**
 * The request as the reader sees it. Every link built from the request
 * (sign-in links, view links, feedback links) must use the public address:
 *   - TLS ends before the function, so requests arrive as http:// (and the
 *     platform's X-Forwarded-Proto says http too, for that internal hop);
 *     Secure cookies need https://, so anything but localhost is https://.
 *   - On a custom domain the request still carries the function's own
 *     *.telnyxcompute.com host, so with PUBLIC_URL set its origin is used.
 * Localhost (development) is left as it is.
 */
export function asPublic(req: Request, publicUrl?: string): Request {
  const url = new URL(req.url);
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) return req;
  let origin: URL | undefined;
  try {
    origin = publicUrl ? new URL(publicUrl) : undefined;
  } catch {}
  const next = new URL(url.pathname + url.search, origin && /^https?:$/.test(origin.protocol) ? origin.origin : `https://${url.host}`);
  if (next.protocol === "http:") next.protocol = "https:";
  return next.toString() === url.toString() ? req : new Request(next.toString(), req);
}

export async function route(incoming: Request, env: RouterEnv): Promise<Response> {
  const req = asPublic(incoming, await secret(env as any, SECRET.publicUrl).catch(() => ""));
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();
  const actor = (name: string) => env.AI_DIGEST.idFromName(name);

  // Public.
  if (method === "GET" && path === "/v1/health") return json(200, { ok: true, service: "ai-digest", version: VERSION });
  if (method === "GET" && path === "/v1/assets/thumb-up.png") return png(THUMB_UP_PNG_BASE64);
  if (method === "GET" && path === "/v1/assets/thumb-down.png") return png(THUMB_DOWN_PNG_BASE64);
  if (method === "GET" && (path === "/v1/feedback" || path === "/agents/ai-digest/feedback")) {
    // A thumbs click or "view" link from an email opens the issue page (with the voice dock) when the assistant is deployed;
    // reasons, undo and changes from the older feedback page still go to the feedback actor.
    const page = await issuePageFor(req, env).catch((err: unknown) => {
      console.log(JSON.stringify({ feedback: "issue page failed", error: err instanceof Error ? err.message : String(err) }));
      return undefined;
    });
    return page ?? actor(FEEDBACK_ACTOR).fetch(req);
  }
  if (path === "/v1/app" || path.startsWith("/v1/app/")) return appRoute(req, env);
  if (path === "/v1/talk" || path.startsWith("/v1/talk/")) return talkRoute(req, env, path, method);

  // Everything else needs the operator token.
  if (!path.startsWith("/v1/")) return json(404, { error: "not_found", message: "see /v1/health; the API lives under /v1" });
  if (!(await mayUseFrontDoor(req, await secret(env as any, SECRET.authKey)))) {
    return json(401, { error: "unauthorized", message: "send the operator token: Authorization: Bearer <token> (ai-digest does)" });
  }

  const parts = path.split("/").slice(2); // after "/v1"
  try {
    if (parts[0] === "digests") {
      const id = parts[1];
      if (id === GENERAL_ID) {
        if (parts.length === 2 && method === "GET") return json(200, { id, builtIn: true, markdown: GENERAL_TEMPLATE });
        return json(400, { error: "built_in", message: `"${GENERAL_ID}" is the built-in General digest: it can't be stored or deleted; start one with POST /v1/runs {"topic": "…"} (ai-digest ask "<topic>")` });
      }
      if (id !== undefined && !ID_PATTERN.test(id)) return json(400, { error: "bad_id", message: "ids are lowercase letters, digits and single dashes" });
      if (!id && method === "GET") return json(200, [...(await actor(DIGESTS_ACTOR).listDigests()), generalSummary()]);
      if (id && parts.length === 2) {
        if (method === "GET") {
          const d = await actor(DIGESTS_ACTOR).getDigest(id);
          return d ? json(200, d) : json(404, { error: "not_found", message: `no digest "${id}"` });
        }
        if (method === "PUT") {
          const markdown = await req.text();
          try {
            parseProfile(id, markdown);
          } catch (err) {
            if (err instanceof ProfileError) return json(400, { error: "invalid_digest", message: err.message });
            throw err;
          }
          const stored = await actor(DIGESTS_ACTOR).putDigest(id, markdown);
          // Arm, re-arm or cancel the watch timer (every deploy pushes every definition, so this also repairs a lost timer).
          const watching = await attempt(() => actor(poolOf(id)).poolConfigure()).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
          return json(200, { ...stored, watching });
        }
        if (method === "DELETE") {
          const deleted = await actor(DIGESTS_ACTOR).deleteDigest(id);
          // Its timer stops and its pool is emptied, so a digest created later under the same name starts fresh.
          await attempt(() => actor(poolOf(id)).poolDelete()).catch(() => undefined);
          return json(200, deleted);
        }
      }
      if (id && parts[2] === "pool" && parts.length === 3 && method === "GET") {
        const d = await actor(DIGESTS_ACTOR).getDigest(id);
        if (!d) return json(404, { error: "not_found", message: `no digest "${id}"` });
        return json(200, await actor(poolOf(id)).poolView());
      }
      if (id && parts[2] === "check" && parts.length === 3 && method === "POST") {
        const d = await actor(DIGESTS_ACTOR).getDigest(id);
        if (!d) return json(404, { error: "not_found", message: `no digest "${id}"` });
        if (!parseProfile(id, d.markdown).watch) return json(400, { error: "not_watching", message: `"${id}" doesn't watch: add "watch: 6h" to its definition and push it` });
        const body = await req.json().catch(() => ({}));
        let since: string | undefined, until: string | undefined;
        try {
          since = isoParam(body?.since, "since");
          until = isoParam(body?.until, "until");
        } catch (err) {
          return json(400, { error: "bad_request", message: (err as Error).message.replace(/^request: /, "") });
        }
        if (since && until && since >= until) return json(400, { error: "bad_request", message: `"since" must be before "until"` });
        const r = await actor(poolOf(id)).startCheck({ since, until, decide: body?.decide !== false });
        return json(r.ok ? 202 : 409, { digest: id, ...r });
      }
      if (id && parts[2] === "runs" && parts.length === 3 && method === "POST") {
        const d = await actor(DIGESTS_ACTOR).getDigest(id);
        if (!d) return json(404, { error: "not_found", message: `no digest "${id}": push it first (ai-digest push)` });
        const body = await req.json().catch(() => ({}));
        // A watching digest writes from its pool: after a fresh check (default), or right away with "check": false.
        if (parseProfile(id, d.markdown).watch) {
          const focus = typeof body?.message === "string" ? body.message : undefined;
          const fromPool = body?.check === false;
          const r = fromPool ? await actor(poolOf(id)).writeNow({ focus }) : await actor(poolOf(id)).startCheck({ force: { focus } });
          return json(r.ok ? 202 : 409, { digest: id, mode: fromPool ? "from-pool" : "check-then-write", ...r });
        }
        const conversation = runConversation(id, runName(body?.run));
        const message = runMessage(parseProfile(id, d.markdown), typeof body?.message === "string" ? body.message : undefined);
        const accepted = await actor(conversation).receive(message);
        return json(202, { digest: id, conversation, run: accepted });
      }
    }
    if (parts[0] === "issues" && parts.length === 1 && method === "GET") {
      const { issues } = await actor(FEEDBACK_ACTOR).appOverview();
      return json(200, issues);
    }
    if (parts[0] === "issues" && parts[1] && parts[2] === "send" && parts.length === 3 && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const to = body?.to;
      return resendIssue(env, parts[1], to === undefined || to === null ? undefined : Array.isArray(to) ? to : [to]);
    }
    if (parts[0] === "runs" && parts.length === 1 && method === "POST") {
      const body = await req.json().catch(() => undefined);
      if (!body || typeof body !== "object") return json(400, { error: "bad_request", message: 'send JSON: {"topic": "…", "window"?: "14d", "items"?: "5-8", "run"?: "…"}' });
      let profile;
      try {
        profile = generalProfile(body.topic, { window: body.window, items: body.items });
      } catch (err) {
        if (err instanceof ProfileError) return json(400, { error: "invalid_run", message: err.message.replace(`${GENERAL_ID}: `, "") });
        throw err;
      }
      const conversation = runConversation(GENERAL_ID, runName(body.run, new Date(), topicSlug(profile.topic!)));
      const run = actor(conversation);
      await run.prepareGeneralRun({ topic: profile.topic!, window: `${profile.windowDays}d`, items: `${profile.items.min}-${profile.items.max}` });
      const accepted = await run.receive(runMessage(profile));
      return json(202, { digest: GENERAL_ID, topic: profile.topic, conversation, run: accepted });
    }
    if (parts[0] === "runs" && parts[1] && parts.length === 2 && method === "GET") {
      if (!/^[a-z0-9_][a-z0-9_-]{0,160}$/.test(parts[1])) return json(400, { error: "bad_request", message: "not a conversation name: lowercase letters, digits, - and _" });
      const t = await actor(parts[1]).traces(5);
      return json(200, { conversation: parts[1], runs: Array.isArray(t?.runs) ? t.runs : [] });
    }
  } catch (err) {
    console.log(JSON.stringify({ api: "error", path, error: err instanceof Error ? err.message : String(err) }));
    return json(500, { error: "internal", message: err instanceof Error ? err.message : String(err) });
  }
  return json(404, { error: "not_found", message: `${method} ${path} isn't part of the v1 API` });
}

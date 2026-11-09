// The function's HTTP API (v1). Actors are reached in-process only; nothing
// here forwards a request to an actor's own HTTP front door except the
// signed feedback pages.
//
//   GET    /v1/health                     anyone           liveness and version
//   GET    /v1/assets/<icon>.png          anyone           thumbs icons for emails and pages
//   GET    /v1/feedback?p=…|view=…        signed links     thumbs, reasons, digest web view
//   GET    /v1/digests                    operator token   list digest definitions (and the built-in General one)
//   GET    /v1/digests/<id>               operator token   one definition (Markdown)
//   PUT    /v1/digests/<id>               operator token   store a definition (body: Markdown)
//   DELETE /v1/digests/<id>               operator token   delete a definition
//   POST   /v1/digests/<id>/runs          operator token   start a run: {"message"?, "run"?, "check"?}
//   GET    /v1/digests/<id>/pool          operator token   a watching digest's pool and its last decision
//   POST   /v1/digests/<id>/check         operator token   a check now: {"since"?, "until"?, "decide"?} (0.5.0: /scout)
//   POST   /v1/runs                       operator token   a one-off General digest: {"topic", "window"?, "items"?, "run"?}
//   GET    /v1/runs/<conversation>        operator token   the conversation's recent runs
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

export const VERSION = "0.5.0";
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
 * Conversation names a watching digest uses itself ("<id>--pool", "<id>--check-…", "<id>--issue-…"; "scout-" in 0.5.0):
 * a run named like one would reach the pool actor or get a check's tool budget.
 */
const RESERVED_RUN = /^(pool$|check-|issue-|scout-)/;

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

/** How the built-in General digest appears in GET /v1/digests. */
function generalSummary() {
  const p = generalProfile("{topic}");
  return { id: GENERAL_ID, builtIn: true, title: p.title, windowDays: p.windowDays, items: p.items, watch: null, scout: null, updatedAt: null, versions: null };
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
  if (method === "GET" && (path === "/v1/feedback" || path === "/agents/ai-digest/feedback")) return actor(FEEDBACK_ACTOR).fetch(req);
  if (path === "/v1/app" || path.startsWith("/v1/app/")) return appRoute(req, env);

  // Everything else needs the operator token.
  if (!path.startsWith("/v1/")) return json(404, { error: "not_found", message: "see /v1/health; the API lives under /v1" });
  if (!(await mayUseFrontDoor(req, await secret(env as any, SECRET.authKey)))) {
    return json(401, { error: "unauthorized", message: "send the operator token: Authorization: Bearer <token> (npm run digests does)" });
  }

  const parts = path.split("/").slice(2); // after "/v1"
  try {
    if (parts[0] === "digests") {
      const id = parts[1];
      if (id === GENERAL_ID) {
        if (parts.length === 2 && method === "GET") return json(200, { id, builtIn: true, markdown: GENERAL_TEMPLATE });
        return json(400, { error: "built_in", message: `"${GENERAL_ID}" is the built-in General digest: it can't be stored or deleted; start one with POST /v1/runs {"topic": "…"} (npm run digests -- ask "<topic>")` });
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
          return json(200, { ...stored, watching, scouting: watching /* the 0.5.0 name */ });
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
      // "/scout" is the 0.5.0 name of "/check".
      if (id && (parts[2] === "check" || parts[2] === "scout") && parts.length === 3 && method === "POST") {
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
        if (!d) return json(404, { error: "not_found", message: `no digest "${id}": push it first (npm run digests -- push)` });
        const body = await req.json().catch(() => ({}));
        // A watching digest writes from its pool: after a fresh check (default), or right away with "check": false ("scout": false in 0.5.0).
        if (parseProfile(id, d.markdown).watch) {
          const focus = typeof body?.message === "string" ? body.message : undefined;
          const fromPool = body?.check === false || body?.scout === false;
          const r = fromPool ? await actor(poolOf(id)).writeNow({ focus }) : await actor(poolOf(id)).startCheck({ force: { focus } });
          return json(r.ok ? 202 : 409, { digest: id, mode: fromPool ? "from-pool" : "check-then-write", ...r });
        }
        const conversation = runConversation(id, runName(body?.run));
        const message = runMessage(parseProfile(id, d.markdown), typeof body?.message === "string" ? body.message : undefined);
        const accepted = await actor(conversation).receive(message);
        return json(202, { digest: id, conversation, run: accepted });
      }
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

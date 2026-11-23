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

import { DIGESTS_CONVERSATION, FEEDBACK_CONVERSATION, poolConversation, type ActorNamespace } from "./actors.ts";
import { app } from "./app.ts";
import { THUMB_DOWN_PNG_BASE64, THUMB_UP_PNG_BASE64 } from "./assets.ts";
import { mayUseFrontDoor } from "./auth.ts";
import { SECRET, parseRecipients, secret, type SecretStore } from "./config.ts";
import { sendEmail } from "./email.ts";
import { GENERAL_TEMPLATE } from "./general.ts";
import { json, png } from "./http.ts";
import { memoryCounts, memorySummaryNow } from "./memory.ts";
import { GENERAL_ID, ID_PATTERN, ProfileError, generalProfile, parseProfile, runConversation, runMessage } from "./profile.ts";
import { resendIssue } from "./resend.ts";
import { issuePageFor, talkRoute } from "./talk-routes.ts";
import type { TelnyxClient } from "./telnyx.ts";

export const VERSION = "0.6.2";

/** What the router needs from the environment: the actor namespace and secrets. */
export interface RouterEnv {
  AI_DIGEST: ActorNamespace;
  SECRETS?: SecretStore;
  TELNYX?: Pick<TelnyxClient, "get" | "post">;
  [k: string]: unknown;
}


/** The digests page, with what it needs from the actors, Agent Memory and Email. */
async function appRoute(req: Request, env: RouterEnv): Promise<Response> {
  const s = (n: string) => secret(env, n);
  const [authKey, feedbackKey, admin, defaultTo, from] = await Promise.all([s(SECRET.authKey), s(SECRET.feedbackKey), s(SECRET.adminEmail), s(SECRET.emailTo), s(SECRET.emailFrom)]);
  const t = env.TELNYX;
  return app(req, {
    authKey,
    feedbackKey,
    adminEmail: admin || parseRecipients(defaultTo)[0],
    digests: env.AI_DIGEST.idFromName(DIGESTS_CONVERSATION),
    feedback: env.AI_DIGEST.idFromName(FEEDBACK_CONVERSATION),
    memory: {
      counts: () => memoryCounts(t!),
      summary: (profile: string) => memorySummaryNow(t!, profile),
    },
    pool: (id) => env.AI_DIGEST.idFromName(poolConversation(id)).poolView(),
    async sendEmail(to, subject, text, html) {
      if (!t || !from) throw new Error("email isn't configured (DIGEST_EMAIL_FROM)");
      // The digests actor sends it right after this request returns (an immediate scheduled call),
      // so the page answers at once; sending directly is the fallback.
      const queued = await Promise.resolve()
        .then(() => env.AI_DIGEST.idFromName(DIGESTS_CONVERSATION).queueEmail({ to, subject, text, html }))
        .catch(() => false);
      if (!queued) await sendEmail(t, { from, to: [to], subject, text, html });
    },
  });
}

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
  const req = asPublic(incoming, await secret(env, SECRET.publicUrl).catch(() => ""));
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
    return page ?? actor(FEEDBACK_CONVERSATION).fetch(req);
  }
  if (path === "/v1/app" || path.startsWith("/v1/app/")) return appRoute(req, env);
  if (path === "/v1/talk" || path.startsWith("/v1/talk/")) return talkRoute(req, env, path, method);

  // Everything else needs the operator token.
  if (!path.startsWith("/v1/")) return json(404, { error: "not_found", message: "see /v1/health; the API lives under /v1" });
  if (!(await mayUseFrontDoor(req, await secret(env, SECRET.authKey)))) {
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
      if (!id && method === "GET") return json(200, [...(await actor(DIGESTS_CONVERSATION).listDigests()), generalSummary()]);
      if (id && parts.length === 2) {
        if (method === "GET") {
          const d = await actor(DIGESTS_CONVERSATION).getDigest(id);
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
          const stored = await actor(DIGESTS_CONVERSATION).putDigest(id, markdown);
          // Arm, re-arm or cancel the watch timer (every deploy pushes every definition, so this also repairs a lost timer).
          const watching = await attempt(() => actor(poolConversation(id)).poolConfigure()).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
          return json(200, { ...stored, watching });
        }
        if (method === "DELETE") {
          const deleted = await actor(DIGESTS_CONVERSATION).deleteDigest(id);
          // Its timer stops and its pool is emptied, so a digest created later under the same name starts fresh.
          await attempt(() => actor(poolConversation(id)).poolDelete()).catch(() => undefined);
          return json(200, deleted);
        }
      }
      if (id && parts[2] === "pool" && parts.length === 3 && method === "GET") {
        const d = await actor(DIGESTS_CONVERSATION).getDigest(id);
        if (!d) return json(404, { error: "not_found", message: `no digest "${id}"` });
        return json(200, await actor(poolConversation(id)).poolView());
      }
      if (id && parts[2] === "check" && parts.length === 3 && method === "POST") {
        const d = await actor(DIGESTS_CONVERSATION).getDigest(id);
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
        const r = await actor(poolConversation(id)).startCheck({ since, until, decide: body?.decide !== false });
        return json(r.ok ? 202 : 409, { digest: id, ...r });
      }
      if (id && parts[2] === "runs" && parts.length === 3 && method === "POST") {
        const d = await actor(DIGESTS_CONVERSATION).getDigest(id);
        if (!d) return json(404, { error: "not_found", message: `no digest "${id}": push it first (ai-digest push)` });
        const body = await req.json().catch(() => ({}));
        // A watching digest writes from its pool: after a fresh check (default), or right away with "check": false.
        if (parseProfile(id, d.markdown).watch) {
          const focus = typeof body?.message === "string" ? body.message : undefined;
          const fromPool = body?.check === false;
          const r = fromPool ? await actor(poolConversation(id)).writeNow({ focus }) : await actor(poolConversation(id)).startCheck({ force: { focus } });
          return json(r.ok ? 202 : 409, { digest: id, mode: fromPool ? "from-pool" : "check-then-write", ...r });
        }
        const conversation = runConversation(id, runName(body?.run));
        const message = runMessage(parseProfile(id, d.markdown), typeof body?.message === "string" ? body.message : undefined);
        const accepted = await actor(conversation).receive(message);
        return json(202, { digest: id, conversation, run: accepted });
      }
    }
    if (parts[0] === "issues" && parts.length === 1 && method === "GET") {
      const { issues } = await actor(FEEDBACK_CONVERSATION).appOverview();
      return json(200, issues);
    }
    if (parts[0] === "issues" && parts[1] && parts[2] === "send" && parts.length === 3 && method === "POST") {
      // An empty body means the defaults; a body that isn't JSON is refused (it might have named recipients).
      const raw = await req.text();
      let body: any = {};
      if (raw.trim()) {
        try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid_json" }); }
      }
      // Only a request without `to` gets the defaults: null, "" or [] name no one and are refused.
      const to = body?.to;
      return resendIssue(env, parts[1], to === undefined ? undefined : Array.isArray(to) ? to : [to]);
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

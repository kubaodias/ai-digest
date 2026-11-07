// The function's HTTP API (v1). Actors are reached in-process only; nothing
// here forwards a request to an actor's own HTTP front door except the
// signed feedback pages.
//
//   GET    /v1/health                     anyone           liveness and version
//   GET    /v1/assets/<icon>.png          anyone           thumbs icons for emails and pages
//   GET    /v1/feedback?p=…|view=…        signed links     thumbs, reasons, digest web view
//   GET    /v1/digests                    operator token   list digest definitions
//   GET    /v1/digests/<id>               operator token   one definition (Markdown)
//   PUT    /v1/digests/<id>               operator token   store a definition (body: Markdown)
//   DELETE /v1/digests/<id>               operator token   delete a definition
//   POST   /v1/digests/<id>/runs          operator token   start a run: {"message"?, "run"?}
//   GET    /v1/runs/<conversation>        operator token   the conversation's recent runs
//
//   GET    /v1/app[/…]                    session cookie   the digests page (src/app.ts; magic-link sign-in)
//
//   GET    /agents/ai-digest/feedback?…   signed links     same as /v1/feedback (links in emails sent before 0.2.0)

import { THUMB_DOWN_PNG_BASE64, THUMB_UP_PNG_BASE64 } from "./assets.ts";
import { mayUseFrontDoor } from "./auth.ts";
import { SECRET, secret } from "./config.ts";
import { ID_PATTERN, ProfileError, parseProfile, runConversation, runMessage } from "./profile.ts";
import { app } from "./app.ts";
import { parseRecipients } from "./config.ts";

export const VERSION = "0.2.1";
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
    async sendEmail(to, subject, text, html) {
      if (!t || !from) throw new Error("email isn't configured (DIGEST_EMAIL_FROM)");
      await t.post("/emails", { body: { from, to: [to], subject, text_body: text, html_body: html } });
    },
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2) + "\n", { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const png = (b64: string) =>
  new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=2592000" } });

/** A run name: the caller's, or the current UTC time (e.g. 2026-11-07t2155). */
export function runName(given: unknown, now = new Date()): string {
  if (typeof given === "string" && /^[a-z0-9][a-z0-9-]{0,40}$/.test(given) && !given.includes("--")) return given;
  return now.toISOString().slice(0, 16).replace(/[:]/g, "").toLowerCase();
}

export async function route(req: Request, env: RouterEnv): Promise<Response> {
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
      if (id !== undefined && !ID_PATTERN.test(id)) return json(400, { error: "bad_id", message: "ids are lowercase letters, digits and single dashes" });
      if (!id && method === "GET") return json(200, await actor(DIGESTS_ACTOR).listDigests());
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
          return json(200, await actor(DIGESTS_ACTOR).putDigest(id, markdown));
        }
        if (method === "DELETE") return json(200, await actor(DIGESTS_ACTOR).deleteDigest(id));
      }
      if (id && parts[2] === "runs" && parts.length === 3 && method === "POST") {
        const d = await actor(DIGESTS_ACTOR).getDigest(id);
        if (!d) return json(404, { error: "not_found", message: `no digest "${id}": push it first (npm run digests -- push)` });
        const body = await req.json().catch(() => ({}));
        const conversation = runConversation(id, runName(body?.run));
        const message = runMessage(parseProfile(id, d.markdown), typeof body?.message === "string" ? body.message : undefined);
        const accepted = await actor(conversation).receive(message);
        return json(202, { digest: id, conversation, run: accepted });
      }
    }
    if (parts[0] === "runs" && parts[1] && parts.length === 2 && method === "GET") {
      const t = await actor(parts[1]).traces(5);
      return json(200, { conversation: parts[1], runs: Array.isArray(t?.runs) ? t.runs : [] });
    }
  } catch (err) {
    console.log(JSON.stringify({ api: "error", path, error: err instanceof Error ? err.message : String(err) }));
    return json(500, { error: "internal", message: err instanceof Error ? err.message : String(err) });
  }
  return json(404, { error: "not_found", message: `${method} ${path} isn't part of the v1 API` });
}

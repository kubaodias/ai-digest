// The talk routes: the issue page (from a talk link, or a thumbs or view link
// in the email) and the tools the page calls for the voice assistant, all
// signed by the link's token rather than the operator token (talk.ts has the
// tokens and links, talk-page.ts the page).

import type { AiDigest } from "./agent.ts";
import { FEEDBACK_CONVERSATION } from "./actors.ts";
import { SECRET, secret } from "./config.ts";
import { verifyPayload, verifyView, type DigestItemRecord, type DigestRecord } from "./feedback.ts";
import { json } from "./http.ts";
import type { RouterEnv } from "./router.ts";
import { TALK_TTL_S, addTalkLinks, readArticle, rebaseLinks, searchWeb, talkLinks, talkToken, verifyTalkToken } from "./talk.ts";
import { emailBody, talkPage } from "./talk-page.ts";
import type { TelnyxPoster } from "./telnyx.ts";

/** The talk page and its tools (signed by the link's token, not the operator token). */
export async function talkRoute(req: Request, env: RouterEnv, path: string, method: string): Promise<Response> {
  const s = (n: string) => secret(env, n);
  const [key, assistantId] = await Promise.all([s(SECRET.feedbackKey), s(SECRET.talkAssistant)]);
  const feedback = env.AI_DIGEST.idFromName(FEEDBACK_CONVERSATION);
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
  const item = record.items.find((i) => i.n === Number(args.story));
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name as keyof typeof TOOLS] : undefined;
  const started = Date.now();
  try {
    if (name === "log") return logClientError(claim.d, args);
    // Searches and article reads cost money: limited per issue and per deployment each day (TALK_LIMITS).
    if (name === "search_web" || name === "read_article") {
      const refused = await feedback.spendTalkTool(claim.d, name);
      if (refused) return json(200, { error: refused });
    }
    if (!tool) return json(404, { error: "unknown_tool" });
    // Without the binding a tool call throws and the page gets the error.
    const out = await tool({ issue: claim.d, args, item, feedback, telnyx: env.TELNYX as TelnyxPoster });
    console.log(JSON.stringify({ talk: "tool", tool: name, issue: claim.d, story: item?.n ?? null, ms: Date.now() - started }));
    return json(200, out);
  } catch (err) {
    console.log(JSON.stringify({ talk: "tool failed", tool: name, issue: claim.d, error: err instanceof Error ? err.message : String(err) }));
    return json(200, { error: "the tool failed; say so and continue" });
  }
}

/** A talk tool call: the issue its token is for, the page's arguments, and the story they name (if any). */
interface ToolCall {
  issue: string;
  args: Record<string, unknown>;
  item: DigestItemRecord | undefined;
  feedback: AiDigest;
  telnyx: TelnyxPoster;
}

const vote = (a: Record<string, unknown>) => (a.vote === "up" || a.vote === "down" ? a.vote : undefined);
const NEEDS_VOTE = { error: "story and vote (up or down) are required" };

/** The tools the talk page answers for the assistant, plus the page's own votes. */
const TOOLS = {
  read_article: ({ args, item, telnyx }: ToolCall) => (item ? readArticle(telnyx, item, typeof args.focus === "string" ? args.focus.slice(0, 300) : undefined) : { error: "no such story" }),
  search_web: ({ args, telnyx }: ToolCall) => (typeof args.query === "string" && args.query.trim() ? searchWeb(telnyx, args.query) : { error: "query is required" }),
  record_vote: ({ issue, args, item, feedback }: ToolCall) => {
    const v = vote(args);
    return item && v ? feedback.talkVote({ d: issue, i: item.n, v, via: "voice" }) : NEEDS_VOTE;
  },
  // The page's own 👍/👎 and reasons (not one of the assistant's tools).
  feedback: ({ issue, args, item, feedback }: ToolCall) => {
    const v = vote(args);
    return item && v
      ? feedback.talkVote({ d: issue, i: item.n, v, r: typeof args.reason === "string" ? args.reason : undefined, x: typeof args.x === "number" ? args.x : undefined, undo: args.undo === true, via: "page" })
      : NEEDS_VOTE;
  },
};

/** The page reports a problem starting a call: logged without personal data (the error and the browser). */
function logClientError(issue: string, args: Record<string, unknown>): Response {
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : v === null || v === undefined ? null : String(v).slice(0, n));
  console.log(JSON.stringify({ talk: "client error", issue, stage: str(args.stage, 20), error: str(args.error, 300), code: str(args.code, 20), fatal: args.fatal === true, ua: str(args.ua, 200) }));
  return json(200, { ok: true });
}

/** The issue page for a plain thumbs click (the vote is recorded) or a view link; undefined to use the older pages. */
export async function issuePageFor(req: Request, env: RouterEnv): Promise<Response | undefined> {
  const url = new URL(req.url);
  const q = url.searchParams;
  if (q.has("r") || q.has("undo") || q.has("x")) return undefined;
  const s = (n: string) => secret(env, n);
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
  const feedback = env.AI_DIGEST.idFromName(FEEDBACK_CONVERSATION);
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
async function issuePage(env: RouterEnv, origin: string, key: string, assistantId: string, record: DigestRecord, token: string, opts: { start?: number; autostart: boolean; voted?: number }): Promise<Response> {
  let html = record.html ? rebaseLinks(record.html, origin) : undefined;
  if (html) html = addTalkLinks(html, await talkLinks(key, `${origin}/v1/talk`, record.id, record.items));
  const votes = await env.AI_DIGEST.idFromName(FEEDBACK_CONVERSATION).issueVotes(record.id).catch(() => ({}));
  return talkPage({ token, assistantId, record, start: opts.start, body: emailBody(html), votes, autostart: opts.autostart, voted: opts.voted });
}

function talkError(status: number, message: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Talk</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;"><p>${message}</p></body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

import { ManagedAgent, type ManagedAgentSpec, type ManagedEnv } from "@telnyx/acp/managed";
import { tool } from "ai";
import { marked } from "marked";
import { z } from "zod";
import { INSTRUCTIONS } from "./instructions.ts";
import { addImages } from "./images.ts";
import { THUMB_DOWN_PNG_BASE64, THUMB_UP_PNG_BASE64 } from "./assets.ts";
import { DOWN_REASONS, UP_REASONS, sharedEntityPrefs } from "./preferences.ts";
import { digestFromReply } from "./digest.ts";
import { SECRET, loadConfig, secret } from "./config.ts";
import { GENERAL_ID, LEGACY_PROFILE, audienceOf, generalProfile, parseProfile, profileIdOf, type DigestProfile } from "./profile.ts";
import { claimsFor, mayUseFrontDoor } from "./auth.ts";
import {
  FEEDBACK_CONVERSATION, KEEP_DIGESTS, MEMORY_NAMESPACE, addFeedbackLinks, feedbackBase, errorPage, feedbackLink, forgetVote, rememberVote,
  nextVote, preferencesFrom, tagItems, thanksPage, undonePage, verifyPayload, verifyView, viewLink, type DigestRecord, type StoredVote,
} from "./feedback.ts";

// ai-digest: a research agent on Telnyx Edge Compute that writes email digests
// on any topic, defined per digest (profile.ts), emails them, and learns from
// thumbs feedback, separately for each digest. Each conversation is one durable
// instance of this class: "<digest>--<run>" for runs (the built-in General
// digest's runs are "__general--<run>" and keep their topic in state), plus two
// service actors, "feedback" (votes, sent issues) and "digests" (the definitions).
// Account-specific settings are Telnyx secrets: see config.ts.

/** The service actor that stores the digest definitions. */
const DIGESTS_CONVERSATION = "digests";
/** Versions kept per digest definition. */
const KEEP_VERSIONS = 10;

const spec: ManagedAgentSpec = {
  name: "ai-digest",
  model: "deepseek-ai/DeepSeek-V4.1-Flash",
  instructions: INSTRUCTIONS,
  tools: [{ type: "web_search", freshness: "month" }],
  limits: { steps: 30 },
  // No `memory`: the agent keeps nothing between conversations.
} as ManagedAgentSpec;

/** The footer logo (the Telnyx mark, 200x200 PNG). */
const LOGO_URL = "https://www.activepieces.com/piece-icon/telnyx";

/** Markdown → an email-safe HTML document (inline styles; Gmail drops most <style> rules). */
export function renderEmailHtml(markdown: string, subject: string): string {
  const body = (marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string)
    .replace(/<h1>/g, '<h1 style="font-size:24px;line-height:1.3;margin:0 0 20px;color:#111827;">')
    .replace(/<h2>/g, '<h2 style="font-size:18px;line-height:1.35;margin:28px 0 8px;color:#111827;border-top:1px solid #e5e7eb;padding-top:20px;">')
    .replace(/<h3>/g, '<h3 style="font-size:16px;margin:20px 0 6px;color:#111827;">')
    .replace(/<p>/g, '<p style="margin:0 0 10px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 12px;padding-left:22px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 12px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 6px;">')
    .replace(/<a href=/g, '<a style="color:#2563eb;text-decoration:none;" href=')
    .replace(/<code>/g, '<code style="font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#f3f4f6;padding:1px 4px;border-radius:4px;">')
    .replace(/<pre>/g, '<pre style="background:#f3f4f6;padding:12px;border-radius:6px;overflow:auto;">')
    // A picked image and its caption line (from images.ts) become one centered block.
    .replace(/<p[^>]*>\s*<img src="([^"]+)" alt="([^"]*)">(?:<br>)?\s*<em>([^<]*)<\/em>\s*<\/p>/g,
      '<div style="margin:14px 0 16px;text-align:center;"><img width="600" src="$1" alt="$2" style="display:block;width:100%;max-width:600px;height:auto;margin:0 auto;border-radius:8px;border:1px solid #e5e7eb;"><div style="font-size:12px;line-height:1.4;color:#6b7280;margin-top:6px;">$3</div></div>')
    .replace(/<img src=/g, '<img style="display:block;max-width:100%;height:auto;border-radius:8px;" src=')
    .replace(/<blockquote>/g, '<blockquote style="margin:0 0 12px;padding-left:12px;border-left:3px solid #e5e7eb;color:#4b5563;">');
  const title = subject.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f5f5f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 28px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;">
${body}
</td></tr>
<tr><td style="padding:14px 28px 22px;border-top:1px solid #f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:20px;color:#9ca3af;">
<span style="vertical-align:middle;">AI Digest · made with <a href="https://telnyx.com/products/edge-compute" style="color:#9ca3af;text-decoration:underline;">Telnyx Edge Compute</a></span><img src="${LOGO_URL}" width="20" height="20" alt="Telnyx" style="display:inline-block;width:20px;height:20px;border:0;vertical-align:middle;margin-left:6px;">
</td></tr>
</table></td></tr></table>
</body></html>`;
}

/** The FEEDBACK_KEY secret that signs the thumbs links; undefined when it isn't bound (then no links are added). */
async function feedbackKey(env: ManagedEnv): Promise<string | undefined> {
  const secrets = (env as any).SECRETS;
  return secrets ? ((await secrets.get(SECRET.feedbackKey).catch(() => "")) || undefined) : undefined;
}

/** The service actors, reached in-process. */
const feedbackActor = (env: ManagedEnv) => (env as any).AI_DIGEST.idFromName(FEEDBACK_CONVERSATION);
const digestsActor = (env: ManagedEnv) => (env as any).AI_DIGEST.idFromName(DIGESTS_CONVERSATION);

/** A digest's definition, parsed; undefined when it isn't stored (or is invalid). */
async function loadProfile(env: ManagedEnv, id: string): Promise<DigestProfile | undefined> {
  const stored = await digestsActor(env).getDigest(id).catch(() => undefined);
  if (!stored) return undefined;
  try {
    return parseProfile(id, stored.markdown);
  } catch {
    return undefined;
  }
}

/**
 * The Agent Memory profile summary, current. The service builds it only when
 * asked (`refresh=true`; a plain read of a stale summary returns null and
 * builds nothing), and building takes up to ~40 s, so ask and wait for it.
 */
async function readMemorySummary(env: ManagedEnv, profile: string, waitMs = 60_000): Promise<string | null> {
  const url = `/ai/memory/namespaces/${MEMORY_NAMESPACE}/profiles/${encodeURIComponent(profile)}/summary`;
  const telnyx = env.TELNYX as any;
  const first: any = await telnyx.get(url, { query: { refresh: "true" } });
  if (first?.data?.text && !first.data.is_stale) return first.data.text;
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5_000));
    const r: any = await telnyx.get(url);
    if (r?.data?.text && !r.data.is_stale) return r.data.text;
  }
  return first?.data?.text ?? null; // a stale summary beats none
}

/** Lets tools reach the actor they run in (set right after construction). */
interface ActorHolder {
  actor?: AiDigest;
}

/** The tools this class adds over web_search/fetch_page: the reader's preferences. */
function emailTools(env: ManagedEnv, holder: ActorHolder) {
  return {
    reader_preferences: tool({
      description:
        "This digest's reader preferences, learned from their thumbs feedback: `feedback` from this digest's own past issues (entity preferences: apply strictly; topic preferences with enough evidence: apply softly; tentative topics: ignore; recent votes with reasons), `shared` entity preferences from the reader's other digests (see its guidance), and a memory summary. Call once before researching.",
      inputSchema: z.object({}),
      execute: async () => {
        const profile = profileIdOf(holder.actor?.conversationName()) ?? LEGACY_PROFILE;
        const topic = profile === GENERAL_ID ? (await holder.actor?.generalRun())?.topic : undefined;
        const out: Record<string, unknown> = { digest: profile, ...(topic ? { topic } : {}) };
        try {
          out.feedback = await feedbackActor(env).feedbackStats(profile);
          out.shared = await feedbackActor(env).sharedPreferences(profile, topic);
        } catch (err) {
          out.feedbackError = err instanceof Error ? err.message : String(err);
        }
        out.memorySummary = await readMemorySummary(env, profile).catch(() => null);
        console.log(JSON.stringify({ toolCall: "reader_preferences", digest: profile, votes: (out.feedback as any)?.votes ?? 0, shared: (out.shared as any)?.entities?.length ?? 0, memory: out.memorySummary ? "yes" : "none" }));
        return out;
      },
    }),
  };
}

/** Emailing a finished digest: pictures, thumbs links, render, send, and register the digest with the feedback actor. */
async function sendDigestEmail(
  env: ManagedEnv,
  { subject, markdown, profileId, profile }: { subject: string; markdown: string; profileId: string; profile?: DigestProfile },
) {
  const started = Date.now();
  const telnyx = env.TELNYX as any;
  if (!telnyx) return { ok: false, error: "no TELNYX binding" };
  const { config, missing } = await loadConfig(env);
  if (!config) return { ok: false, error: `missing secrets: ${missing.join(", ")} (telnyx-acp add secret NAME)` };
  const base = feedbackBase(config.publicUrl);
  const images = profile?.images ?? true;
  const to = profile?.to.length ? profile.to : config.emailTo;
  const log = (e: Record<string, unknown>) => console.log(JSON.stringify(e));
  // Pictures go into the HTML part only; a failure here never blocks the email.
  let htmlMarkdown = markdown;
  let picked: { headline: string; images: number; note?: string }[] = [];
  let pickedImages: { url: string; caption: string }[][] = [];
  if (images) {
    try {
      const r = await addImages(telnyx, markdown, log, audienceOf(profile));
      htmlMarkdown = r.markdown;
      picked = r.report.map((i) => ({ headline: i.headline, images: i.images.length, ...(i.note ? { note: i.note } : {}) }));
      pickedImages = r.report.map((i) => i.images.map((im) => ({ url: im.url, caption: im.caption })));
      log({ images: "done", items: picked.length, withImages: picked.filter((p) => p.images > 0).length, ms: Date.now() - started });
    } catch (err) {
      log({ images: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Grey thumbs links closing each item (HTML part only); skipped when the signing key is missing.
  const digestId = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 6);
  let feedbackItems = 0;
  let record: DigestRecord | undefined;
  try {
    const key = await feedbackKey(env);
    if (key) {
      const r = await addFeedbackLinks(telnyx, key, base, digestId, subject, markdown, htmlMarkdown, pickedImages);
      htmlMarkdown = r.markdown;
      record = { ...r.record, profile: profileId, ...(profile?.topic ? { topic: profile.topic } : {}) };
      feedbackItems = r.record.items.length;
      log({ feedback: "links added", digest: digestId, items: feedbackItems, tags: r.record.items.map((i) => i.tags) });
    } else log({ feedback: "no FEEDBACK_KEY; links skipped" });
  } catch (err) {
    log({ feedback: "links failed", error: err instanceof Error ? err.message : String(err) });
  }
  try {
    // The API wants `to` as an array and the bodies as text_body / html_body (unknown fields are silently dropped).
    const html = renderEmailHtml(htmlMarkdown, subject);
    const res: any = await telnyx.post("/emails", {
      body: { from: config.emailFrom, to, subject, text_body: markdown, html_body: html },
    });
    const data = res?.data ?? res;
    // The feedback actor keeps the digest so a click can show the article and the digest it came from.
    if (record) {
      await feedbackActor(env)
        .registerDigest({ ...record, html })
        .catch((err: unknown) => log({ feedback: "register failed", error: err instanceof Error ? err.message : String(err) }));
    }
    log({ emailApi: "queued", ok: true, digest: profileId, id: data?.id, status: data?.status, ms: Date.now() - started });
    return { ok: true, id: data?.id, status: data?.status, imagesAdded: picked.reduce((n, p) => n + p.images, 0), feedbackItems, digestId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log({ emailApi: "failed", ok: false, error, ms: Date.now() - started });
    return { ok: false, error };
  }
}

export class AiDigest extends ManagedAgent {
  private readonly agentEnv: ManagedEnv;

  constructor(ctx: ConstructorParameters<typeof ManagedAgent>[0], env: ManagedEnv) {
    const holder: ActorHolder = {};
    super(ctx, env, spec, { tools: emailTools(env, holder) });
    holder.actor = this;
    this.agentEnv = env;
  }

  /**
   * Defence in depth: the v1 router never hands requests to an actor's own
   * front door (state streams, RPC) except the signed feedback pages, but if
   * one arrives it needs the operator token (see auth.ts).
   */
  override async authorize(token?: string, _req?: Request): Promise<any> {
    const claims = await claimsFor(token, await secret(this.agentEnv, SECRET.authKey));
    if (!claims.length) console.log(JSON.stringify({ auth: "refused", conversation: this.conversationName() ?? null, token: token ? "wrong" : "none" }));
    return claims;
  }

  /**
   * A General run's settings, stored in this run's own conversation before
   * the request is sent (the router calls it in-process; not @rpc). Each run
   * has its own conversation, so concurrent asks never share it.
   */
  async prepareGeneralRun(run: { topic: string; window?: string; items?: string }) {
    const p = generalProfile(run.topic, run); // validates again
    await (this as any).setState({ general: { topic: p.topic, window: `${p.windowDays}d`, items: `${p.items.min}-${p.items.max}` } });
    return { topic: p.topic };
  }

  /** This conversation's General digest definition, or undefined (not a General run, or no topic stored). */
  async generalRun(): Promise<DigestProfile | undefined> {
    const g = ((await (this as any).getState()) as any)?.general;
    if (!g?.topic) return undefined;
    try {
      return generalProfile(g.topic, g);
    } catch {
      return undefined;
    }
  }

  /** A digest was emailed from this conversation now (guards against a second send for the same run). */
  async markEmailed() {
    await (this as any).setState({ emailedAt: Date.now() });
  }

  /**
   * Email delivery, deterministic: after every completed run (the managed
   * loop's post-run hook; memory is off, so its own body does nothing), if the
   * final reply is a digest (numbered "## N." items), it is emailed. The model
   * has no email tool. The run id carries its start time in ms; `emailedAt`
   * stops a second send if the hook runs again for the same run.
   */
  async rememberRun(runId: string, before: number) {
    await (ManagedAgent.prototype as any).rememberRun.call(this, runId, before);
    const conversation = this.conversationName();
    if (conversation === FEEDBACK_CONVERSATION || conversation === DIGESTS_CONVERSATION) return;
    try {
      const started = Number(runId.match(/-(\d{13})-/)?.[1] ?? 0);
      const state: any = await (this as any).getState();
      if (started && (state?.emailedAt ?? 0) >= started) return;
      const msgs = ((await (this as any).messages.all()) as { seq: number; role: string; content: string }[]).filter((m) => m.seq > before);
      const reply = [...msgs].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content ?? "";
      const digest = digestFromReply(reply);
      if (!digest) return; // not a digest (an answer, an error, a question): nothing to email
      const { subject, markdown } = digest;
      const profileId = profileIdOf(conversation) ?? LEGACY_PROFILE;
      const profile = profileId === GENERAL_ID ? await this.generalRun() : await loadProfile(this.agentEnv, profileId);
      console.log(JSON.stringify({ digestEmail: "sending", runId, digest: profileId, definition: profile ? (profileId === GENERAL_ID ? "general" : "stored") : "defaults" }));
      const result = await sendDigestEmail(this.agentEnv, { subject, markdown, profileId, profile });
      if (result.ok) await this.markEmailed();
      console.log(JSON.stringify({ digestEmail: result.ok ? "sent" : "failed", runId, ...(result.ok ? { id: (result as any).id } : { error: (result as any).error }) }));
    } catch (err) {
      console.log(JSON.stringify({ digestEmail: "error", runId, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /**
   * GETs on the `feedback` conversation (forwarded by the router): thumbs
   * clicks and a stored issue's web view, each signed on its own, and the old
   * `?asset=` icon URLs from emails sent before 0.2.0. Anything else is the
   * managed loop's front door, which needs the operator token.
   */
  override async fetch(req: Request): Promise<Response> {
    if (req.method === "GET" && this.conversationName() === FEEDBACK_CONVERSATION) {
      const url = new URL(req.url);
      const asset = url.searchParams.get("asset");
      if (asset === "thumb-up.png" || asset === "thumb-down.png") {
        const bytes = Uint8Array.from(atob(asset === "thumb-up.png" ? THUMB_UP_PNG_BASE64 : THUMB_DOWN_PNG_BASE64), (c) => c.charCodeAt(0));
        return Promise.resolve(new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "public, max-age=2592000" } }));
      }
      if (url.searchParams.has("view")) return this.onView(url);
      if (url.searchParams.has("p")) return this.onFeedback(url);
    }
    if (!(await mayUseFrontDoor(req, await secret(this.agentEnv, SECRET.authKey)))) {
      console.log(JSON.stringify({ auth: "refused", conversation: this.conversationName() ?? null, path: new URL(req.url).pathname }));
      return new Response(JSON.stringify({ error: "unauthorized", message: "this agent needs the operator token (telnyx-acp sends it)" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    return super.fetch(req);
  }

  private async onView(url: URL): Promise<Response> {
    const key = await feedbackKey(this.agentEnv);
    const id = url.searchParams.get("view") ?? "";
    if (!key || !(await verifyView(key, id, url.searchParams.get("s") ?? ""))) return errorPage(400, "The link is invalid.");
    const state: any = await (this as any).getState();
    const digest: DigestRecord | undefined = state?.digests?.[id];
    if (!digest?.html) return errorPage(404, "That digest is no longer stored.");
    return new Response(digest.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  }

  private async onFeedback(url: URL): Promise<Response> {
    const key = await feedbackKey(this.agentEnv);
    if (!key) return errorPage(503, "Feedback isn't configured.");
    const p = await verifyPayload(key, url.searchParams.get("p") ?? "", url.searchParams.get("s") ?? "");
    if (!p) return errorPage(400, "The link is invalid or has expired.");
    const telnyx = this.agentEnv.TELNYX as any;
    const id = `${p.d}:${p.i}`;
    const state: any = await (this as any).getState();
    const digest: DigestRecord | undefined = state?.digests?.[p.d];
    const item = digest?.items.find((i) => i.n === p.i);
    const prior: StoredVote | undefined = state?.votes?.[id];
    if (!item && !prior) return errorPage(404, "That digest is no longer stored, so the vote can't be matched to an article.");
    // This page's own URL is the feedback base: no configuration needed to build its links.
    const base = `${url.origin}${url.pathname}`;
    // Votes, preferences and memory are per digest: the issue's digest, else the vote's, else the default.
    const profile = digest?.profile ?? prior?.profile ?? LEGACY_PROFILE;
    const view = digest?.html ? await viewLink(key, base, p.d) : undefined;
    try {
      if (url.searchParams.get("undo") === "1") {
        if (prior) {
          await forgetVote(telnyx, profile, prior.memorySource).catch((err: unknown) => console.log(JSON.stringify({ feedback: "memory delete failed", error: String(err) })));
          await (this as any).setState({ votes: { [id]: null } });
          // Ingestion is asynchronous: a memory still being extracted can land after this delete. Delete again later.
          if (prior.memorySource) await this.later(120, "forgetMemorySourceLater", { source: prior.memorySource, profile });
        }
        console.log(JSON.stringify({ feedback: "undo", id }));
        return undonePage(item?.headline ?? prior?.headline ?? "", view);
      }
      const { vote, changed } = nextVote(prior, p, item, new Date().toISOString());
      vote.profile ??= profile;
      if (digest?.topic) vote.topic ??= digest.topic;
      // "I don't use X" needs to know X: fill in entities for votes on items tagged before entities existed; the main one is meant.
      const untargeted = vote.reasons?.find((x) => x.r === "entity" && !x.target);
      if (untargeted && !vote.entities?.length) {
        vote.entities = (await tagItems(telnyx, [{ headline: vote.headline, why: item?.why ?? "" }]))[0]?.entities ?? [];
        if (vote.entities[0]) untargeted.target = vote.entities[0];
      }
      if (changed) {
        vote.memorySource = await rememberVote(telnyx, profile, vote).catch((err: unknown) => {
          console.log(JSON.stringify({ feedback: "memory write failed", error: String(err) }));
          return prior?.memorySource;
        });
        await (this as any).setState({ votes: { [id]: vote } });
      }
      console.log(JSON.stringify({ feedback: "vote", id, vote: vote.vote, reasons: vote.reasons ?? [], entities: vote.entities, tags: vote.tags, changed }));
      const votes = (Object.values({ ...(state?.votes ?? {}), [id]: vote }).filter(Boolean) as StoredVote[]).filter((v) => (v.profile ?? LEGACY_PROFILE) === profile);
      const pay = { d: p.d, i: p.i, v: p.v, e: p.e };
      const flip = await feedbackLink(key, base, { ...pay, v: p.v === "up" ? "down" : "up" });
      const undo = await feedbackLink(key, base, pay, "&undo=1");
      const reasons: Record<string, string> = {};
      const ents = item?.entities?.length ? item.entities : (vote.entities ?? []);
      for (const r of p.v === "up" ? UP_REASONS : DOWN_REASONS) {
        if (r !== "entity") reasons[r] = await feedbackLink(key, base, { ...pay, r });
        else if (!ents.length) reasons.entity = await feedbackLink(key, base, { ...pay, r });
        else for (let k = 0; k < Math.min(3, ents.length); k++) reasons[`entity:${k}`] = await feedbackLink(key, base, { ...pay, r, x: k });
      }
      return thanksPage({ base, vote, item, digest, prefs: preferencesFrom(votes), links: { undo, flip, view, reasons } });
    } catch (err) {
      console.log(JSON.stringify({ feedback: "failed", id, error: err instanceof Error ? err.message : String(err) }));
      return errorPage(500, "Something went wrong recording that. Try again in a minute.");
    }
  }

  /** Schedule one of the methods below; a failure to schedule is logged, never thrown at the reader. */
  private async later(seconds: number, method: string, payload: unknown, id?: string) {
    try {
      await (this as any).schedule(seconds, method, payload, id ? { id } : undefined);
    } catch (err) {
      console.log(JSON.stringify({ feedback: "schedule failed", method, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Scheduled after an undo: delete the vote's memory source again, catching memories extracted after the first delete. */
  async forgetMemorySourceLater(p: { source: string; profile?: string }) {
    await forgetVote(this.agentEnv.TELNYX as any, p.profile ?? LEGACY_PROFILE, p.source).catch(() => undefined);
    console.log(JSON.stringify({ feedback: "memory deleted again", source: p.source }));
  }

  /** Keep a sent digest (newest KEEP_DIGESTS). Called in-process when a digest is emailed; not @rpc, so not on the public mount. */
  async registerDigest(record: DigestRecord) {
    const state: any = await (this as any).getState();
    const older = Object.values(state?.digests ?? {}).filter(Boolean) as DigestRecord[];
    const drop = older.sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(KEEP_DIGESTS - 1).map((d) => d.id);
    await (this as any).setState({ digests: { [record.id]: record, ...Object.fromEntries(drop.map((d) => [d, null])) } });
    return { stored: record.id, dropped: drop.length };
  }

  /** For the page: sent issues (newest first) and votes per digest. Called in-process; not @rpc. */
  async appOverview() {
    const state: any = await (this as any).getState();
    const issues = (Object.values(state?.digests ?? {}).filter(Boolean) as DigestRecord[])
      .map((d) => ({ id: d.id, profile: d.profile ?? LEGACY_PROFILE, ...(d.topic ? { topic: d.topic } : {}), subject: d.subject, sentAt: d.sentAt, items: d.items.length }))
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    const votes: Record<string, number> = {};
    for (const v of Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[]) votes[v.profile ?? LEGACY_PROFILE] = (votes[v.profile ?? LEGACY_PROFILE] ?? 0) + 1;
    return { issues, votes };
  }

  /** One digest's preferences from the vote log, for `reader_preferences`. Called in-process; not @rpc. */
  async feedbackStats(profile: string = LEGACY_PROFILE) {
    const state: any = await (this as any).getState();
    const votes = (Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[]).filter((v) => (v.profile ?? LEGACY_PROFILE) === profile);
    return preferencesFrom(votes);
  }

  /**
   * What a digest takes from the reader's other digests (preferences.ts,
   * sharedEntityPrefs): explicit entity reasons only. `topic` is a General
   * run's topic, never hidden by a shared "I don't use". Called in-process; not @rpc.
   */
  async sharedPreferences(profile: string = LEGACY_PROFILE, topic?: string) {
    const state: any = await (this as any).getState();
    const all = Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[];
    const own = preferencesFrom(all.filter((v) => (v.profile ?? LEGACY_PROFILE) === profile)).entities.map((e) => e.name);
    return sharedEntityPrefs(all, { profile, own, topic, legacyProfile: LEGACY_PROFILE });
  }

  // ── the `digests` actor: digest definitions (called in-process by the router) ──

  /** Every stored digest: id, title, window, items, schedule, when it changed. */
  async listDigests() {
    const state: any = await (this as any).getState();
    return Object.values(state?.profiles ?? {})
      .filter(Boolean)
      .map((d: any) => {
        let p: DigestProfile | undefined;
        try {
          p = parseProfile(d.id, d.markdown);
        } catch {}
        return { id: d.id, title: p?.title ?? null, windowDays: p?.windowDays ?? null, items: p?.items ?? null, schedule: p?.schedule ?? null, updatedAt: d.updatedAt, versions: (d.history?.length ?? 0) + 1 };
      })
      .sort((a: any, b: any) => a.id.localeCompare(b.id));
  }

  /** One digest's definition (Markdown), or null. */
  async getDigest(id: string) {
    const state: any = await (this as any).getState();
    const d = state?.profiles?.[id];
    return d ? { id, markdown: d.markdown, updatedAt: d.updatedAt, versions: (d.history?.length ?? 0) + 1 } : null;
  }

  /** Store a digest's definition (validated by the router), keeping the previous versions. */
  async putDigest(id: string, markdown: string) {
    const state: any = await (this as any).getState();
    const prev = state?.profiles?.[id];
    if (prev && prev.markdown === markdown) return { id, changed: false, versions: (prev.history?.length ?? 0) + 1 };
    const history = prev ? [{ markdown: prev.markdown, updatedAt: prev.updatedAt }, ...(prev.history ?? [])].slice(0, KEEP_VERSIONS - 1) : [];
    await (this as any).setState({ profiles: { [id]: { id, markdown, updatedAt: new Date().toISOString(), history } } });
    console.log(JSON.stringify({ digests: prev ? "updated" : "created", id }));
    return { id, changed: true, versions: history.length + 1 };
  }

  /** Sign-in links: at most one a minute. Called in-process by the page. */
  async magicRequested(now: number) {
    const state: any = await (this as any).getState();
    const last = state?.magicRequestedAt ?? 0;
    if (now - last < 60_000) return { ok: false, retryIn: Math.ceil((60_000 - (now - last)) / 1000) };
    await (this as any).setState({ magicRequestedAt: now });
    return { ok: true };
  }

  /** A sign-in link works once: false when its nonce was used already. Expired nonces are forgotten. */
  async consumeMagic(nonce: string, exp: number) {
    const state: any = await (this as any).getState();
    const used: Record<string, number> = state?.magicUsed ?? {};
    if (used[nonce]) return false;
    const nowS = Math.floor(Date.now() / 1000);
    const expired = Object.fromEntries(Object.entries(used).filter(([, e]) => e < nowS).map(([n]) => [n, null]));
    await (this as any).setState({ magicUsed: { ...expired, [nonce]: exp } });
    return true;
  }

  /** Delete a digest's definition (its sent issues, votes and memory stay). */
  async deleteDigest(id: string) {
    const state: any = await (this as any).getState();
    if (!state?.profiles?.[id]) return { id, deleted: false };
    await (this as any).setState({ profiles: { [id]: null } });
    console.log(JSON.stringify({ digests: "deleted", id }));
    return { id, deleted: true };
  }
}

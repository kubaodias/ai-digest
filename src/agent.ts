import { ManagedAgent, type ManagedAgentSpec, type ManagedEnv } from "@telnyx/acp/managed";
import { tool } from "ai";
import { marked } from "marked";
import { z } from "zod";
import { INSTRUCTIONS } from "./instructions.ts";
import { addImages } from "./images.ts";
import { THUMB_DOWN_PNG_BASE64, THUMB_UP_PNG_BASE64 } from "./assets.ts";
import { DOWN_REASONS, UP_REASONS } from "./preferences.ts";
import { digestFromReply } from "./digest.ts";
import { SECRET, loadConfig, memoryProfile } from "./config.ts";
import {
  FEEDBACK_CONVERSATION, KEEP_DIGESTS, MEMORY_NAMESPACE, addFeedbackLinks, feedbackBase, errorPage, feedbackLink, forgetVote, rememberVote,
  nextVote, preferencesFrom, tagItems, thanksPage, undonePage, verifyPayload, verifyView, viewLink, type DigestRecord, type StoredVote,
} from "./feedback.ts";

// ai-digest: a research agent on Telnyx Edge Compute that writes an AI and
// software engineering digest, emails it, and learns from thumbs feedback.
// Each conversation is one durable instance of this class. Account-specific
// settings (sender, recipients, public URL) are Telnyx secrets: see config.ts.

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

/** The `feedback` conversation's actor, reached in-process (not over the public mount). */
const feedbackActor = (env: ManagedEnv) => (env as any).AI_DIGEST.idFromName(FEEDBACK_CONVERSATION);

/**
 * The Agent Memory profile summary, current. The service builds it only when
 * asked (`refresh=true`; a plain read of a stale summary returns null and
 * builds nothing), and building takes up to ~40 s, so ask and wait for it.
 */
async function readMemorySummary(env: ManagedEnv, waitMs = 60_000): Promise<string | null> {
  const url = `/ai/memory/namespaces/${MEMORY_NAMESPACE}/profiles/${encodeURIComponent(await memoryProfile(env))}/summary`;
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

/** The tools this class adds over agent.json's web_search/fetch_page: the reader's preferences. */
function emailTools(env: ManagedEnv, holder: ActorHolder) {
  return {
    reader_preferences: tool({
      description:
        "The reader's preferences learned from their thumbs feedback on past digest items: entity preferences (specific products/companies: apply strictly), topic preferences with enough evidence (apply softly), tentative topics (ignore), source preferences, recent votes with reasons, and a memory summary. Call once before researching a digest.",
      inputSchema: z.object({}),
      execute: async () => {
        const out: Record<string, unknown> = {};
        try {
          out.feedback = await feedbackActor(env).feedbackStats();
        } catch (err) {
          out.feedbackError = err instanceof Error ? err.message : String(err);
        }
        out.memorySummary = await readMemorySummary(env).catch(() => null);
        console.log(JSON.stringify({ toolCall: "reader_preferences", votes: (out.feedback as any)?.votes ?? 0, memory: out.memorySummary ? "yes" : "none" }));
        return out;
      },
    }),
  };
}

/** Emailing a finished digest: pictures, thumbs links, render, send, and register the digest with the feedback actor. */
async function sendDigestEmail(env: ManagedEnv, { subject, markdown, images }: { subject: string; markdown: string; images: boolean }) {

  const started = Date.now();
  const telnyx = env.TELNYX as any;
  if (!telnyx) return { ok: false, error: "no TELNYX binding" };
  const { config, missing } = await loadConfig(env);
  if (!config) return { ok: false, error: `missing secrets: ${missing.join(", ")} (telnyx-acp add secret NAME)` };
  const base = feedbackBase(config.publicUrl);
  const log = (e: Record<string, unknown>) => console.log(JSON.stringify(e));
  // Pictures go into the HTML part only; a failure here never blocks the email.
  let htmlMarkdown = markdown;
  let picked: { headline: string; images: number; note?: string }[] = [];
  let pickedImages: { url: string; caption: string }[][] = [];
  if (images) {
    try {
      const r = await addImages(telnyx, markdown, log);
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
      record = r.record;
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
      body: { from: config.emailFrom, to: config.emailTo, subject, text_body: markdown, html_body: html },
    });
    const data = res?.data ?? res;
    // The feedback actor keeps the digest so a click can show the article and the digest it came from.
    if (record) {
      await feedbackActor(env)
        .registerDigest({ ...record, html })
        .catch((err: unknown) => log({ feedback: "register failed", error: err instanceof Error ? err.message : String(err) }));
    }
    log({ emailApi: "queued", ok: true, id: data?.id, status: data?.status, ms: Date.now() - started });
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
    if (this.conversationName() === FEEDBACK_CONVERSATION) return;
    try {
      const started = Number(runId.match(/-(\d{13})-/)?.[1] ?? 0);
      const state: any = await (this as any).getState();
      if (started && (state?.emailedAt ?? 0) >= started) return;
      const msgs = ((await (this as any).messages.all()) as { seq: number; role: string; content: string }[]).filter((m) => m.seq > before);
      const reply = [...msgs].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content ?? "";
      const digest = digestFromReply(reply);
      if (!digest) return; // not a digest (an answer, an error, a question): nothing to email
      const { subject, markdown } = digest;
      console.log(JSON.stringify({ digestEmail: "sending", runId }));
      const result = await sendDigestEmail(this.agentEnv, { subject, markdown, images: true });
      if (result.ok) await this.markEmailed();
      console.log(JSON.stringify({ digestEmail: result.ok ? "sent" : "failed", runId, ...(result.ok ? { id: (result as any).id } : { error: (result as any).error }) }));
    } catch (err) {
      console.log(JSON.stringify({ digestEmail: "error", runId, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** GETs on the `feedback` conversation: icons, a stored digest's web view, and thumbs clicks. Everything else is the managed loop's HTTP front door. */
  override fetch(req: Request): Promise<Response> {
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
    const profile = await memoryProfile(this.agentEnv);
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
      const votes = Object.values({ ...(state?.votes ?? {}), [id]: vote }).filter(Boolean) as StoredVote[];
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
    await forgetVote(this.agentEnv.TELNYX as any, p.profile ?? (await memoryProfile(this.agentEnv)), p.source).catch(() => undefined);
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

  /** The reader's preferences from the vote log, for `reader_preferences`. Called in-process from other conversations; not @rpc, so not on the public mount. */
  async feedbackStats() {
    const state: any = await (this as any).getState();
    return preferencesFrom(Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[]);
  }
}

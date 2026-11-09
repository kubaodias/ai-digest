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
  canonicalUrl, decide, housekeep, mergeCandidates, parseScoutReply, rescore, scoutSettings, slotOf,
  type Candidate, type Decision, type PoolEntry, type Sighting,
} from "./pool.ts";
import { quietNote, scoutMessage, writerMessage } from "./scout-instructions.ts";
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
// A digest with `scout:` also has a pool actor, "<digest>--pool", which runs
// scout passes ("<digest>--scout-<slot>") and writes issues from its pool
// ("<digest>--issue-<slot>"); see pool.ts and docs/spec/0010-continuous-scouting.md.
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
/** A digest's pool actor (continuous scouting). */
export const poolConversation = (digest: string) => `${digest}--pool`;
const poolActor = (env: ManagedEnv, digest: string) => (env as any).AI_DIGEST.idFromName(poolConversation(digest));
const DAY_MS = 24 * 3600 * 1000;
/** A scout pass still counts as running for this long (then a new one may start). */
const PASS_TIMEOUT_MS = 30 * 60 * 1000;
/** After this long, a pass that hasn't delivered is checked: its reply is re-delivered, or the pass is given up. */
const PASS_CHECK_MS = 5 * 60 * 1000;

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

  // ── continuous scouting: the run side (scout passes and issues) ──

  /** A scout pass's window, stored in its conversation before the request (called in-process by the pool actor). */
  async prepareScoutRun(run: { digest: string; slot: string; since: string; until: string }) {
    await (this as any).setState({ scoutRun: run });
  }

  /** An issue run's slot and stories, stored before the request (called in-process by the pool actor). */
  async prepareIssueRun(run: { slot: string; ids: string[] }) {
    await (this as any).setState({ issueRun: run });
  }

  /** A scout pass finished: validate and tag its candidates and hand them to the pool. */
  private async deliverScoutReply(reply: string, run: { digest: string; slot: string; since: string; until: string }) {
    const { candidates, dropped, seen } = parseScoutReply(reply, run);
    const tags = await tagItems(this.agentEnv.TELNYX as any, candidates.map((c) => ({ headline: c.headline, why: c.summary || c.why })));
    const tagged: Candidate[] = candidates.map((c, k) => ({ ...c, tags: tags[k]?.tags ?? [], entities: tags[k]?.entities ?? [] }));
    console.log(JSON.stringify({ scout: "pass done", digest: run.digest, slot: run.slot, candidates: tagged.length, seen: seen.length, dropped }));
    // Delivered by a durable task: retried with backoff until the pool takes it (a hung or failed call can't lose a pass).
    await (this as any).schedule(0, "deliverToPool", { digest: run.digest, slot: run.slot, candidates: tagged, seen, dropped }, { id: "deliver", maxRetries: 8 });
  }

  /**
   * Called by the pool for a pass that never delivered (e.g. the runtime
   * restarted before the post-run hook ran): deliver this conversation's
   * last reply again. Returns whether there was a reply to deliver.
   */
  async recoverPass() {
    const state: any = await (this as any).getState();
    if (!state?.scoutRun) return { delivered: false, reason: "not a scout pass" };
    const msgs = (await (this as any).messages.all()) as { role: string; content: string }[];
    const reply = [...msgs].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content;
    if (!reply) return { delivered: false, reason: "no reply" };
    await this.deliverScoutReply(reply, state.scoutRun);
    return { delivered: true };
  }

  /** Scheduled by deliverScoutReply; throws on failure so the task is retried. addCandidates ignores a repeat. */
  async deliverToPool(p: { digest: string; slot: string; candidates: Candidate[]; seen?: Sighting[]; dropped: number }) {
    await poolActor(this.agentEnv, p.digest).addCandidates({ slot: p.slot, candidates: p.candidates, seen: p.seen ?? [], dropped: p.dropped });
    console.log(JSON.stringify({ scout: "delivered", digest: p.digest, slot: p.slot }));
  }

  // ── continuous scouting: the pool actor, "<digest>--pool" ──

  private poolDigest(): string {
    const id = profileIdOf(this.conversationName());
    if (!id || this.conversationName() !== poolConversation(id)) throw new Error("not a pool actor");
    return id;
  }

  private async poolState(): Promise<{ entries: PoolEntry[]; meta: any }> {
    const state: any = await (this as any).getState();
    return { entries: Object.values(state?.poolEntries ?? {}).filter(Boolean) as PoolEntry[], meta: state?.poolMeta ?? {} };
  }

  /** Store the pool (only what changed) and merge `meta` into poolMeta. */
  private async savePool(before: PoolEntry[], after: PoolEntry[], meta: Record<string, unknown>) {
    const old = new Map(before.map((e) => [e.id, JSON.stringify(e)]));
    const patch: Record<string, PoolEntry | null> = {};
    for (const e of after) if (old.get(e.id) !== JSON.stringify(e)) patch[e.id] = e;
    for (const id of old.keys()) if (!after.some((e) => e.id === id)) patch[id] = null;
    await (this as any).setState({ poolEntries: patch, poolMeta: meta });
  }

  /**
   * Arm or cancel this digest's scout timer from its definition: called when a
   * definition is stored or deleted, and by every deploy (which pushes every
   * definition), so a lost timer comes back. The first pass runs a minute after
   * scouting is turned on.
   */
  async poolConfigure() {
    const id = this.poolDigest();
    const s = scoutSettings(await loadProfile(this.agentEnv, id));
    const { meta } = await this.poolState();
    if (!s) {
      await (this as any).cancelSchedule("scout").catch(() => false);
      await (this as any).cancelSchedule("scout-first").catch(() => false);
      if (meta.enabledAt) await (this as any).setState({ poolMeta: { enabledAt: null } });
      return { digest: id, scouting: false };
    }
    await (this as any).every(s.scoutHours * 3600, "scoutTick", {}, { id: "scout" });
    if (!meta.enabledAt) {
      const now = new Date().toISOString();
      await (this as any).setState({ poolMeta: { enabledAt: now, lastIssueAt: meta.lastIssueAt ?? now } });
      await (this as any).schedule(60, "scoutTick", {}, { id: "scout-first" });
    }
    return { digest: id, scouting: true, everyHours: s.scoutHours };
  }

  /** The timer's tick: one scout pass, unless one is still running. */
  async scoutTick() {
    await this.startPass({}).catch((err: unknown) => console.log(JSON.stringify({ scout: "tick failed", error: err instanceof Error ? err.message : String(err) })));
  }

  /**
   * Start a scout pass now (called in-process by the router, and by the timer).
   * `since`/`until` set the window (e.g. to replay past days); `decide: false`
   * only fills the pool; `force` writes an issue after the pass whatever the
   * thresholds say (a manual run), with an optional focus.
   */
  async startPass(opts: { since?: string; until?: string; decide?: boolean; force?: { focus?: string } }) {
    const id = this.poolDigest();
    const profile = await loadProfile(this.agentEnv, id);
    if (!scoutSettings(profile)) return { ok: false, error: `"${id}" doesn't scout: add "scout: 6h" to its definition` };
    const { entries, meta } = await this.poolState();
    const now = new Date();
    if (meta.passRunning) {
      const age = now.getTime() - Date.parse(meta.passRunning.startedAt);
      const running = `${id}--scout-${meta.passRunning.slot}`;
      if (age < PASS_CHECK_MS) {
        console.log(JSON.stringify({ scout: "skipped", digest: id, reason: "a pass is running", running: meta.passRunning.slot }));
        return { ok: false, error: "a scout pass is already running", conversation: running };
      }
      // A pass that should have delivered by now: wait while its run is still going,
      // else re-deliver its reply (e.g. the runtime restarted before its post-run hook), else give it up.
      if (age < PASS_TIMEOUT_MS) {
        if (await this.passStillRunning(running)) return { ok: false, error: "a scout pass is still running", conversation: running };
        const r = await (this.agentEnv as any).AI_DIGEST.idFromName(running).recoverPass().catch(() => ({ delivered: false, reason: "unreachable" }));
        if (r.delivered) {
          console.log(JSON.stringify({ scout: "recovered", digest: id, conversation: running }));
          return { ok: false, error: "the previous pass's reply was delivered again; start a new pass in a minute", conversation: running };
        }
      }
      console.log(JSON.stringify({ scout: "gave up", digest: id, conversation: running, ageMin: Math.round(age / 60000) }));
    }
    const until = opts.until ?? now.toISOString();
    const since = opts.since ?? (meta.lastPassAt ? new Date(Date.parse(meta.lastPassAt) - 3600_000).toISOString() : new Date(Date.parse(until) - profile!.windowDays * DAY_MS).toISOString());
    const slot = now.toISOString().slice(0, 19).replace(/[:]/g, "").toLowerCase();
    const conversation = `${id}--scout-${slot}`;
    const known = entries
      .filter((e) => e.state !== "expired")
      .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
      .map((e) => ({ id: e.id, headline: e.headline }));
    await (this as any).setState({ poolMeta: { passRunning: { slot, startedAt: now.toISOString(), since, until, decide: opts.decide ?? true, force: opts.force ?? null } } });
    // The run starts on an immediate task, so the caller (an API request) doesn't wait for actor start-ups.
    await (this as any).schedule(0, "runPass", { slot, since, until, known }, { id: `pass-${slot}` });
    return { ok: true, conversation, since, until };
  }

  /** Whether a pass's conversation still has a run in progress (its latest trace). */
  private async passStillRunning(conversation: string): Promise<boolean> {
    const t = await (this.agentEnv as any).AI_DIGEST.idFromName(conversation).traces(1).catch(() => undefined);
    const status = t?.runs?.[0]?.status;
    return status === "running" || status === "accepted" || status === "queued";
  }

  /** Scheduled by startPass: hand the request to the pass's own conversation. */
  async runPass(p: { slot: string; since: string; until: string; known: { id: string; headline: string }[] }) {
    const id = this.poolDigest();
    const profile = await loadProfile(this.agentEnv, id);
    if (!profile) return;
    const conversation = `${id}--scout-${p.slot}`;
    const run = (this.agentEnv as any).AI_DIGEST.idFromName(conversation);
    await run.prepareScoutRun({ digest: id, slot: p.slot, since: p.since, until: p.until });
    await run.receive(scoutMessage(profile, { since: p.since, until: p.until, known: p.known }));
    console.log(JSON.stringify({ scout: "pass started", digest: id, conversation, since: p.since, until: p.until }));
  }

  /** A scout pass's candidates (from its conversation's post-run hook): merge, score, decide. */
  async addCandidates(p: { slot: string; candidates: Candidate[]; seen?: Sighting[]; dropped: number }) {
    const id = this.poolDigest();
    const { entries, meta } = await this.poolState();
    if (meta.lastPassSlot === p.slot) return { duplicate: true }; // at-least-once delivery
    const profile = await loadProfile(this.agentEnv, id);
    const run = meta.passRunning?.slot === p.slot ? meta.passRunning : undefined;
    const now = new Date().toISOString();
    const merged = mergeCandidates(entries, p.candidates, now, p.seen ?? []);
    const pool = await this.refreshed(id, merged.pool, profile, now);
    const pass = { slot: p.slot, at: now, since: run?.since, until: run?.until, added: merged.added, merged: merged.merged, resighted: merged.resighted, dropped: p.dropped };
    const decision = profile && run?.decide !== false ? this.decision(pool, profile, meta, now, !!run?.force) : undefined;
    await this.savePool(entries, pool, {
      // A replayed pass (an `until` in the past) never moves the clock back.
      lastPassAt: [meta.lastPassAt, run?.until ?? now].filter(Boolean).sort().pop(),
      lastPassSlot: p.slot,
      passRunning: null,
      lastPass: pass,
      passes: (meta.passes ?? 0) + 1,
      ...(decision ? { lastDecision: { ...decision, at: now } } : {}),
    });
    console.log(JSON.stringify({ pool: "merged", digest: id, ...pass, live: pool.filter((e) => e.state === "candidate").length, decision: decision?.action ?? "skipped", reason: decision?.reason }));
    if (decision && decision.action !== "none" && profile) await this.startIssue(id, profile, pool, decision, meta, run?.force?.focus);
    return { added: merged.added, merged: merged.merged, decision: decision?.action ?? "skipped" };
  }

  /** Write an issue from the pool now, without a scout pass (a manual run with scouting off for this run). Queued, so the caller doesn't wait. */
  async writeNow(opts: { focus?: string } = {}) {
    const id = this.poolDigest();
    await (this as any).schedule(0, "runWriteNow", opts, { id: "write-now" });
    return { ok: true, queued: true, digest: id };
  }

  /** Scheduled by writeNow. */
  async runWriteNow(opts: { focus?: string } = {}) {
    const id = this.poolDigest();
    const profile = await loadProfile(this.agentEnv, id);
    if (!profile) return { ok: false, error: `no digest "${id}"` };
    const { entries, meta } = await this.poolState();
    const now = new Date().toISOString();
    const pool = await this.refreshed(id, entries, profile, now);
    const decision = this.decision(pool, profile, meta, now, true);
    await this.savePool(entries, pool, { lastDecision: { ...decision, at: now } });
    return { ok: true, ...(await this.startIssue(id, profile, pool, decision, meta, opts.focus)) };
  }

  /** Re-score with the reader's current preferences, then expire and trim. */
  private async refreshed(id: string, pool: PoolEntry[], profile: DigestProfile | undefined, now: string): Promise<PoolEntry[]> {
    const fb = feedbackActor(this.agentEnv);
    const [prefs, shared] = await Promise.all([fb.feedbackStats(id).catch(() => undefined), fb.sharedPreferences(id).catch(() => undefined)]);
    return housekeep(rescore(pool, prefs, shared, now), profile?.windowDays ?? 7, now);
  }

  private decision(pool: PoolEntry[], profile: DigestProfile, meta: any, now: string, force: boolean): Decision {
    const s = scoutSettings(profile) ?? { scoutHours: 24, sendAt: profile.items.min, strong: 7, minGapDays: 0, maxGapDays: 30 };
    return decide(pool, s, meta.lastIssueAt ?? meta.enabledAt ?? now, now, profile.items.max, force);
  }

  /** Reserve the chosen stories and start the writer run (or email the quiet note when there are none). */
  private async startIssue(id: string, profile: DigestProfile, pool: PoolEntry[], d: Decision, meta: any, focus?: string) {
    const now = new Date().toISOString();
    const ids = d.action === "none" ? [] : d.ids;
    if (!ids.length) {
      const note = quietNote(profile, meta.lastIssueAt ?? meta.enabledAt ?? now, now);
      const r = await sendDigestEmail(this.agentEnv, { ...note, profileId: id, profile });
      await (this as any).setState({ poolMeta: { lastIssueAt: now, lastIssue: { slot: slotOf(now), at: now, stories: 0, quiet: true } } });
      console.log(JSON.stringify({ pool: "quiet note", digest: id, ok: r.ok }));
      return { conversation: null, stories: 0 };
    }
    const slot = slotOf(now);
    const conversation = `${id}--issue-${slot}`;
    const chosen = ids.map((x) => pool.find((e) => e.id === x)!).filter(Boolean);
    const reserved = pool.map((e) => (ids.includes(e.id) ? { ...e, state: "reserved" as const, issue: slot, reservedAt: now } : e));
    await this.savePool(pool, reserved, { issueRunning: { slot, startedAt: now, stories: ids.length } });
    const run = (this.agentEnv as any).AI_DIGEST.idFromName(conversation);
    await run.prepareIssueRun({ slot, ids });
    const s = scoutSettings(profile);
    await run.receive(writerMessage(profile, chosen, { quiet: d.action === "issue-anyway" && !!s && d.strong < s.sendAt, focus }));
    console.log(JSON.stringify({ pool: "issue started", digest: id, conversation, stories: ids.length, reason: d.reason }));
    return { conversation, stories: ids.length };
  }

  /** The writer's email went out: its stories are sent, the ones it dropped return to the pool. */
  async markSent(p: { slot: string; urls: string[] }) {
    const { entries, meta } = await this.poolState();
    if (meta.lastIssue?.slot === p.slot) return { duplicate: true };
    const linked = new Set(p.urls.map((u) => canonicalUrl(u)).filter(Boolean));
    const now = new Date().toISOString();
    let sent = 0;
    const after = entries.map((e) => {
      if (e.state !== "reserved" || e.issue !== p.slot) return e;
      const inIssue = [e.url, ...e.sources.map((s) => s.url)].some((u) => linked.has(canonicalUrl(u)));
      if (inIssue) {
        sent++;
        return { ...e, state: "sent" as const, sentAt: now };
      }
      const { issue: _i, reservedAt: _r, ...rest } = e;
      return { ...rest, state: "candidate" as const };
    });
    await this.savePool(entries, after, { lastIssueAt: now, issueRunning: null, lastIssue: { slot: p.slot, at: now, stories: sent } });
    console.log(JSON.stringify({ pool: "issue sent", digest: this.poolDigest(), slot: p.slot, sent }));
    return { sent };
  }

  /** The pool for the API and the page: settings, timing, the last decision and the entries (live first). */
  async poolView() {
    const id = this.poolDigest();
    const profile = await loadProfile(this.agentEnv, id);
    const { entries, meta } = await this.poolState();
    const tasks: any[] = await (this as any).listSchedules().catch(() => []);
    const next = tasks.filter((t) => t.name === "scoutTick").map((t) => t.dueAt ?? t.due ?? t.at ?? t.nextAt).filter(Boolean).sort()[0];
    const order: Record<string, number> = { candidate: 0, reserved: 1, sent: 2, expired: 3 };
    const sorted = [...entries].sort((a, b) => order[a.state]! - order[b.state]! || b.score - a.score);
    const s = scoutSettings(profile);
    return {
      digest: id,
      scout: s ?? null,
      nextPassAt: next ? new Date(typeof next === "number" ? next : Date.parse(next)).toISOString() : null,
      enabledAt: meta.enabledAt ?? null,
      lastPassAt: meta.lastPassAt ?? null,
      lastPass: meta.lastPass ?? null,
      passes: meta.passes ?? 0,
      passRunning: meta.passRunning ?? null,
      lastIssueAt: meta.lastIssueAt ?? null,
      lastIssue: meta.lastIssue ?? null,
      issueRunning: meta.issueRunning ?? null,
      lastDecision: meta.lastDecision ?? null,
      counts: {
        candidates: entries.filter((e) => e.state === "candidate").length,
        strong: s ? entries.filter((e) => e.state === "candidate" && e.score >= s.strong).length : 0,
        reserved: entries.filter((e) => e.state === "reserved").length,
        sent: entries.filter((e) => e.state === "sent").length,
        expired: entries.filter((e) => e.state === "expired").length,
      },
      entries: sorted.slice(0, 100),
    };
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
      // A scout pass: hand its candidates to the pool; never emailed.
      if (state?.scoutRun) return await this.deliverScoutReply(reply, state.scoutRun);
      const digest = digestFromReply(reply);
      if (!digest) return; // not a digest (an answer, an error, a question): nothing to email
      const { subject, markdown } = digest;
      const profileId = profileIdOf(conversation) ?? LEGACY_PROFILE;
      const profile = profileId === GENERAL_ID ? await this.generalRun() : await loadProfile(this.agentEnv, profileId);
      console.log(JSON.stringify({ digestEmail: "sending", runId, digest: profileId, definition: profile ? (profileId === GENERAL_ID ? "general" : "stored") : "defaults" }));
      const result = await sendDigestEmail(this.agentEnv, { subject, markdown, profileId, profile });
      if (result.ok) await this.markEmailed();
      // An issue written from the pool: tell the pool which stories went out.
      if (result.ok && state?.issueRun) {
        const urls = [...markdown.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((m) => m[1]!);
        await poolActor(this.agentEnv, profileId).markSent({ slot: state.issueRun.slot, urls }).catch((err: unknown) => console.log(JSON.stringify({ pool: "markSent failed", error: String(err) })));
      }
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

  /** Every stored digest: id, title, window, items, scouting settings, when it changed. */
  async listDigests() {
    const state: any = await (this as any).getState();
    return Object.values(state?.profiles ?? {})
      .filter(Boolean)
      .map((d: any) => {
        let p: DigestProfile | undefined;
        try {
          p = parseProfile(d.id, d.markdown);
        } catch {}
        return { id: d.id, title: p?.title ?? null, windowDays: p?.windowDays ?? null, items: p?.items ?? null, scout: p?.scout ?? null, updatedAt: d.updatedAt, versions: (d.history?.length ?? 0) + 1 };
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

  /**
   * Send an email right after the caller's request returns (the page doesn't
   * wait for the email API): stored with an immediate scheduled call. Returns
   * false when it couldn't be scheduled, so the caller sends it itself.
   * Called in-process by the router; not @rpc.
   */
  async queueEmail(mail: { to: string; subject: string; text: string; html: string }) {
    try {
      await (this as any).schedule(0, "sendQueuedEmail", mail);
      return true;
    } catch (err) {
      console.log(JSON.stringify({ email: "schedule failed", error: err instanceof Error ? err.message : String(err) }));
      return false;
    }
  }

  /** Scheduled by queueEmail. */
  async sendQueuedEmail(mail: { to: string; subject: string; text: string; html: string }) {
    const started = Date.now();
    const from = await secret(this.agentEnv, SECRET.emailFrom);
    try {
      await (this.agentEnv.TELNYX as any).post("/emails", { body: { from, to: [mail.to], subject: mail.subject, text_body: mail.text, html_body: mail.html } });
      console.log(JSON.stringify({ email: "sent", subject: mail.subject, ms: Date.now() - started }));
    } catch (err) {
      console.log(JSON.stringify({ email: "failed", subject: mail.subject, error: err instanceof Error ? err.message : String(err) }));
    }
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

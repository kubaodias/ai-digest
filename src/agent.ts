import { ManagedAgent, type ManagedAgentSpec, type ManagedEnv } from "@telnyx/acp/managed";
import { tool } from "ai";
import { z } from "zod";
import type { AiDigestState, CheckRun, Patch } from "./actor-state.ts";
import { DIGESTS_CONVERSATION, FEEDBACK_CONVERSATION, feedbackActor, loadProfile, poolActor, type ActorContext } from "./actors.ts";
import { THUMB_DOWN_PNG_BASE64, THUMB_UP_PNG_BASE64 } from "./assets.ts";
import { claimsFor, mayUseFrontDoor } from "./auth.ts";
import { SECRET, secret } from "./config.ts";
import { sendDigestEmail } from "./delivery.ts";
import { digestFromReply } from "./digest.ts";
import { DigestsActor } from "./digests-actor.ts";
import { FeedbackActor } from "./feedback-actor.ts";
import { tagItems } from "./feedback.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { memorySummaryWait } from "./memory.ts";
import { capPerEntity, parseCheckReply, type Candidate, type Sighting } from "./pool.ts";
import { PoolActor } from "./pool-actor.ts";
import { GENERAL_ID, LEGACY_PROFILE, generalProfile, profileIdOf, type DigestProfile } from "./profile.ts";
import { telnyxOf } from "./telnyx.ts";
import { spendTool, toolBudget } from "./watch-instructions.ts";

// ai-digest: a research agent on Telnyx Edge Compute that writes email digests
// on any topic, defined per digest (profile.ts), emails them, and learns from
// thumbs feedback, separately for each digest. Each conversation is one durable
// instance of this class: "<digest>--<run>" for runs (the built-in General
// digest's runs are "__general--<run>" and keep their topic in state), plus two
// service actors, "feedback" (votes, sent issues) and "digests" (the definitions).
// A digest with `watch:` also has a pool actor, "<digest>--pool", which runs
// checks ("<digest>--check-<slot>") and writes issues from its pool
// ("<digest>--issue-<slot>"); see pool.ts and docs/spec/0010-watching.md.
// This file has the runs' side (the post-run hook that emails a digest or hands
// a check's candidates to its pool, web tool budgets, the front door); the
// pool, `feedback` and `digests` roles live in pool-actor.ts, feedback-actor.ts
// and digests-actor.ts, and the class delegates to them by method name, which
// is how the runtime and other actors call them.
// Account-specific settings are Telnyx secrets: see config.ts.

const spec: ManagedAgentSpec = {
  name: "ai-digest",
  model: "deepseek-ai/DeepSeek-V4.1-Flash",
  instructions: INSTRUCTIONS,
  tools: [{ type: "web_search", freshness: "month" }],
  limits: { steps: 30 },
  // No `memory`: the agent keeps nothing between conversations.
} as ManagedAgentSpec;

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
        const profile = profileIdOf(holder.actor?.conversation) ?? LEGACY_PROFILE;
        const topic = profile === GENERAL_ID ? (await holder.actor?.generalRun())?.topic : undefined;
        const out: Record<string, unknown> = { digest: profile, ...(topic ? { topic } : {}) };
        try {
          out.feedback = await feedbackActor(env).feedbackStats(profile);
          out.shared = await feedbackActor(env).sharedPreferences(profile, topic);
        } catch (err) {
          out.feedbackError = err instanceof Error ? err.message : String(err);
        }
        out.memorySummary = await memorySummaryWait(telnyxOf(env), profile).catch(() => null);
        console.log(JSON.stringify({ toolCall: "reader_preferences", digest: profile, votes: (out.feedback as any)?.votes ?? 0, shared: (out.shared as any)?.entities?.length ?? 0, memory: out.memorySummary ? "yes" : "none" }));
        return out;
      },
    }),
  };
}

// rememberRun (below) extends ManagedAgent's post-run hook, which @telnyx/acp's types mark private
// (as is conversationName, read through `conversation`). Overriding it is deliberate.
// @ts-expect-error TS2415: overrides the private rememberRun.
export class AiDigest extends ManagedAgent {
  private readonly agentEnv: ManagedEnv;

  /** This actor's own state (actor-state.ts), beside ManagedAgent's keys. */
  private async store(): Promise<AiDigestState> {
    return ((await this.getState()) ?? {}) as AiDigestState;
  }

  /** Merge a patch into this actor's state: objects merge key by key, null deletes a key. */
  private async save(patch: Patch<AiDigestState>): Promise<void> {
    await this.setState(patch as Record<string, unknown>);
  }

  /**
   * What the roles (pool, feedback, digests) use of this actor; built on first use. (Not `ctx`:
   * that is the runtime's own actor context on the base class.)
   */
  private roleContextCache?: ActorContext;
  private get roleContext(): ActorContext {
    const self = this;
    return (this.roleContextCache ??= {
      env: this.agentEnv,
      get conversation() {
        return self.conversation;
      },
      store: () => this.store(),
      save: (patch) => this.save(patch),
      schedule: (delaySeconds, method, payload, opts) => this.schedule(delaySeconds, method, payload, opts),
      listSchedules: () => this.listSchedules(),
      cancelSchedule: (id) => this.cancelSchedule(id),
    });
  }

  // One per instance, made on first use: each conversation plays one role (a pool, `feedback` or `digests`).
  private poolRole?: PoolActor;
  private feedbackRole?: FeedbackActor;
  private digestsRole?: DigestsActor;
  private get pool(): PoolActor {
    return (this.poolRole ??= new PoolActor(this.roleContext));
  }
  private get feedback(): FeedbackActor {
    return (this.feedbackRole ??= new FeedbackActor(this.roleContext));
  }
  private get digests(): DigestsActor {
    return (this.digestsRole ??= new DigestsActor(this.roleContext));
  }

  /**
   * This actor's conversation name (ManagedAgent's conversationName(), private in its types);
   * undefined when the actor's id doesn't decode to one.
   */
  get conversation(): string | undefined {
    return (this as unknown as { conversationName(): string | undefined }).conversationName();
  }

  constructor(ctx: ConstructorParameters<typeof ManagedAgent>[0], env: ManagedEnv) {
    const holder: ActorHolder = {};
    super(ctx, env, spec, { tools: emailTools(env, holder) });
    holder.actor = this;
    this.agentEnv = env;
  }

  /** Web tool calls per run, counted for budgeted runs (checks, issues). */
  private toolUse = { run: "", search: 0, fetch: 0 };

  /**
   * Checks and issues get a hard web tool budget (the prompt alone was
   * overrun): the built-in web_search/fetch_page reach the platform through
   * this env's TELNYX client, so a call over budget throws here and the tool
   * returns the reason to the model as its error.
   */
  protected override toolEnv(): ReturnType<ManagedAgent["toolEnv"]> {
    const base = super.toolEnv();
    // A conversation without a name is neither a check nor an issue: no budget (toolBudget needs a string).
    const budget = toolBudget(this.conversation ?? "");
    const telnyx = base.TELNYX;
    if (!budget || !telnyx) return base;
    return {
      ...base,
      TELNYX: {
        post: <T>(path: string, opts?: { body?: unknown; query?: Record<string, unknown> }) => {
          const run = String((this as unknown as { activeRunId?: string }).activeRunId ?? "");
          if (this.toolUse.run !== run) this.toolUse = { run, search: 0, fetch: 0 };
          const refused = spendTool(budget, this.toolUse, path);
          if (refused) {
            console.log(JSON.stringify({ toolBudget: "refused", conversation: this.conversation, path, used: this.toolUse }));
            return Promise.reject(new Error(refused)) as PromiseLike<T>;
          }
          return telnyx.post<T>(path, opts);
        },
        ...(telnyx.get ? { get: telnyx.get.bind(telnyx) } : {}),
        ...(telnyx.delete ? { delete: telnyx.delete.bind(telnyx) } : {}),
      },
    };
  }

  /**
   * Defence in depth: the v1 router never hands requests to an actor's own
   * front door (state streams, RPC) except the signed feedback pages, but if
   * one arrives it needs the operator token (see auth.ts).
   */
  override async authorize(token?: string, _req?: Request): Promise<any> {
    const claims = await claimsFor(token, await secret(this.agentEnv, SECRET.authKey));
    if (!claims.length) console.log(JSON.stringify({ auth: "refused", conversation: this.conversation ?? null, token: token ? "wrong" : "none" }));
    return claims;
  }

  /**
   * A General run's settings, stored in this run's own conversation before
   * the request is sent (the router calls it in-process; not @rpc). Each run
   * has its own conversation, so concurrent asks never share it.
   */
  async prepareGeneralRun(run: { topic: string; window?: string; items?: string }) {
    const p = generalProfile(run.topic, run); // validates again
    await this.save({ general: { topic: p.topic, window: `${p.windowDays}d`, items: `${p.items.min}-${p.items.max}` } });
    return { topic: p.topic };
  }

  /** This conversation's General digest definition, or undefined (not a General run, or no topic stored). */
  async generalRun(): Promise<DigestProfile | undefined> {
    const g = (await this.store()).general;
    if (!g?.topic) return undefined;
    try {
      return generalProfile(g.topic, g);
    } catch {
      return undefined;
    }
  }

  // ── watching: the run side (checks and issues) ──

  /** A check's window, stored in its conversation before the request (called in-process by the pool actor). */
  async prepareCheckRun(run: CheckRun) {
    await this.save({ checkRun: run });
  }

  /** An issue run's slot and stories, stored before the request (called in-process by the pool actor). */
  async prepareIssueRun(run: { slot: string; ids: string[] }) {
    await this.save({ issueRun: run });
  }

  /** A check finished: validate and tag its candidates and hand them to the pool. */
  private async deliverCheckReply(reply: string, run: CheckRun) {
    const { candidates, dropped, seen } = parseCheckReply(reply, run);
    const tags = await tagItems(telnyxOf(this.agentEnv), candidates.map((c) => ({ headline: c.headline, why: c.summary || c.why })));
    // Variety: at most two candidates about the same product per check.
    const { kept: tagged, capped } = capPerEntity<Candidate>(candidates.map((c, k) => ({ ...c, tags: tags[k]?.tags ?? [], entities: tags[k]?.entities ?? [] })));
    console.log(JSON.stringify({ watch: "check done", digest: run.digest, slot: run.slot, candidates: tagged.length, seen: seen.length, dropped, capped }));
    // Delivered by a durable task: retried with backoff until the pool takes it (a hung or failed call can't lose a check).
    await this.schedule(0, "deliverToPool", { digest: run.digest, slot: run.slot, candidates: tagged, seen, dropped: dropped + capped }, { id: "deliver", maxRetries: 8 });
  }

  /**
   * Called by the pool for a check that never delivered (e.g. the runtime
   * restarted before the post-run hook ran): deliver this conversation's
   * last reply again. Returns whether there was a reply to deliver.
   */
  async recoverCheck() {
    const state = await this.store();
    if (!state?.checkRun) return { delivered: false, reason: "not a check" };
    const msgs = (await this.messages.all()) as { role: string; content: string }[];
    const reply = [...msgs].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content;
    if (!reply) return { delivered: false, reason: "no reply" };
    await this.deliverCheckReply(reply, state.checkRun);
    return { delivered: true };
  }

  /** Scheduled by deliverCheckReply; throws on failure so the task is retried. addCandidates ignores a repeat. */
  async deliverToPool(p: { digest: string; slot: string; candidates: Candidate[]; seen?: Sighting[]; dropped: number }) {
    await poolActor(this.agentEnv, p.digest).addCandidates({ slot: p.slot, candidates: p.candidates, seen: p.seen ?? [], dropped: p.dropped });
    console.log(JSON.stringify({ watch: "delivered", digest: p.digest, slot: p.slot }));
  }

  /** A digest was emailed from this conversation now (guards against a second send for the same run). */
  async markEmailed() {
    await this.save({ emailedAt: Date.now() });
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
    const conversation = this.conversation;
    if (conversation === FEEDBACK_CONVERSATION || conversation === DIGESTS_CONVERSATION) return;
    try {
      const started = Number(runId.match(/-(\d{13})-/)?.[1] ?? 0);
      const state = await this.store();
      if (started && (state?.emailedAt ?? 0) >= started) return;
      const msgs = ((await this.messages.all()) as { seq: number; role: string; content: string }[]).filter((m) => m.seq > before);
      const reply = [...msgs].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content ?? "";
      // A check: hand its candidates to the pool; never emailed.
      if (state?.checkRun) return await this.deliverCheckReply(reply, state.checkRun);
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
      console.log(JSON.stringify({ digestEmail: result.ok ? "sent" : "failed", runId, ...(result.ok ? { id: result.id } : { error: result.error }) }));
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
    if (req.method === "GET" && this.conversation === FEEDBACK_CONVERSATION) {
      const url = new URL(req.url);
      const asset = url.searchParams.get("asset");
      if (asset === "thumb-up.png" || asset === "thumb-down.png") {
        const bytes = Uint8Array.from(atob(asset === "thumb-up.png" ? THUMB_UP_PNG_BASE64 : THUMB_DOWN_PNG_BASE64), (c) => c.charCodeAt(0));
        return Promise.resolve(new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "public, max-age=2592000" } }));
      }
      if (url.searchParams.has("view")) return this.feedback.onView(url);
      if (url.searchParams.has("p")) return this.feedback.onFeedback(url);
    }
    if (!(await mayUseFrontDoor(req, await secret(this.agentEnv, SECRET.authKey)))) {
      console.log(JSON.stringify({ auth: "refused", conversation: this.conversation ?? null, path: new URL(req.url).pathname }));
      return new Response(JSON.stringify({ error: "unauthorized", message: "this agent needs the operator token (telnyx-acp sends it)" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    return super.fetch(req);
  }

  // ── a watching digest's pool actor, "<digest>--pool" (pool-actor.ts); the timer's and
  //    the scheduled tasks' methods are called by name ──

  poolConfigure(...a: Parameters<PoolActor["poolConfigure"]>) {
    return this.pool.poolConfigure(...a);
  }
  poolDelete(...a: Parameters<PoolActor["poolDelete"]>) {
    return this.pool.poolDelete(...a);
  }
  watchTick(...a: Parameters<PoolActor["watchTick"]>) {
    return this.pool.watchTick(...a);
  }
  startCheck(...a: Parameters<PoolActor["startCheck"]>) {
    return this.pool.startCheck(...a);
  }
  runCheck(...a: Parameters<PoolActor["runCheck"]>) {
    return this.pool.runCheck(...a);
  }
  addCandidates(...a: Parameters<PoolActor["addCandidates"]>) {
    return this.pool.addCandidates(...a);
  }
  writeNow(...a: Parameters<PoolActor["writeNow"]>) {
    return this.pool.writeNow(...a);
  }
  runWriteNow(...a: Parameters<PoolActor["runWriteNow"]>) {
    return this.pool.runWriteNow(...a);
  }
  markSent(...a: Parameters<PoolActor["markSent"]>) {
    return this.pool.markSent(...a);
  }
  poolView(...a: Parameters<PoolActor["poolView"]>) {
    return this.pool.poolView(...a);
  }

  // ── the `feedback` actor (feedback-actor.ts): called in-process by the router and other
  //    actors (not @rpc); forgetMemorySourceLater is a scheduled task ──

  forgetMemorySourceLater(...a: Parameters<FeedbackActor["forgetMemorySourceLater"]>) {
    return this.feedback.forgetMemorySourceLater(...a);
  }
  registerDigest(...a: Parameters<FeedbackActor["registerDigest"]>) {
    return this.feedback.registerDigest(...a);
  }
  issueRecord(...a: Parameters<FeedbackActor["issueRecord"]>) {
    return this.feedback.issueRecord(...a);
  }
  keepIssueUntil(...a: Parameters<FeedbackActor["keepIssueUntil"]>) {
    return this.feedback.keepIssueUntil(...a);
  }
  setIssueHtml(...a: Parameters<FeedbackActor["setIssueHtml"]>) {
    return this.feedback.setIssueHtml(...a);
  }
  spendTalkTool(...a: Parameters<FeedbackActor["spendTalkTool"]>) {
    return this.feedback.spendTalkTool(...a);
  }
  talkVote(...a: Parameters<FeedbackActor["talkVote"]>) {
    return this.feedback.talkVote(...a);
  }
  issueVotes(...a: Parameters<FeedbackActor["issueVotes"]>) {
    return this.feedback.issueVotes(...a);
  }
  appOverview(...a: Parameters<FeedbackActor["appOverview"]>) {
    return this.feedback.appOverview(...a);
  }
  feedbackStats(...a: Parameters<FeedbackActor["feedbackStats"]>) {
    return this.feedback.feedbackStats(...a);
  }
  sharedPreferences(...a: Parameters<FeedbackActor["sharedPreferences"]>) {
    return this.feedback.sharedPreferences(...a);
  }

  // ── the `digests` actor (digests-actor.ts): called in-process by the router and pool
  //    actors (not @rpc); sendQueuedEmail is a scheduled task ──

  listDigests(...a: Parameters<DigestsActor["listDigests"]>) {
    return this.digests.listDigests(...a);
  }
  getDigest(...a: Parameters<DigestsActor["getDigest"]>) {
    return this.digests.getDigest(...a);
  }
  putDigest(...a: Parameters<DigestsActor["putDigest"]>) {
    return this.digests.putDigest(...a);
  }
  queueEmail(...a: Parameters<DigestsActor["queueEmail"]>) {
    return this.digests.queueEmail(...a);
  }
  sendQueuedEmail(...a: Parameters<DigestsActor["sendQueuedEmail"]>) {
    return this.digests.sendQueuedEmail(...a);
  }
  claimRun(...a: Parameters<DigestsActor["claimRun"]>) {
    return this.digests.claimRun(...a);
  }
  releaseRun(...a: Parameters<DigestsActor["releaseRun"]>) {
    return this.digests.releaseRun(...a);
  }
  magicRequested(...a: Parameters<DigestsActor["magicRequested"]>) {
    return this.digests.magicRequested(...a);
  }
  consumeMagic(...a: Parameters<DigestsActor["consumeMagic"]>) {
    return this.digests.consumeMagic(...a);
  }
  deleteDigest(...a: Parameters<DigestsActor["deleteDigest"]>) {
    return this.digests.deleteDigest(...a);
  }
}

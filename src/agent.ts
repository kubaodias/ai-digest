import { ManagedAgent, type ManagedAgentSpec, type ManagedEnv } from "@telnyx/acp/managed";
import type { AiDigestState, CheckRun, Patch, PoolMeta } from "./actor-state.ts";
import { tool } from "ai";
import { z } from "zod";
import { INSTRUCTIONS } from "./instructions.ts";
import { THUMB_DOWN_PNG_BASE64, THUMB_UP_PNG_BASE64 } from "./assets.ts";
import { DOWN_REASONS, ENTITY_OPTIONS, UP_REASONS, selectionsOf, sharedEntityPrefs, validEntityIndex, validReason } from "./preferences.ts";
import { digestFromReply } from "./digest.ts";
import { DIGESTS_CONVERSATION, FEEDBACK_CONVERSATION, actorNamed, digestsActor, feedbackActor, poolActor, poolConversation } from "./actors.ts";
import { sendDigestEmail } from "./delivery.ts";
import { sendEmail } from "./email.ts";
import { SECRET, feedbackKey, secret } from "./config.ts";
import { GENERAL_ID, LEGACY_PROFILE, generalProfile, parseProfile, profileIdOf, type DigestProfile } from "./profile.ts";
import { claimsFor, mayUseFrontDoor } from "./auth.ts";
import {
  canonicalUrl, capPerEntity, claimLease, decide, housekeep, leaseWaitS, mergeCandidates, parseCheckReply, releasesLease, rescore, watchSettings, slotOf,
  type Candidate, type Decision, type PoolEntry, type Sighting,
} from "./pool.ts";
import { quietNote, checkMessage, spendTool, toolBudget, writerMessage } from "./watch-instructions.ts";
import { TALK_TTL_S, countTalkTool, type TalkTool, type TalkUsage } from "./talk.ts";
import {
  MEMORY_NAMESPACE, errorPage, feedbackLink, forgetVote, rememberVote,
  nextVote, preferencesFrom, retainIssues, tagItems, TALK_UNTIL_SLACK_MS, thanksPage, undonePage, verifyPayload, verifyView, viewLink, type DigestItemRecord, type DigestRecord, type StoredVote,
} from "./feedback.ts";

// ai-digest: a research agent on Telnyx Edge Compute that writes email digests
// on any topic, defined per digest (profile.ts), emails them, and learns from
// thumbs feedback, separately for each digest. Each conversation is one durable
// instance of this class: "<digest>--<run>" for runs (the built-in General
// digest's runs are "__general--<run>" and keep their topic in state), plus two
// service actors, "feedback" (votes, sent issues) and "digests" (the definitions).
// A digest with `watch:` also has a pool actor, "<digest>--pool", which runs
// checks ("<digest>--check-<slot>") and writes issues from its pool
// ("<digest>--issue-<slot>"); see pool.ts and docs/spec/0010-watching.md.
// Account-specific settings are Telnyx secrets: see config.ts.

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

/**
 * "I don't use X" needs to know X: fill in entities for a vote on an item tagged before entities existed
 * (the main one is meant). Used by the email's thumbs and the talk page alike.
 */
async function backfillEntities(telnyx: any, vote: StoredVote, item: { why?: string } | undefined): Promise<void> {
  const untargeted = vote.reasons?.find((x) => x.r === "entity" && !x.target);
  if (!untargeted || vote.entities?.length) return;
  vote.entities = (await tagItems(telnyx, [{ headline: vote.headline, why: item?.why ?? "" }]))[0]?.entities ?? [];
  if (vote.entities[0]) untargeted.target = vote.entities[0];
}

const DAY_MS = 24 * 3600 * 1000;
/** A check still counts as running for this long (then a new one may start). */
const CHECK_TIMEOUT_MS = 30 * 60 * 1000;
/** After this long, a check that hasn't delivered is stale: its reply is re-delivered, or the check is given up. */
const CHECK_STALE_MS = 5 * 60 * 1000;
/**
 * Timers are spread out so checks of different digests rarely run at the same
 * time (the runtime has crashed under several parallel checks): the first check
 * starts 1–16 minutes after watching is turned on, and every next one is due
 * one interval later, give or take up to 10 minutes.
 */
const firstCheckDelayS = () => 60 + Math.floor(Math.random() * 15 * 60);
const nextCheckDelayS = (hours: number) => Math.max(600, hours * 3600 + Math.floor((Math.random() * 2 - 1) * 600));

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
        const profile = profileIdOf(holder.actor?.conversation) ?? LEGACY_PROFILE;
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
    const tags = await tagItems(this.agentEnv.TELNYX as any, candidates.map((c) => ({ headline: c.headline, why: c.summary || c.why })));
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

  // ── watching: the pool actor, "<digest>--pool" ──

  private poolDigest(): string {
    const id = profileIdOf(this.conversation);
    if (!id || this.conversation !== poolConversation(id)) throw new Error("not a pool actor");
    return id;
  }

  private async poolState(): Promise<{ entries: PoolEntry[]; meta: PoolMeta }> {
    const state = await this.store();
    return { entries: Object.values(state?.poolEntries ?? {}).filter(Boolean) as PoolEntry[], meta: state?.poolMeta ?? {} };
  }

  /** Store the pool (only what changed) and merge `meta` into poolMeta. */
  private async savePool(before: PoolEntry[], after: PoolEntry[], meta: Record<string, unknown>) {
    const old = new Map(before.map((e) => [e.id, JSON.stringify(e)]));
    const patch: Record<string, PoolEntry | null> = {};
    for (const e of after) if (old.get(e.id) !== JSON.stringify(e)) patch[e.id] = e;
    for (const id of old.keys()) if (!after.some((e) => e.id === id)) patch[id] = null;
    await this.save({ poolEntries: patch, poolMeta: meta });
  }

  /**
   * Arm or cancel this digest's watch timer from its definition: called when a
   * definition is stored or deleted, and by every deploy (which pushes every
   * definition), so a lost timer comes back. The first check runs 1–16 minutes
   * after watching is turned on (firstCheckDelayS).
   */
  async poolConfigure() {
    const id = this.poolDigest();
    const s = watchSettings(await loadProfile(this.agentEnv, id));
    const { meta } = await this.poolState();
    if (!s) {
      await this.cancelSchedule("watch").catch(() => false);
      if (meta.enabledAt) await this.save({ poolMeta: { enabledAt: null, watchHours: null } });
      return { digest: id, watching: false };
    }
    // An armed timer with the same interval is left alone, so deploys (which store every
    // definition again) don't line all digests' checks up; a missing one is re-armed.
    const tasks = await this.listSchedules().catch(() => []);
    const armed = tasks.find((t) => t.id === "watch");
    if (armed && !armed.everyMs && meta.watchHours === s.watchHours) return { digest: id, watching: true, everyHours: s.watchHours, kept: true };
    const now = new Date().toISOString();
    await this.save({ poolMeta: { watchHours: s.watchHours, ...(meta.enabledAt ? {} : { enabledAt: now, lastIssueAt: meta.lastIssueAt ?? now }) } });
    const delay = firstCheckDelayS();
    await this.schedule(delay, "watchTick", {}, { id: "watch" });
    return { digest: id, watching: true, everyHours: s.watchHours, firstCheckInMin: Math.round(delay / 60) };
  }

  /** The digest was deleted: stop its timer and forget its pool (a new digest with the same name starts empty). */
  async poolDelete() {
    const id = this.poolDigest();
    const tasks = await this.listSchedules().catch(() => []);
    for (const t of [...tasks.map((t) => t.id), "watch"]) await this.cancelSchedule(t).catch(() => false);
    const { entries } = await this.poolState();
    await this.save({ poolEntries: null, poolMeta: null });
    console.log(JSON.stringify({ pool: "deleted", digest: id, entries: entries.length }));
    return { digest: id, watching: false, cleared: entries.length };
  }

  /** The timer's tick: one check (unless one is still running), then the next tick, an interval later. */
  async watchTick() {
    await this.startCheck({}).catch((err: unknown) => console.log(JSON.stringify({ watch: "tick failed", error: err instanceof Error ? err.message : String(err) })));
    // The next tick; if the definition can't be read right now, the last known interval keeps the chain going.
    let hours: number | undefined;
    try {
      hours = watchSettings(await digestsActor(this.agentEnv).getDigest(this.poolDigest()).then((d) => (d ? parseProfile(d.id, d.markdown) : undefined)))?.watchHours;
    } catch {
      hours = (await this.poolState()).meta.watchHours ?? undefined;
    }
    if (hours) await this.schedule(nextCheckDelayS(hours), "watchTick", {}, { id: "watch" });
  }

  /**
   * Start a check now (called in-process by the router, and by the timer).
   * `since`/`until` set the window (e.g. to replay past days); `decide: false`
   * only fills the pool; `force` writes an issue after the check whatever the
   * thresholds say (a manual run), with an optional focus.
   */
  async startCheck(opts: { since?: string; until?: string; decide?: boolean; force?: { focus?: string } }) {
    const id = this.poolDigest();
    const profile = await loadProfile(this.agentEnv, id);
    if (!watchSettings(profile)) return { ok: false, error: `"${id}" doesn't watch: add "watch: 6h" to its definition` };
    const { entries, meta } = await this.poolState();
    const now = new Date();
    if (meta.checkRunning) {
      const age = now.getTime() - Date.parse(meta.checkRunning.startedAt);
      const running = `${id}--check-${meta.checkRunning.slot}`;
      if (age < CHECK_STALE_MS) {
        console.log(JSON.stringify({ watch: "skipped", digest: id, reason: "a check is running", running: meta.checkRunning.slot }));
        return { ok: false, error: "a check is already running", conversation: running };
      }
      // A check that should have delivered by now: wait while its run is still going,
      // else re-deliver its reply (e.g. the runtime restarted before its post-run hook), else give it up.
      if (age < CHECK_TIMEOUT_MS) {
        if (await this.checkStillRunning(running)) return { ok: false, error: "a check is still running", conversation: running };
        const r = await actorNamed(this.agentEnv, running).recoverCheck().catch(() => ({ delivered: false, reason: "unreachable" }));
        if (r.delivered) {
          console.log(JSON.stringify({ watch: "recovered", digest: id, conversation: running }));
          return { ok: false, error: "the previous check's reply was delivered again; start a new check in a minute", conversation: running };
        }
      }
      console.log(JSON.stringify({ watch: "gave up", digest: id, conversation: running, ageMin: Math.round(age / 60000) }));
    }
    const until = opts.until ?? now.toISOString();
    const since = opts.since ?? (meta.lastCheckAt ? new Date(Date.parse(meta.lastCheckAt) - 3600_000).toISOString() : new Date(Date.parse(until) - profile!.windowDays * DAY_MS).toISOString());
    const slot = now.toISOString().slice(0, 19).replace(/[:]/g, "").toLowerCase();
    const conversation = `${id}--check-${slot}`;
    const known = entries
      .filter((e) => e.state !== "expired")
      .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
      .map((e) => ({ id: e.id, headline: e.headline }));
    await this.save({ poolMeta: { checkRunning: { slot, startedAt: now.toISOString(), since, until, decide: opts.decide ?? true, force: opts.force ?? null } } });
    // The run starts on an immediate task, so the caller (an API request) doesn't wait for actor start-ups.
    await this.schedule(0, "runCheck", { slot, since, until, known }, { id: `check-${slot}` });
    return { ok: true, conversation, since, until };
  }

  /** Whether a check's conversation still has a run in progress (its latest trace). */
  private async checkStillRunning(conversation: string): Promise<boolean> {
    const t = await actorNamed(this.agentEnv, conversation).traces(1).catch(() => undefined);
    const status = t?.runs?.[0]?.status;
    return status === "running" || status === "accepted" || status === "queued";
  }

  /** Scheduled by startCheck: hand the request to the check's own conversation. */
  async runCheck(p: { slot: string; since: string; until: string; known: { id: string; headline: string }[] }) {
    const id = this.poolDigest();
    const profile = await loadProfile(this.agentEnv, id);
    if (!profile) return;
    const conversation = `${id}--check-${p.slot}`;
    // One check or issue at a time across all digests (the runtime has crashed under parallel runs).
    const lease = await digestsActor(this.agentEnv).claimRun(conversation);
    if (!lease.ok) {
      const wait = leaseWaitS(lease.retryInS);
      // Still due, just waiting: keep the check from counting as stale meanwhile.
      await this.save({ poolMeta: { checkRunning: { startedAt: new Date().toISOString() } } });
      await this.schedule(wait, "runCheck", p, { id: `check-${p.slot}-wait-${Date.now()}` });
      console.log(JSON.stringify({ watch: "waiting", digest: id, slot: p.slot, holder: lease.holder, retryInS: wait }));
      return;
    }
    const run = actorNamed(this.agentEnv, conversation);
    await run.prepareCheckRun({ digest: id, slot: p.slot, since: p.since, until: p.until });
    await run.receive(checkMessage(profile, { since: p.since, until: p.until, known: p.known }));
    console.log(JSON.stringify({ watch: "check started", digest: id, conversation, since: p.since, until: p.until }));
  }

  /** A check's candidates (from its conversation's post-run hook): merge, score, decide. */
  async addCandidates(p: { slot: string; candidates: Candidate[]; seen?: Sighting[]; dropped: number }) {
    const id = this.poolDigest();
    const { entries, meta } = await this.poolState();
    if (meta.lastCheckSlot === p.slot) return { duplicate: true }; // at-least-once delivery
    const profile = await loadProfile(this.agentEnv, id);
    const run = meta.checkRunning?.slot === p.slot ? meta.checkRunning : undefined;
    const now = new Date().toISOString();
    const merged = mergeCandidates(entries, p.candidates, now, p.seen ?? []);
    const pool = await this.refreshed(id, merged.pool, profile, now);
    const check = { slot: p.slot, at: now, since: run?.since, until: run?.until, added: merged.added, merged: merged.merged, resighted: merged.resighted, dropped: p.dropped };
    const decision = profile && run?.decide !== false ? this.decision(pool, profile, meta, now, !!run?.force) : undefined;
    await this.savePool(entries, pool, {
      // A replayed check (an `until` in the past) never moves the clock back.
      lastCheckAt: [meta.lastCheckAt, run?.until ?? now].filter(Boolean).sort().pop(),
      lastCheckSlot: p.slot,
      checkRunning: null,
      lastCheck: check,
      checks: (meta.checks ?? 0) + 1,
      ...(decision ? { lastDecision: { ...decision, at: now } } : {}),
    });
    console.log(JSON.stringify({ pool: "merged", digest: id, ...check, live: pool.filter((e) => e.state === "candidate").length, decision: decision?.action ?? "skipped", reason: decision?.reason }));
    const checkOwner = `${id}--check-${p.slot}`;
    if (decision && decision.action !== "none" && profile) await this.startIssue(id, profile, pool, decision, meta, run?.force?.focus, checkOwner);
    // A no-op when the issue took the lease over.
    await digestsActor(this.agentEnv).releaseRun(checkOwner).catch(() => undefined);
    return { added: merged.added, merged: merged.merged, decision: decision?.action ?? "skipped" };
  }

  /** Write an issue from the pool now, without a check (a manual run with watching off for this run). Queued, so the caller doesn't wait. */
  async writeNow(opts: { focus?: string } = {}) {
    const id = this.poolDigest();
    await this.schedule(0, "runWriteNow", opts, { id: "write-now" });
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

  private decision(pool: PoolEntry[], profile: DigestProfile, meta: PoolMeta, now: string, force: boolean): Decision {
    const s = watchSettings(profile) ?? { watchHours: 24, sendAt: profile.items.min, strong: 7, minGapDays: 0, maxGapDays: 30 };
    return decide(pool, s, meta.lastIssueAt ?? meta.enabledAt ?? now, now, profile.items.max, force);
  }

  /** Reserve the chosen stories and start the writer run (or email the quiet note when there are none). */
  private async startIssue(id: string, profile: DigestProfile, pool: PoolEntry[], d: Decision, meta: PoolMeta, focus?: string, fromCheck?: string) {
    const now = new Date().toISOString();
    const ids = d.action === "none" ? [] : d.ids;
    if (ids.length) {
      // One check or issue at a time across all digests: take over the check's lease, or wait for another digest's run.
      const lease = await digestsActor(this.agentEnv).claimRun(`${id}--issue-${slotOf(now)}`, fromCheck);
      if (!lease.ok) {
        const wait = leaseWaitS(lease.retryInS);
        await this.schedule(wait, "runWriteNow", { focus }, { id: `write-wait-${Date.now()}` });
        console.log(JSON.stringify({ pool: "issue waiting", digest: id, holder: lease.holder, retryInS: wait }));
        return { conversation: null, stories: 0, waiting: true };
      }
    }
    if (!ids.length) {
      const note = quietNote(profile, meta.lastIssueAt ?? meta.enabledAt ?? now, now);
      const r = await sendDigestEmail(this.agentEnv, { ...note, profileId: id, profile });
      await this.save({ poolMeta: { lastIssueAt: now, lastIssue: { slot: slotOf(now), at: now, stories: 0, quiet: true } } });
      console.log(JSON.stringify({ pool: "quiet note", digest: id, ok: r.ok }));
      return { conversation: null, stories: 0 };
    }
    const slot = slotOf(now);
    const conversation = `${id}--issue-${slot}`;
    const chosen = ids.map((x) => pool.find((e) => e.id === x)!).filter(Boolean);
    const reserved = pool.map((e) => (ids.includes(e.id) ? { ...e, state: "reserved" as const, issue: slot, reservedAt: now } : e));
    await this.savePool(pool, reserved, { issueRunning: { slot, startedAt: now, stories: ids.length } });
    const run = actorNamed(this.agentEnv, conversation);
    await run.prepareIssueRun({ slot, ids });
    const s = watchSettings(profile);
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
    await digestsActor(this.agentEnv).releaseRun(`${this.poolDigest()}--issue-${p.slot}`).catch(() => undefined);
    return { sent };
  }

  /** The pool for the API and the page: settings, timing, the last decision and the entries (live first). */
  async poolView() {
    const id = this.poolDigest();
    const profile = await loadProfile(this.agentEnv, id);
    const { entries, meta } = await this.poolState();
    const tasks = await this.listSchedules().catch(() => []);
    const next = tasks.filter((t) => t.name === "watchTick").map((t) => t.due).filter(Boolean).sort((a, b) => a - b)[0];
    const order: Record<string, number> = { candidate: 0, reserved: 1, sent: 2, expired: 3 };
    const sorted = [...entries].sort((a, b) => order[a.state]! - order[b.state]! || b.score - a.score);
    const s = watchSettings(profile);
    return {
      digest: id,
      watch: s ?? null,
      nextCheckAt: next ? new Date(typeof next === "number" ? next : Date.parse(next)).toISOString() : null,
      enabledAt: meta.enabledAt ?? null,
      lastCheckAt: meta.lastCheckAt ?? null,
      lastCheck: meta.lastCheck ?? null,
      checks: meta.checks ?? 0,
      checkRunning: meta.checkRunning ?? null,
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
      if (url.searchParams.has("view")) return this.onView(url);
      if (url.searchParams.has("p")) return this.onFeedback(url);
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

  private async onView(url: URL): Promise<Response> {
    const key = await feedbackKey(this.agentEnv);
    const id = url.searchParams.get("view") ?? "";
    if (!key || !(await verifyView(key, id, url.searchParams.get("s") ?? ""))) return errorPage(400, "The link is invalid.");
    const state = await this.store();
    const digest: DigestRecord | undefined = state?.digests?.[id];
    if (!digest?.html) return errorPage(404, "That digest is no longer stored.");
    return new Response(digest.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  }

  private async onFeedback(url: URL): Promise<Response> {
    const key = await feedbackKey(this.agentEnv);
    if (!key) return errorPage(503, "Feedback isn't configured.");
    const p = await verifyPayload(key, url.searchParams.get("p") ?? "", url.searchParams.get("s") ?? "");
    if (!p) return errorPage(400, "The link is invalid or has expired.");
    const id = `${p.d}:${p.i}`;
    const state = await this.store();
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
        await this.removeVote(id, prior, profile, "email");
        return undonePage(item?.headline ?? prior?.headline ?? "", view);
      }
      const { vote, changed } = nextVote(prior, p, item, new Date().toISOString());
      await this.saveVote(id, vote, prior, { profile, digest, item }, changed, "email");
      const votes = (Object.values({ ...(state?.votes ?? {}), [id]: vote }).filter(Boolean) as StoredVote[]).filter((v) => (v.profile ?? LEGACY_PROFILE) === profile);
      const pay = { d: p.d, i: p.i, v: p.v, e: p.e };
      const flip = await feedbackLink(key, base, { ...pay, v: p.v === "up" ? "down" : "up" });
      const undo = await feedbackLink(key, base, pay, "&undo=1");
      const reasons: Record<string, string> = {};
      const ents = item?.entities?.length ? item.entities : (vote.entities ?? []);
      for (const r of p.v === "up" ? UP_REASONS : DOWN_REASONS) {
        if (r !== "entity") reasons[r] = await feedbackLink(key, base, { ...pay, r });
        else if (!ents.length) reasons.entity = await feedbackLink(key, base, { ...pay, r });
        else for (let k = 0; k < Math.min(ENTITY_OPTIONS, ents.length); k++) reasons[`entity:${k}`] = await feedbackLink(key, base, { ...pay, r, x: k });
      }
      return thanksPage({ base, vote, item, digest, prefs: preferencesFrom(votes), links: { undo, flip, view, reasons } });
    } catch (err) {
      console.log(JSON.stringify({ feedback: "failed", id, error: err instanceof Error ? err.message : String(err) }));
      return errorPage(500, "Something went wrong recording that. Try again in a minute.");
    }
  }

  /**
   * Save a vote, from the email's thumbs or the talk page alike: the digest (and General topic) it belongs to,
   * the entity for an untargeted "I don't use X", then, when it changed, its Agent Memory source (the previous
   * one is kept if that write fails) and the stored vote.
   */
  private async saveVote(id: string, vote: StoredVote, prior: StoredVote | undefined, ctx: { profile: string; digest?: DigestRecord; item?: DigestItemRecord }, write: boolean, via: string) {
    const telnyx = this.agentEnv.TELNYX as any;
    vote.profile ??= ctx.profile;
    if (ctx.digest?.topic) vote.topic ??= ctx.digest.topic;
    await backfillEntities(telnyx, vote, ctx.item);
    if (write) {
      vote.memorySource = await rememberVote(telnyx, ctx.profile, vote).catch((err: unknown) => {
        console.log(JSON.stringify({ feedback: "memory write failed", via, id, error: String(err) }));
        return prior?.memorySource;
      });
      await this.save({ votes: { [id]: vote } });
    }
    console.log(JSON.stringify({ feedback: "vote", via, id, vote: vote.vote, reasons: selectionsOf(vote), entities: vote.entities, tags: vote.tags, changed: write }));
  }

  /** Remove a vote (an undo, from the email or the talk page): its memory, the stored vote, and its memory again later. */
  private async removeVote(id: string, prior: StoredVote | undefined, profile: string, via: string) {
    if (prior) {
      await forgetVote(this.agentEnv.TELNYX as any, profile, prior.memorySource).catch((err: unknown) => console.log(JSON.stringify({ feedback: "memory delete failed", via, id, error: String(err) })));
      await this.save({ votes: { [id]: null } });
      // Ingestion is asynchronous: a memory still being extracted can land after this delete. Delete again later.
      if (prior.memorySource) await this.later(120, "forgetMemorySourceLater", { source: prior.memorySource, profile });
    }
    console.log(JSON.stringify({ feedback: "undo", via, id }));
  }

  /** Schedule one of the methods below; a failure to schedule is logged, never thrown at the reader. */
  private async later(seconds: number, method: string, payload: unknown, id?: string) {
    try {
      await this.schedule(seconds, method, payload, id ? { id } : undefined);
    } catch (err) {
      console.log(JSON.stringify({ feedback: "schedule failed", method, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Scheduled after an undo: delete the vote's memory source again, catching memories extracted after the first delete. */
  async forgetMemorySourceLater(p: { source: string; profile?: string }) {
    await forgetVote(this.agentEnv.TELNYX as any, p.profile ?? LEGACY_PROFILE, p.source).catch(() => undefined);
    console.log(JSON.stringify({ feedback: "memory deleted again", source: p.source }));
  }

  /**
   * Keep a sent digest. The newest KEEP_DIGESTS keep their email HTML; older ones stay (without it) while
   * their talk links are valid (TALK_TTL_S), so a link works for as long as it says, up to KEEP_ISSUES in all.
   * Called in-process when a digest is emailed; not @rpc, so not on the public mount.
   */
  async registerDigest(record: DigestRecord) {
    const state = await this.store();
    const older = (Object.values(state?.digests ?? {}).filter(Boolean) as DigestRecord[]).filter((d) => d.id !== record.id);
    const changes = retainIssues(older, Date.now(), TALK_TTL_S * 1000);
    await this.save({ digests: { ...changes, [record.id]: record } });
    return { stored: record.id, dropped: Object.values(changes).filter((c) => c === null).length };
  }

  /** A stored issue, for talking about it. Called in-process by the router; not @rpc. */
  async issueRecord(id: string): Promise<DigestRecord | undefined> {
    const state = await this.store();
    return state?.digests?.[id] ?? undefined;
  }

  /**
   * Keep an issue at least until `until` (ISO), when talk links minted for it expire. Written only when that
   * moves its deadline by more than TALK_UNTIL_SLACK_MS, so opening the page doesn't write every time;
   * retainIssues keeps issues that much past talkUntil, so every link minted stays covered. Called in-process; not @rpc.
   */
  async keepIssueUntil(id: string, until: string) {
    const state = await this.store();
    const d: DigestRecord | undefined = state?.digests?.[id];
    if (!d) return { ok: false };
    const now = Date.parse(until), was = Date.parse(d.talkUntil ?? "") || 0;
    if (now - was > TALK_UNTIL_SLACK_MS) await this.save({ digests: { [id]: { ...d, talkUntil: until } } });
    return { ok: true };
  }

  /** Replace a stored issue's email HTML (after adding talk links to it). Called in-process; not @rpc. */
  async setIssueHtml(id: string, html: string, talkUntil?: string) {
    const state = await this.store();
    const d: DigestRecord | undefined = state?.digests?.[id];
    if (!d) return { ok: false };
    await this.save({ digests: { [id]: { ...d, html, ...(talkUntil ? { talkUntil } : {}) } } });
    return { ok: true };
  }

  /** Today's paid talk-tool use, loaded once per instance and shared, so concurrent checks see each other. */
  private talkUse?: Promise<TalkUsage>;

  /**
   * Count one paid talk tool call (search_web, read_article) for an issue against the daily limits (TALK_LIMITS):
   * undefined when allowed, else the refusal for the assistant. Called in-process by the router; not @rpc.
   */
  async spendTalkTool(issue: string, tool: TalkTool): Promise<string | undefined> {
    this.talkUse ??= (async () => {
      const state = await this.store();
      return state.talkUse ?? { day: "", total: {}, issues: {} };
    })();
    const use = await this.talkUse;
    const before = use.day;
    // Checked and counted with no await in between: concurrent calls can't both take the last one.
    const refused = countTalkTool(use, issue, tool);
    if (refused) console.log(JSON.stringify({ talk: "tool limit", tool, issue, day: use.day }));
    else {
      // A new day starts from nothing: clear the stored counts first (setState merges objects).
      if (before && before !== use.day) await this.save({ talkUse: null });
      await this.save({ talkUse: structuredClone(use) });
    }
    return refused;
  }

  /**
   * A vote from the talk page: by voice (the assistant's record_vote) or a 👍/👎 or reason tapped
   * on the page. Recorded like a thumbs click on the item, into the same log and Agent Memory
   * profile. A reason (r, and x for "entity") toggles on the current vote; undo removes the vote.
   * Called in-process by the router; not @rpc.
   */
  async talkVote(p: { d: string; i: number; v: "up" | "down"; r?: string; x?: number; undo?: boolean; via?: string }) {
    const state = await this.store();
    const digest: DigestRecord | undefined = state?.digests?.[p.d];
    const item = digest?.items.find((i) => i.n === p.i);
    if (!digest || !item) return { ok: false, error: "no such story in this issue" };
    const id = `${p.d}:${p.i}`;
    const prior: StoredVote | undefined = state?.votes?.[id];
    const profile = digest.profile ?? prior?.profile ?? LEGACY_PROFILE;
    if (p.undo) {
      await this.removeVote(id, prior, profile, p.via ?? "talk");
      return { ok: true, story: p.i, vote: null, reasons: [] };
    }
    const reason = p.r && validReason(p.v, p.r) ? p.r : undefined;
    const x = reason === "entity" && validEntityIndex(p.x) ? p.x : undefined;
    // A reason applies to a vote of the same kind: cast the vote first when there isn't one.
    let base = prior;
    if (reason && (!prior || prior.vote !== p.v)) base = nextVote(prior, { d: p.d, i: p.i, v: p.v, e: 0 }, item, new Date().toISOString()).vote;
    const { vote, changed } = nextVote(base, { d: p.d, i: p.i, v: p.v, e: 0, ...(reason ? { r: reason } : {}), ...(x !== undefined ? { x } : {}) }, item, new Date().toISOString());
    // A vote cast here only to carry a reason is new even when the reason toggled nothing.
    await this.saveVote(id, vote, prior, { profile, digest, item }, changed || base !== prior, p.via ?? "talk");
    return { ok: true, story: p.i, vote: vote.vote, reasons: selectionsOf(vote), headline: item.headline };
  }

  /** The votes on one issue's stories, for the talk page: item number → vote and reasons. Called in-process; not @rpc. */
  async issueVotes(d: string) {
    const state = await this.store();
    const out: Record<number, { vote: string; reasons: { r: string; target?: string }[] }> = {};
    for (const v of Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[]) if (v.digest === d) out[v.item] = { vote: v.vote, reasons: selectionsOf(v) };
    return out;
  }

  /** For the page: sent issues (newest first) and votes per digest. Called in-process; not @rpc. */
  async appOverview() {
    const state = await this.store();
    const issues = (Object.values(state?.digests ?? {}).filter(Boolean) as DigestRecord[])
      .map((d) => ({ id: d.id, profile: d.profile ?? LEGACY_PROFILE, ...(d.topic ? { topic: d.topic } : {}), subject: d.subject, sentAt: d.sentAt, items: d.items.length }))
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    const votes: Record<string, number> = {};
    for (const v of Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[]) votes[v.profile ?? LEGACY_PROFILE] = (votes[v.profile ?? LEGACY_PROFILE] ?? 0) + 1;
    return { issues, votes };
  }

  /** One digest's preferences from the vote log, for `reader_preferences`. Called in-process; not @rpc. */
  async feedbackStats(profile: string = LEGACY_PROFILE) {
    const state = await this.store();
    const votes = (Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[]).filter((v) => (v.profile ?? LEGACY_PROFILE) === profile);
    return preferencesFrom(votes);
  }

  /**
   * What a digest takes from the reader's other digests (preferences.ts,
   * sharedEntityPrefs): explicit entity reasons only. `topic` is a General
   * run's topic, never hidden by a shared "I don't use". Called in-process; not @rpc.
   */
  async sharedPreferences(profile: string = LEGACY_PROFILE, topic?: string) {
    const state = await this.store();
    const all = Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[];
    const own = preferencesFrom(all.filter((v) => (v.profile ?? LEGACY_PROFILE) === profile)).entities.map((e) => e.name);
    return sharedEntityPrefs(all, { profile, own, topic, legacyProfile: LEGACY_PROFILE });
  }

  // ── the `digests` actor: digest definitions (called in-process by the router) ──

  /** Every stored digest: id, title, window, items, watching settings, when it changed. */
  async listDigests() {
    const state = await this.store();
    return Object.values(state?.profiles ?? {})
      .filter(Boolean)
      .map((d) => {
        let p: DigestProfile | undefined;
        try {
          p = parseProfile(d.id, d.markdown);
        } catch {}
        return { id: d.id, title: p?.title ?? null, windowDays: p?.windowDays ?? null, items: p?.items ?? null, watch: p?.watch ?? null, updatedAt: d.updatedAt, versions: (d.history?.length ?? 0) + 1 };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** One digest's definition (Markdown), or null. */
  async getDigest(id: string) {
    const state = await this.store();
    const d = state?.profiles?.[id];
    return d ? { id, markdown: d.markdown, updatedAt: d.updatedAt, versions: (d.history?.length ?? 0) + 1 } : null;
  }

  /** Store a digest's definition (validated by the router), keeping the previous versions. */
  async putDigest(id: string, markdown: string) {
    const state = await this.store();
    const prev = state?.profiles?.[id];
    if (prev && prev.markdown === markdown) return { id, changed: false, versions: (prev.history?.length ?? 0) + 1 };
    const history = prev ? [{ markdown: prev.markdown, updatedAt: prev.updatedAt }, ...(prev.history ?? [])].slice(0, KEEP_VERSIONS - 1) : [];
    await this.save({ profiles: { [id]: { id, markdown, updatedAt: new Date().toISOString(), history } } });
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
      await this.schedule(0, "sendQueuedEmail", mail);
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
      await sendEmail(this.agentEnv.TELNYX as any, { from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html });
      console.log(JSON.stringify({ email: "sent", subject: mail.subject, ms: Date.now() - started }));
    } catch (err) {
      console.log(JSON.stringify({ email: "failed", subject: mail.subject, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** The run lease (one check or issue at a time across digests; pool.ts). Called in-process by pool actors. */
  async claimRun(owner: string, from?: string) {
    const state = await this.store();
    const r = claimLease(state.runLease, owner, Date.now(), from);
    if (r.ok) await this.save({ runLease: r.lease });
    return r.ok ? { ok: true as const } : r;
  }

  async releaseRun(owner: string) {
    const state = await this.store();
    if (releasesLease(state?.runLease, owner)) await this.save({ runLease: null });
    return { released: releasesLease(state?.runLease, owner) };
  }

  /** Sign-in links: at most one a minute. Called in-process by the page. */
  async magicRequested(now: number) {
    const state = await this.store();
    const last = state?.magicRequestedAt ?? 0;
    if (now - last < 60_000) return { ok: false, retryIn: Math.ceil((60_000 - (now - last)) / 1000) };
    await this.save({ magicRequestedAt: now });
    return { ok: true };
  }

  /** A sign-in link works once: false when its nonce was used already. Expired nonces are forgotten. */
  async consumeMagic(nonce: string, exp: number) {
    const state = await this.store();
    const used: Record<string, number> = state?.magicUsed ?? {};
    if (used[nonce]) return false;
    const nowS = Math.floor(Date.now() / 1000);
    const expired = Object.fromEntries(Object.entries(used).filter(([, e]) => e < nowS).map(([n]) => [n, null]));
    await this.save({ magicUsed: { ...expired, [nonce]: exp } });
    return true;
  }

  /** Delete a digest's definition (its sent issues, votes and memory stay). */
  async deleteDigest(id: string) {
    const state = await this.store();
    if (!state?.profiles?.[id]) return { id, deleted: false };
    await this.save({ profiles: { [id]: null } });
    console.log(JSON.stringify({ digests: "deleted", id }));
    return { id, deleted: true };
  }
}

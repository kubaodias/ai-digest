// A watching digest's pool actor, "<digest>--pool": its watch timer, starting
// checks and taking their candidates, deciding when to write an issue, and
// reserving and releasing stories (pool.ts has the pure scoring and decisions;
// docs/spec/0010-watching.md the design). AiDigest delegates to it by name.

import type { PoolMeta } from "./actor-state.ts";
import { actorNamed, digestsActor, feedbackActor, loadProfile, poolConversation, type ActorContext } from "./actors.ts";
import { sendDigestEmail } from "./delivery.ts";
import { parseProfile, profileIdOf, type DigestProfile } from "./profile.ts";
import {
  canonicalUrl, decide, housekeep, leaseWaitS, mergeCandidates, rescore, watchSettings, slotOf,
  type Candidate, type Decision, type PoolEntry, type Sighting,
} from "./pool.ts";
import { quietNote, checkMessage, writerMessage } from "./watch-instructions.ts";

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

export class PoolActor {
  private readonly ctx: ActorContext;

  constructor(ctx: ActorContext) {
    this.ctx = ctx;
  }

  private poolDigest(): string {
    const id = profileIdOf(this.ctx.conversation);
    if (!id || this.ctx.conversation !== poolConversation(id)) throw new Error("not a pool actor");
    return id;
  }

  private async poolState(): Promise<{ entries: PoolEntry[]; meta: PoolMeta }> {
    const state = await this.ctx.store();
    return { entries: Object.values(state?.poolEntries ?? {}).filter(Boolean) as PoolEntry[], meta: state?.poolMeta ?? {} };
  }

  /** Store the pool (only what changed) and merge `meta` into poolMeta. */
  private async savePool(before: PoolEntry[], after: PoolEntry[], meta: Record<string, unknown>) {
    const old = new Map(before.map((e) => [e.id, JSON.stringify(e)]));
    const patch: Record<string, PoolEntry | null> = {};
    for (const e of after) if (old.get(e.id) !== JSON.stringify(e)) patch[e.id] = e;
    for (const id of old.keys()) if (!after.some((e) => e.id === id)) patch[id] = null;
    await this.ctx.save({ poolEntries: patch, poolMeta: meta });
  }

  /**
   * Arm or cancel this digest's watch timer from its definition: called when a
   * definition is stored or deleted, and by every deploy (which pushes every
   * definition), so a lost timer comes back. The first check runs 1–16 minutes
   * after watching is turned on (firstCheckDelayS).
   */
  async poolConfigure() {
    const id = this.poolDigest();
    const s = watchSettings(await loadProfile(this.ctx.env, id));
    const { meta } = await this.poolState();
    if (!s) {
      await this.ctx.cancelSchedule("watch").catch(() => false);
      if (meta.enabledAt) await this.ctx.save({ poolMeta: { enabledAt: null, watchHours: null } });
      return { digest: id, watching: false };
    }
    // An armed timer with the same interval is left alone, so deploys (which store every
    // definition again) don't line all digests' checks up; a missing one is re-armed.
    const tasks = await this.ctx.listSchedules().catch(() => []);
    const armed = tasks.find((t) => t.id === "watch");
    if (armed && !armed.everyMs && meta.watchHours === s.watchHours) return { digest: id, watching: true, everyHours: s.watchHours, kept: true };
    const now = new Date().toISOString();
    await this.ctx.save({ poolMeta: { watchHours: s.watchHours, ...(meta.enabledAt ? {} : { enabledAt: now, lastIssueAt: meta.lastIssueAt ?? now }) } });
    const delay = firstCheckDelayS();
    await this.ctx.schedule(delay, "watchTick", {}, { id: "watch" });
    return { digest: id, watching: true, everyHours: s.watchHours, firstCheckInMin: Math.round(delay / 60) };
  }

  /** The digest was deleted: stop its timer and forget its pool (a new digest with the same name starts empty). */
  async poolDelete() {
    const id = this.poolDigest();
    const tasks = await this.ctx.listSchedules().catch(() => []);
    for (const t of [...tasks.map((t) => t.id), "watch"]) await this.ctx.cancelSchedule(t).catch(() => false);
    const { entries } = await this.poolState();
    await this.ctx.save({ poolEntries: null, poolMeta: null });
    console.log(JSON.stringify({ pool: "deleted", digest: id, entries: entries.length }));
    return { digest: id, watching: false, cleared: entries.length };
  }

  /** The timer's tick: one check (unless one is still running), then the next tick, an interval later. */
  async watchTick() {
    await this.startCheck({}).catch((err: unknown) => console.log(JSON.stringify({ watch: "tick failed", error: err instanceof Error ? err.message : String(err) })));
    // The next tick; if the definition can't be read right now, the last known interval keeps the chain going.
    // Not loadProfile: that answers undefined both when the definition is gone (stop) and when it
    // can't be read right now (keep going on the last interval); here the two must differ.
    let hours: number | undefined;
    try {
      hours = watchSettings(await digestsActor(this.ctx.env).getDigest(this.poolDigest()).then((d) => (d ? parseProfile(d.id, d.markdown) : undefined)))?.watchHours;
    } catch {
      hours = (await this.poolState()).meta.watchHours ?? undefined;
    }
    if (hours) await this.ctx.schedule(nextCheckDelayS(hours), "watchTick", {}, { id: "watch" });
  }

  /**
   * Start a check now (called in-process by the router, and by the timer).
   * `since`/`until` set the window (e.g. to replay past days); `decide: false`
   * only fills the pool; `force` writes an issue after the check whatever the
   * thresholds say (a manual run), with an optional focus.
   */
  async startCheck(opts: { since?: string; until?: string; decide?: boolean; force?: { focus?: string } }) {
    const id = this.poolDigest();
    const profile = await loadProfile(this.ctx.env, id);
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
        const r = await actorNamed(this.ctx.env, running).recoverCheck().catch(() => ({ delivered: false, reason: "unreachable" }));
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
    await this.ctx.save({ poolMeta: { checkRunning: { slot, startedAt: now.toISOString(), since, until, decide: opts.decide ?? true, force: opts.force ?? null } } });
    // The run starts on an immediate task, so the caller (an API request) doesn't wait for actor start-ups.
    await this.ctx.schedule(0, "runCheck", { slot, since, until, known }, { id: `check-${slot}` });
    return { ok: true, conversation, since, until };
  }

  /** Whether a check's conversation still has a run in progress (its latest trace). */
  private async checkStillRunning(conversation: string): Promise<boolean> {
    const t = await actorNamed(this.ctx.env, conversation).traces(1).catch(() => undefined);
    const status = t?.runs?.[0]?.status;
    return status === "running" || status === "accepted" || status === "queued";
  }

  /** Scheduled by startCheck: hand the request to the check's own conversation. */
  async runCheck(p: { slot: string; since: string; until: string; known: { id: string; headline: string }[] }) {
    const id = this.poolDigest();
    const profile = await loadProfile(this.ctx.env, id);
    if (!profile) return;
    const conversation = `${id}--check-${p.slot}`;
    // One check or issue at a time across all digests (the runtime has crashed under parallel runs).
    const lease = await digestsActor(this.ctx.env).claimRun(conversation);
    if (!lease.ok) {
      const wait = leaseWaitS(lease.retryInS);
      // Still due, just waiting: keep the check from counting as stale meanwhile.
      await this.ctx.save({ poolMeta: { checkRunning: { startedAt: new Date().toISOString() } } });
      await this.ctx.schedule(wait, "runCheck", p, { id: `check-${p.slot}-wait-${Date.now()}` });
      console.log(JSON.stringify({ watch: "waiting", digest: id, slot: p.slot, holder: lease.holder, retryInS: wait }));
      return;
    }
    const run = actorNamed(this.ctx.env, conversation);
    await run.prepareCheckRun({ digest: id, slot: p.slot, since: p.since, until: p.until });
    await run.receive(checkMessage(profile, { since: p.since, until: p.until, known: p.known }));
    console.log(JSON.stringify({ watch: "check started", digest: id, conversation, since: p.since, until: p.until }));
  }

  /** A check's candidates (from its conversation's post-run hook): merge, score, decide. */
  async addCandidates(p: { slot: string; candidates: Candidate[]; seen?: Sighting[]; dropped: number }) {
    const id = this.poolDigest();
    const { entries, meta } = await this.poolState();
    if (meta.lastCheckSlot === p.slot) return { duplicate: true }; // at-least-once delivery
    const profile = await loadProfile(this.ctx.env, id);
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
    await digestsActor(this.ctx.env).releaseRun(checkOwner).catch(() => undefined);
    return { added: merged.added, merged: merged.merged, decision: decision?.action ?? "skipped" };
  }

  /** Write an issue from the pool now, without a check (a manual run with watching off for this run). Queued, so the caller doesn't wait. */
  async writeNow(opts: { focus?: string } = {}) {
    const id = this.poolDigest();
    await this.ctx.schedule(0, "runWriteNow", opts, { id: "write-now" });
    return { ok: true, queued: true, digest: id };
  }

  /** Scheduled by writeNow. */
  async runWriteNow(opts: { focus?: string } = {}) {
    const id = this.poolDigest();
    const profile = await loadProfile(this.ctx.env, id);
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
    const fb = feedbackActor(this.ctx.env);
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
      const lease = await digestsActor(this.ctx.env).claimRun(`${id}--issue-${slotOf(now)}`, fromCheck);
      if (!lease.ok) {
        const wait = leaseWaitS(lease.retryInS);
        await this.ctx.schedule(wait, "runWriteNow", { focus }, { id: `write-wait-${Date.now()}` });
        console.log(JSON.stringify({ pool: "issue waiting", digest: id, holder: lease.holder, retryInS: wait }));
        return { conversation: null, stories: 0, waiting: true };
      }
    }
    if (!ids.length) {
      const note = quietNote(profile, meta.lastIssueAt ?? meta.enabledAt ?? now, now);
      const r = await sendDigestEmail(this.ctx.env, { ...note, profileId: id, profile });
      await this.ctx.save({ poolMeta: { lastIssueAt: now, lastIssue: { slot: slotOf(now), at: now, stories: 0, quiet: true } } });
      console.log(JSON.stringify({ pool: "quiet note", digest: id, ok: r.ok }));
      return { conversation: null, stories: 0 };
    }
    const slot = slotOf(now);
    const conversation = `${id}--issue-${slot}`;
    const chosen = ids.map((x) => pool.find((e) => e.id === x)!).filter(Boolean);
    const reserved = pool.map((e) => (ids.includes(e.id) ? { ...e, state: "reserved" as const, issue: slot, reservedAt: now } : e));
    await this.savePool(pool, reserved, { issueRunning: { slot, startedAt: now, stories: ids.length } });
    const run = actorNamed(this.ctx.env, conversation);
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
    await digestsActor(this.ctx.env).releaseRun(`${this.poolDigest()}--issue-${p.slot}`).catch(() => undefined);
    return { sent };
  }

  /** The pool for the API and the page: settings, timing, the last decision and the entries (live first). */
  async poolView() {
    const id = this.poolDigest();
    const profile = await loadProfile(this.ctx.env, id);
    const { entries, meta } = await this.poolState();
    const tasks = await this.ctx.listSchedules().catch(() => []);
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
}

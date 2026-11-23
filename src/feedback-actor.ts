// The `feedback` actor: the vote log (thumbs clicks in the email and votes on
// the talk page alike), the sent issues, their web view, and the daily talk
// tool budget. AiDigest delegates to it by name; the router calls it in-process.

import { LEGACY_PROFILE } from "./profile.ts";
import type { ActorContext } from "./actors.ts";
import { feedbackKey } from "./config.ts";
import { DOWN_REASONS, ENTITY_OPTIONS, UP_REASONS, selectionsOf, sharedEntityPrefs, validEntityIndex, validReason } from "./preferences.ts";
import { TALK_TTL_S, countTalkTool, type TalkTool, type TalkUsage } from "./talk.ts";
import {
  feedbackLink, nextVote, preferencesFrom, retainIssues, tagItems, TALK_UNTIL_SLACK_MS, verifyPayload, verifyView, viewLink, type DigestItemRecord, type DigestRecord, type StoredVote,
} from "./feedback.ts";
import { errorPage, thanksPage, undonePage } from "./feedback-pages.ts";
import { forgetVote, rememberVote } from "./memory.ts";
import { telnyxOf, type TelnyxClient } from "./telnyx.ts";

/**
 * "I don't use X" needs to know X: fill in entities for a vote on an item tagged before entities existed
 * (the main one is meant). Used by the email's thumbs and the talk page alike.
 */
async function backfillEntities(telnyx: TelnyxClient, vote: StoredVote, item: { why?: string } | undefined): Promise<void> {
  const untargeted = vote.reasons?.find((x) => x.r === "entity" && !x.target);
  if (!untargeted || vote.entities?.length) return;
  vote.entities = (await tagItems(telnyx, [{ headline: vote.headline, why: item?.why ?? "" }]))[0]?.entities ?? [];
  if (vote.entities[0]) untargeted.target = vote.entities[0];
}

export class FeedbackActor {
  private readonly ctx: ActorContext;

  constructor(ctx: ActorContext) {
    this.ctx = ctx;
  }

  async onView(url: URL): Promise<Response> {
    const key = await feedbackKey(this.ctx.env);
    const id = url.searchParams.get("view") ?? "";
    if (!key || !(await verifyView(key, id, url.searchParams.get("s") ?? ""))) return errorPage(400, "The link is invalid.");
    const state = await this.ctx.store();
    const digest: DigestRecord | undefined = state?.digests?.[id];
    if (!digest?.html) return errorPage(404, "That digest is no longer stored.");
    return new Response(digest.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  }

  async onFeedback(url: URL): Promise<Response> {
    const key = await feedbackKey(this.ctx.env);
    if (!key) return errorPage(503, "Feedback isn't configured.");
    const p = await verifyPayload(key, url.searchParams.get("p") ?? "", url.searchParams.get("s") ?? "");
    if (!p) return errorPage(400, "The link is invalid or has expired.");
    const id = `${p.d}:${p.i}`;
    const state = await this.ctx.store();
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
    const telnyx = telnyxOf(this.ctx.env);
    vote.profile ??= ctx.profile;
    if (ctx.digest?.topic) vote.topic ??= ctx.digest.topic;
    await backfillEntities(telnyx, vote, ctx.item);
    if (write) {
      vote.memorySource = await rememberVote(telnyx, ctx.profile, vote).catch((err: unknown) => {
        console.log(JSON.stringify({ feedback: "memory write failed", via, id, error: String(err) }));
        return prior?.memorySource;
      });
      await this.ctx.save({ votes: { [id]: vote } });
    }
    console.log(JSON.stringify({ feedback: "vote", via, id, vote: vote.vote, reasons: selectionsOf(vote), entities: vote.entities, tags: vote.tags, changed: write }));
  }

  /** Remove a vote (an undo, from the email or the talk page): its memory, the stored vote, and its memory again later. */
  private async removeVote(id: string, prior: StoredVote | undefined, profile: string, via: string) {
    if (prior) {
      await forgetVote(telnyxOf(this.ctx.env), profile, prior.memorySource).catch((err: unknown) => console.log(JSON.stringify({ feedback: "memory delete failed", via, id, error: String(err) })));
      await this.ctx.save({ votes: { [id]: null } });
      // Ingestion is asynchronous: a memory still being extracted can land after this delete. Delete again later.
      if (prior.memorySource) await this.later(120, "forgetMemorySourceLater", { source: prior.memorySource, profile });
    }
    console.log(JSON.stringify({ feedback: "undo", via, id }));
  }

  /** Schedule one of the methods below; a failure to schedule is logged, never thrown at the reader. */
  private async later(seconds: number, method: string, payload: unknown, id?: string) {
    try {
      await this.ctx.schedule(seconds, method, payload, id ? { id } : undefined);
    } catch (err) {
      console.log(JSON.stringify({ feedback: "schedule failed", method, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Scheduled after an undo: delete the vote's memory source again, catching memories extracted after the first delete. */
  async forgetMemorySourceLater(p: { source: string; profile?: string }) {
    await forgetVote(telnyxOf(this.ctx.env), p.profile ?? LEGACY_PROFILE, p.source).catch(() => undefined);
    console.log(JSON.stringify({ feedback: "memory deleted again", source: p.source }));
  }

  /**
   * Keep a sent digest. The newest KEEP_DIGESTS keep their email HTML; older ones stay (without it) while
   * their talk links are valid (TALK_TTL_S), so a link works for as long as it says, up to KEEP_ISSUES in all.
   * Called in-process when a digest is emailed; not @rpc, so not on the public mount.
   */
  async registerDigest(record: DigestRecord) {
    const state = await this.ctx.store();
    const older = (Object.values(state?.digests ?? {}).filter(Boolean) as DigestRecord[]).filter((d) => d.id !== record.id);
    const changes = retainIssues(older, Date.now(), TALK_TTL_S * 1000);
    await this.ctx.save({ digests: { ...changes, [record.id]: record } });
    return { stored: record.id, dropped: Object.values(changes).filter((c) => c === null).length };
  }

  /** A stored issue, for talking about it. Called in-process by the router; not @rpc. */
  async issueRecord(id: string): Promise<DigestRecord | undefined> {
    const state = await this.ctx.store();
    return state?.digests?.[id] ?? undefined;
  }

  /**
   * Keep an issue at least until `until` (ISO), when talk links minted for it expire. Written only when that
   * moves its deadline by more than TALK_UNTIL_SLACK_MS, so opening the page doesn't write every time;
   * retainIssues keeps issues that much past talkUntil, so every link minted stays covered. Called in-process; not @rpc.
   */
  async keepIssueUntil(id: string, until: string) {
    const state = await this.ctx.store();
    const d: DigestRecord | undefined = state?.digests?.[id];
    if (!d) return { ok: false };
    const now = Date.parse(until), was = Date.parse(d.talkUntil ?? "") || 0;
    if (now - was > TALK_UNTIL_SLACK_MS) await this.ctx.save({ digests: { [id]: { ...d, talkUntil: until } } });
    return { ok: true };
  }

  /** Replace a stored issue's email HTML (after adding talk links to it). Called in-process; not @rpc. */
  async setIssueHtml(id: string, html: string, talkUntil?: string) {
    const state = await this.ctx.store();
    const d: DigestRecord | undefined = state?.digests?.[id];
    if (!d) return { ok: false };
    await this.ctx.save({ digests: { [id]: { ...d, html, ...(talkUntil ? { talkUntil } : {}) } } });
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
      const state = await this.ctx.store();
      return state.talkUse ?? { day: "", total: {}, issues: {} };
    })();
    const use = await this.talkUse;
    const before = use.day;
    // Checked and counted with no await in between: concurrent calls can't both take the last one.
    const refused = countTalkTool(use, issue, tool);
    if (refused) console.log(JSON.stringify({ talk: "tool limit", tool, issue, day: use.day }));
    else {
      // A new day starts from nothing: clear the stored counts first (setState merges objects).
      if (before && before !== use.day) await this.ctx.save({ talkUse: null });
      await this.ctx.save({ talkUse: structuredClone(use) });
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
    const state = await this.ctx.store();
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
    const state = await this.ctx.store();
    const out: Record<number, { vote: string; reasons: { r: string; target?: string }[] }> = {};
    for (const v of Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[]) if (v.digest === d) out[v.item] = { vote: v.vote, reasons: selectionsOf(v) };
    return out;
  }

  /** For the page: sent issues (newest first) and votes per digest. Called in-process; not @rpc. */
  async appOverview() {
    const state = await this.ctx.store();
    const issues = (Object.values(state?.digests ?? {}).filter(Boolean) as DigestRecord[])
      .map((d) => ({ id: d.id, profile: d.profile ?? LEGACY_PROFILE, ...(d.topic ? { topic: d.topic } : {}), subject: d.subject, sentAt: d.sentAt, items: d.items.length }))
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    const votes: Record<string, number> = {};
    for (const v of Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[]) votes[v.profile ?? LEGACY_PROFILE] = (votes[v.profile ?? LEGACY_PROFILE] ?? 0) + 1;
    return { issues, votes };
  }

  /** One digest's preferences from the vote log, for `reader_preferences`. Called in-process; not @rpc. */
  async feedbackStats(profile: string = LEGACY_PROFILE) {
    const state = await this.ctx.store();
    const votes = (Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[]).filter((v) => (v.profile ?? LEGACY_PROFILE) === profile);
    return preferencesFrom(votes);
  }

  /**
   * What a digest takes from the reader's other digests (preferences.ts,
   * sharedEntityPrefs): explicit entity reasons only. `topic` is a General
   * run's topic, never hidden by a shared "I don't use". Called in-process; not @rpc.
   */
  async sharedPreferences(profile: string = LEGACY_PROFILE, topic?: string) {
    const state = await this.ctx.store();
    const all = Object.values(state?.votes ?? {}).filter(Boolean) as StoredVote[];
    const own = preferencesFrom(all.filter((v) => (v.profile ?? LEGACY_PROFILE) === profile)).entities.map((e) => e.name);
    return sharedEntityPrefs(all, { profile, own, topic, legacyProfile: LEGACY_PROFILE });
  }
}

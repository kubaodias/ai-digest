import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyMergePatch } from "@telnyx/edge-runtime/internal";
import type { AiDigestState } from "../src/actor-state.ts";
import type { ActorContext } from "../src/actors.ts";
import { DigestsActor } from "../src/digests-actor.ts";
import { FeedbackActor } from "../src/feedback-actor.ts";
import { PoolActor } from "../src/pool-actor.ts";
import type { DigestRecord } from "../src/feedback.ts";

// The roles on a small in-memory runtime: each conversation has its own state (merged with the
// runtime's own merge-patch) and task list; actors reach each other by name, as on AI_DIGEST.
// Tasks are recorded, not run.

const WATCHING = readFileSync(new URL("../examples/digests/ai-swe.md", import.meta.url), "utf8").replace("# watch: 6h  ", "watch: 6h    ");

type Task = { id: string; name: string; due: number; payload: unknown };

function runtime() {
  const states = new Map<string, AiDigestState>();
  const tasks = new Map<string, Task[]>();
  const runs: { conversation: string; prepared?: unknown; message?: string }[] = [];
  const posts: { path: string; body?: any }[] = [];
  const roles = new Map<string, unknown>();
  const ctx = (conversation: string): ActorContext => ({
    env,
    conversation,
    store: async () => structuredClone(states.get(conversation) ?? {}),
    save: async (patch) => void states.set(conversation, applyMergePatch(structuredClone(states.get(conversation) ?? {}) as Record<string, unknown>, patch as Record<string, unknown>) as AiDigestState),
    schedule: async (delay, name, payload, opts) => {
      const list = (tasks.get(conversation) ?? []).filter((t) => t.id !== opts?.id);
      const id = opts?.id ?? `t${list.length}`;
      tasks.set(conversation, [...list, { id, name, due: Date.now() + delay * 1000, payload }]);
      return id;
    },
    listSchedules: async () => tasks.get(conversation) ?? [],
    cancelSchedule: async (id) => {
      const list = tasks.get(conversation) ?? [];
      tasks.set(conversation, list.filter((t) => t.id !== id));
      return list.some((t) => t.id === id);
    },
  });
  const role = <T>(name: string, make: () => T): T => (roles.has(name) ? (roles.get(name) as T) : (roles.set(name, make()), roles.get(name) as T));
  const env: any = {
    SECRETS: { get: async () => "" },
    TELNYX: {
      post: async (path: string, opts: { body?: any }) => {
        posts.push({ path, body: opts?.body });
        if (path === "/ai/chat/completions") return { choices: [{ message: { content: "[]" } }] };
        if (path.endsWith("/ingest")) return { data: { source_id: `src-${posts.length}` } };
        return {};
      },
      get: async () => ({}),
      delete: async () => ({}),
    },
    AI_DIGEST: {
      idFromName(name: string) {
        if (name === "digests") return role(name, () => new DigestsActor(ctx(name)));
        if (name === "feedback") return role(name, () => new FeedbackActor(ctx(name)));
        if (name.endsWith("--pool")) return role(name, () => new PoolActor(ctx(name)));
        // A run: records what it was given.
        return {
          prepareCheckRun: async (r: unknown) => void runs.push({ conversation: name, prepared: r }),
          prepareIssueRun: async (r: unknown) => void runs.push({ conversation: name, prepared: r }),
          receive: async (message: string) => void runs.push({ conversation: name, message }),
          traces: async () => ({ runs: [] }),
          recoverCheck: async () => ({ delivered: false, reason: "no reply" }),
        };
      },
    },
  };
  return { env, states, tasks, runs, posts, actor: (name: string) => env.AI_DIGEST.idFromName(name) };
}

const cand = (n: number, importance = 5) => ({
  headline: `Story ${n}`,
  url: `https://news.example.org/story-${n}`,
  source: "news.example.org",
  summary: `What happened in story ${n}.`,
  importance,
  why: "Because.",
  otherSources: [],
  primary: true,
  tags: ["agents"],
  entities: [`product ${n}`],
});

test("pool: the watch timer is armed once per interval; a check runs alone and its delivery counts once", async () => {
  const rt = runtime();
  assert.match(WATCHING, /^watch: 6h/m);
  await rt.actor("digests").putDigest("ai-swe", WATCHING);
  const pool: PoolActor = rt.actor("ai-swe--pool");

  const first = await pool.poolConfigure();
  assert.equal(first.watching, true);
  assert.deepEqual(rt.tasks.get("ai-swe--pool")!.map((t) => [t.id, t.name]), [["watch", "watchTick"]]);
  assert.ok(rt.states.get("ai-swe--pool")!.poolMeta!.enabledAt);
  assert.equal((await pool.poolConfigure()).kept, true, "a deploy leaves an armed timer alone");

  const started = await pool.startCheck({ decide: false });
  assert.equal(started.ok, true);
  const slot = rt.states.get("ai-swe--pool")!.poolMeta!.checkRunning!.slot!;
  assert.ok(rt.tasks.get("ai-swe--pool")!.some((t) => t.name === "runCheck" && t.id === `check-${slot}`));
  assert.deepEqual(await pool.startCheck({}), { ok: false, error: "a check is already running", conversation: `ai-swe--check-${slot}` });

  // The check's run takes the run lease, gets its window, and is asked to check.
  const p = rt.tasks.get("ai-swe--pool")!.find((t) => t.name === "runCheck")!.payload as any;
  await pool.runCheck(p);
  assert.equal(rt.states.get("digests")!.runLease!.owner, `ai-swe--check-${slot}`);
  assert.deepEqual(rt.runs.map((r) => r.conversation), [`ai-swe--check-${slot}`, `ai-swe--check-${slot}`]);

  const added = await pool.addCandidates({ slot, candidates: [cand(1), cand(2)], dropped: 0 });
  assert.equal(added.added, 2);
  assert.equal(added.decision, "skipped", "decide: false only fills the pool");
  assert.deepEqual(await pool.addCandidates({ slot, candidates: [cand(3)], dropped: 0 }), { duplicate: true });
  const meta = rt.states.get("ai-swe--pool")!.poolMeta!;
  assert.equal(meta.checkRunning, undefined, "the check is done");
  assert.equal(meta.checks, 1);
  assert.equal(rt.states.get("digests")!.runLease, undefined, "and the lease is released");
  assert.equal((await pool.poolView()).counts.candidates, 2);
});

test("pool: an issue's stories are sent, the ones it left out go back; a repeat changes nothing", async () => {
  const rt = runtime();
  await rt.actor("digests").putDigest("ai-swe", WATCHING);
  const pool: PoolActor = rt.actor("ai-swe--pool");
  await pool.poolConfigure();
  const slot = (await pool.startCheck({ decide: false }), rt.states.get("ai-swe--pool")!.poolMeta!.checkRunning!.slot!);
  await pool.addCandidates({ slot, candidates: [cand(1), cand(2)], dropped: 0 });
  const ids = Object.keys(rt.states.get("ai-swe--pool")!.poolEntries!);
  const reserved = Object.fromEntries(ids.map((id) => [id, { state: "reserved", issue: "s1", reservedAt: "2026-11-23T00:00:00Z" }]));
  rt.states.set("ai-swe--pool", applyMergePatch(rt.states.get("ai-swe--pool")! as Record<string, unknown>, { poolEntries: reserved }) as AiDigestState);

  assert.deepEqual(await pool.markSent({ slot: "s1", urls: ["https://news.example.org/story-1?utm_source=x"] }), { sent: 1 });
  const states = Object.values(rt.states.get("ai-swe--pool")!.poolEntries!).map((e) => [e.headline, e.state]).sort();
  assert.deepEqual(states, [["Story 1", "sent"], ["Story 2", "candidate"]]);
  assert.deepEqual(await pool.markSent({ slot: "s1", urls: [] }), { duplicate: true });
});

const ISSUE: DigestRecord = {
  id: "20261123-ab12",
  subject: "AI & Software Engineering Digest — Nov 23",
  sentAt: "2026-11-23T08:00:00Z",
  profile: "ai-swe",
  items: [{ n: 1, headline: "Story 1", why: "Because.", url: "https://news.example.org/story-1", source: "news.example.org", tags: ["agents"], entities: ["acme"] }],
};

test("feedback: a reason from the talk page casts its vote first; undo removes it and its memory", async () => {
  const rt = runtime();
  const fb: FeedbackActor = rt.actor("feedback");
  await fb.registerDigest(ISSUE);
  assert.deepEqual(await fb.talkVote({ d: ISSUE.id, i: 9, v: "up" }), { ok: false, error: "no such story in this issue" });

  const r = await fb.talkVote({ d: ISSUE.id, i: 1, v: "down", r: "entity", x: 0 });
  assert.deepEqual({ ok: r.ok, vote: r.vote, reasons: r.reasons }, { ok: true, vote: "down", reasons: [{ r: "entity", target: "acme" }] });
  const stored = rt.states.get("feedback")!.votes![`${ISSUE.id}:1`]!;
  assert.equal(stored.profile, "ai-swe");
  assert.ok(stored.memorySource, "its memory was written");
  assert.deepEqual(await fb.issueVotes(ISSUE.id), { 1: { vote: "down", reasons: [{ r: "entity", target: "acme" }] } });

  assert.deepEqual(await fb.talkVote({ d: ISSUE.id, i: 1, v: "down", undo: true }), { ok: true, story: 1, vote: null, reasons: [] });
  assert.equal(rt.states.get("feedback")!.votes![`${ISSUE.id}:1`], undefined);
  assert.ok(rt.tasks.get("feedback")!.some((t) => t.name === "forgetMemorySourceLater"), "its memory is deleted again later");
});

test("feedback: paid talk tools are counted across calls and start again from nothing each UTC day", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-23T23:00:00Z") });
  const rt = runtime();
  const fb: FeedbackActor = rt.actor("feedback");
  assert.equal(await fb.spendTalkTool("a", "search_web"), undefined);
  assert.equal(await fb.spendTalkTool("a", "search_web"), undefined);
  assert.equal(rt.states.get("feedback")!.talkUse!.issues.a!.search_web, 2);
  t.mock.timers.setTime(Date.parse("2026-11-24T00:30:00Z"));
  assert.equal(await fb.spendTalkTool("b", "read_article"), undefined);
  const use = rt.states.get("feedback")!.talkUse!;
  assert.equal(use.day, "2026-11-24");
  assert.deepEqual(Object.keys(use.issues), ["b"], "yesterday's counts are gone, not merged");
});

test("digests: a definition keeps its earlier versions; the run lease has one holder", async () => {
  const rt = runtime();
  const d: DigestsActor = rt.actor("digests");
  assert.equal((await d.putDigest("x", "one")).changed, true);
  assert.deepEqual(await d.putDigest("x", "one"), { id: "x", changed: false, versions: 1 });
  for (let k = 2; k <= 12; k++) await d.putDigest("x", `v${k}`);
  assert.equal((await d.getDigest("x"))!.versions, 10, "at most ten versions");
  assert.deepEqual(await d.deleteDigest("x"), { id: "x", deleted: true });
  assert.equal(await d.getDigest("x"), null);

  assert.deepEqual(await d.claimRun("a--check-1"), { ok: true });
  const other = await d.claimRun("b--check-1");
  assert.equal(other.ok, false);
  assert.deepEqual(await d.releaseRun("b--check-1"), { released: false });
  assert.deepEqual(await d.releaseRun("a--check-1"), { released: true });
  assert.deepEqual(await d.claimRun("b--check-1"), { ok: true });
});


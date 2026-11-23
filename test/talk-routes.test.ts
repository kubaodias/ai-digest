import { test } from "node:test";
import assert from "node:assert/strict";
import { route, type RouterEnv } from "../src/router.ts";
import { talkToken } from "../src/talk.ts";

const KEY = "talk-key";
const ISSUE = { id: "20261123-ab12", subject: "Weekly — Nov 23", sentAt: "2026-11-23T08:00:00Z", items: [{ n: 1, headline: "Story 1", why: "w", url: "https://news.example.org/1", source: "news.example.org", tags: [] }] };

/** A deployment with the assistant: the feedback actor answers from ISSUE and refuses paid tools after `budget`. */
function deployment(budget = 10) {
  const calls: { method: string; args: unknown[] }[] = [];
  const posts: string[] = [];
  const feedback = {
    issueRecord: async (id: string) => (id === ISSUE.id ? ISSUE : undefined),
    spendTalkTool: async (...args: unknown[]) => (calls.push({ method: "spendTalkTool", args }), budget-- > 0 ? undefined : "today's limit is used up"),
    talkVote: async (p: unknown) => (calls.push({ method: "talkVote", args: [p] }), { ok: true }),
  };
  const env = {
    SECRETS: { get: async (n: string) => ({ FEEDBACK_KEY: KEY, TALK_ASSISTANT_ID: "asst" })[n] ?? "" },
    TELNYX: { get: async () => ({}), post: async (path: string) => (posts.push(path), { data: { results: { web: [{ url: "https://news.example.org/x", title: "X", description: "about x" }] } } }) },
    AI_DIGEST: { idFromName: (name: string) => (name === "feedback" ? feedback : assert.fail(name)) },
  } as unknown as RouterEnv;
  return { env, calls, posts };
}

const call = async (env: RouterEnv, tool: string, body: unknown) => {
  const r = await route(new Request(`http://localhost/v1/talk/tools/${tool}`, { method: "POST", body: JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json() };
};

test("talk tools: the link's token decides; the issue must still be stored; unknown tools are 404", async () => {
  const { env } = deployment();
  const t = await talkToken(KEY, { d: ISSUE.id, e: Math.floor(Date.now() / 1000) + 60 });
  assert.deepEqual(await call(env, "search_web", { t: "forged", args: { query: "x" } }), { status: 401, body: { error: "invalid_token" } });
  const gone = await talkToken(KEY, { d: "20260101-zzzz", e: Math.floor(Date.now() / 1000) + 60 });
  assert.deepEqual(await call(env, "search_web", { t: gone, args: { query: "x" } }), { status: 404, body: { error: "issue_gone" } });
  assert.deepEqual(await call(env, "constructor", { t, args: {} }), { status: 404, body: { error: "unknown_tool" } });
  const get = await route(new Request("http://localhost/v1/talk/tools/search_web"), env);
  assert.equal(get.status, 404);
});

test("talk tools: paid tools are counted first and refused past the limit; votes need a story and a direction", async () => {
  const { env, calls, posts } = deployment(1);
  const t = await talkToken(KEY, { d: ISSUE.id, e: Math.floor(Date.now() / 1000) + 60 });
  const first = await call(env, "search_web", { t, args: { query: "agent memory" } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.results.map((r: { title: string }) => r.title), ["X"]);
  assert.deepEqual(await call(env, "search_web", { t, args: { query: "again" } }), { status: 200, body: { error: "today's limit is used up" } });
  assert.deepEqual(posts, ["/web_search"], "the refused search never reached the API");
  assert.deepEqual(calls.filter((c) => c.method === "spendTalkTool").map((c) => c.args), [[ISSUE.id, "search_web"], [ISSUE.id, "search_web"]]);

  assert.deepEqual(await call(env, "record_vote", { t, args: { story: 1, vote: "sideways" } }), { status: 200, body: { error: "story and vote (up or down) are required" } });
  assert.deepEqual(await call(env, "record_vote", { t, args: { story: 1, vote: "up" } }), { status: 200, body: { ok: true } });
  assert.deepEqual(await call(env, "feedback", { t, args: { story: 1, vote: "down", reason: "known", undo: false } }), { status: 200, body: { ok: true } });
  assert.deepEqual(calls.filter((c) => c.method === "talkVote").map((c) => c.args[0]), [
    { d: ISSUE.id, i: 1, v: "up", via: "voice" },
    { d: ISSUE.id, i: 1, v: "down", r: "known", x: undefined, undo: false, via: "page" },
  ]);
  assert.deepEqual(await call(env, "log", { t, args: { stage: "start", error: "NotAllowedError" } }), { status: 200, body: { ok: true } });
  // A report that can't be turned into text still gets an answer, like any failing tool.
  assert.deepEqual(await call(env, "log", { t, args: { error: { toString: 0 } } }), { status: 200, body: { error: "the tool failed; say so and continue" } });
});

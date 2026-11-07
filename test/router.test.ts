import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { operatorToken } from "../src/auth.ts";
import { route, runName, type RouterEnv } from "../src/router.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ORIGIN = "https://digest.example.com";
const example = readFileSync(new URL("../examples/digests/agent-memory.md", import.meta.url), "utf8");

/** Fake actors: records what each one was asked. */
function fakeEnv(key: string | undefined = KEY) {
  const calls: { actor: string; method: string; args: unknown[] }[] = [];
  const store = new Map<string, string>();
  const env: RouterEnv = {
    SECRETS: { get: async (n: string) => (n === "AGENT_AUTH_KEY" && key ? key : "") },
    AI_DIGEST: {
      idFromName(name: string) {
        const rec = (method: string, args: unknown[]) => calls.push({ actor: name, method, args });
        return {
          fetch: async (req: Request) => (rec("fetch", [new URL(req.url).pathname]), new Response("feedback page")),
          listDigests: async () => (rec("listDigests", []), [...store.keys()].map((id) => ({ id }))),
          getDigest: async (id: string) => (rec("getDigest", [id]), store.has(id) ? { id, markdown: store.get(id) } : null),
          putDigest: async (id: string, md: string) => (rec("putDigest", [id]), store.set(id, md), { id, changed: true }),
          deleteDigest: async (id: string) => (rec("deleteDigest", [id]), { id, deleted: store.delete(id) }),
          receive: async (text: string) => (rec("receive", [text]), { runId: "run-1" }),
          traces: async (n: number) => (rec("traces", [n]), [{ id: "run-1" }]),
        };
      },
    },
  };
  return { env, calls, store };
}
const auth = async () => ({ authorization: `Bearer ${await operatorToken(KEY)}` });
const req = (path: string, init: RequestInit = {}) => new Request(ORIGIN + path, init);

test("public routes: health, icons, signed feedback pages (v1 and the pre-0.2.0 path)", async () => {
  const { env, calls } = fakeEnv();
  const health = await route(req("/v1/health"), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, "0.2.0");
  const icon = await route(req("/v1/assets/thumb-up.png"), env);
  assert.equal(icon.headers.get("content-type"), "image/png");
  await route(req("/v1/feedback?p=x&s=y"), env);
  await route(req("/agents/ai-digest/feedback?p=x&s=y"), env);
  assert.deepEqual(calls.map((c) => [c.actor, c.method, c.args[0]]), [["feedback", "fetch", "/v1/feedback"], ["feedback", "fetch", "/agents/ai-digest/feedback"]]);
});

test("everything else needs the operator token", async () => {
  const { env, calls } = fakeEnv();
  for (const [path, method] of [["/v1/digests", "GET"], ["/v1/digests/agent-memory", "PUT"], ["/v1/digests/agent-memory/runs", "POST"], ["/v1/runs/x--1", "GET"]] as const) {
    assert.equal((await route(req(path, { method }), env)).status, 401, `${method} ${path} without a token`);
    assert.equal((await route(req(path, { method, headers: { authorization: "Bearer wrong" } }), env)).status, 401);
  }
  assert.equal(calls.length, 0, "no actor touched");
});

test("actors' own front doors aren't reachable: old /agents paths other than feedback are 404", async () => {
  const { env, calls } = fakeEnv();
  assert.equal((await route(req("/agents/ai-digest/feedback?subscribe=state", { method: "POST" }), env)).status, 404);
  assert.equal((await route(req("/agents/ai-digest/agent-memory--1/rpc/receive", { method: "POST", headers: await auth() }), env)).status, 404);
  assert.equal((await route(req("/agents/ai-digest/feedback", { headers: await auth() }), env)).status, 200, "the feedback page itself is fine");
  assert.deepEqual(calls.map((c) => c.method), ["fetch"]);
});

test("digests: store (validated), list, show, delete", async () => {
  const { env, store } = fakeEnv();
  const h = await auth();
  const bad = await route(req("/v1/digests/agent-memory", { method: "PUT", headers: h, body: "no settings" }), env);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).message, /settings block/);
  assert.equal(store.size, 0);
  assert.equal((await route(req("/v1/digests/Bad_Id", { method: "PUT", headers: h, body: example }), env)).status, 400);
  assert.equal((await route(req("/v1/digests/agent-memory", { method: "PUT", headers: h, body: example }), env)).status, 200);
  assert.deepEqual(await (await route(req("/v1/digests", { headers: h }), env)).json(), [{ id: "agent-memory" }]);
  assert.equal((await (await route(req("/v1/digests/agent-memory", { headers: h }), env)).json()).markdown, example);
  assert.equal((await route(req("/v1/digests/missing", { headers: h }), env)).status, 404);
  assert.equal((await (await route(req("/v1/digests/agent-memory", { method: "DELETE", headers: h }), env)).json()).deleted, true);
});

test("runs: start one for a stored digest in its own conversation, with the definition as the message", async () => {
  const { env, calls, store } = fakeEnv();
  const h = { ...(await auth()), "content-type": "application/json" };
  assert.equal((await route(req("/v1/digests/agent-memory/runs", { method: "POST", headers: h, body: "{}" }), env)).status, 404, "not pushed yet");
  store.set("agent-memory", example);
  const res = await route(req("/v1/digests/agent-memory/runs", { method: "POST", headers: h, body: JSON.stringify({ run: "w45", message: "focus on MCP" }) }), env);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.conversation, "agent-memory--w45");
  const receive = calls.find((c) => c.method === "receive")!;
  assert.equal(receive.actor, "agent-memory--w45");
  assert.match(String(receive.args[0]), /Agent Memory Weekly/);
  assert.match(String(receive.args[0]), /For this issue in particular: focus on MCP/);
  const status = await route(req("/v1/runs/agent-memory--w45", { headers: h }), env);
  assert.deepEqual((await status.json()).traces, [{ id: "run-1" }]);
});

test("run names: the caller's if safe, else the current time", () => {
  assert.equal(runName("w45"), "w45");
  assert.equal(runName("a--b", new Date("2026-11-07T21:55:00Z")), "2026-11-07t2155");
  assert.equal(runName(undefined, new Date("2026-11-07T21:55:00Z")), "2026-11-07t2155");
});

test("unknown paths are 404 with a hint", async () => {
  const { env } = fakeEnv();
  const r = await route(req("/"), env);
  assert.equal(r.status, 404);
  assert.match((await r.json()).message, /\/v1/);
});

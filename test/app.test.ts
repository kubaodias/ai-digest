import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SESSION_COOKIE, app, maskEmail, parseCookies, signToken, verifyToken, type AppDeps } from "../src/app.ts";
import { computePreferences } from "../src/preferences.ts";

const KEY = "auth-key-for-tests";
const ORIGIN = "https://digest.example.com";
const example = readFileSync(new URL("../examples/digests/agent-memory.md", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-08T10:00:00Z");

function deps(over: Partial<AppDeps> = {}) {
  const sent: { to: string; text: string }[] = [];
  const used = new Set<string>();
  let lastMagic = 0;
  const d: AppDeps = {
    authKey: KEY,
    feedbackKey: "feedback-key",
    adminEmail: "admin@example.com",
    now: () => NOW,
    digests: {
      // The real shape: the digests actor's listDigests() returns summaries, not definition text.
      listDigests: async () => [
        { id: "agent-memory", title: "Agent Memory Weekly — {range}", windowDays: 14, items: { min: 5, max: 10 }, schedule: null, updatedAt: "2026-11-07T22:00:00Z", versions: 2 },
        { id: "broken", title: null, windowDays: null, items: null, schedule: null, updatedAt: "2026-11-07T22:00:00Z", versions: 1 },
      ],
      getDigest: async (id) => (id === "agent-memory" ? { id, markdown: example, updatedAt: "2026-11-07T22:00:00Z", versions: 2 } : null),
      magicRequested: async (now) => (now - lastMagic < 60_000 ? { ok: false, retryIn: 42 } : ((lastMagic = now), { ok: true })),
      consumeMagic: async (n) => (used.has(n) ? false : (used.add(n), true)),
    },
    feedback: {
      appOverview: async () => ({
        issues: [
          { id: "20261107-8xxl", profile: "agent-memory", subject: "Agent Memory Weekly — Oct 25 – Nov 8, 2026", sentAt: "2026-11-07T22:11:56Z", items: 7 },
          { id: "20261107-gfar", profile: "ai-swe", subject: "AI & Software Engineering Digest — 1–7 November 2026", sentAt: "2026-11-07T10:20:00Z", items: 13 },
        ],
        votes: { "agent-memory": 1, "ai-swe": 4 },
      }),
      feedbackStats: async () =>
        computePreferences([{ vote: "up", headline: "Mem0 report", tags: ["agent memory"], entities: ["mem0"], source: "mem0.ai", reasons: [{ r: "entity", target: "mem0" }], at: "2026-11-07T21:37:00Z" }]),
    },
    memory: { counts: async () => ({ "agent-memory": 2, "ai-swe": 8 }), summary: async () => "## Wants more of\n- **Mem0** — liked the state-of-memory report (7 Nov 2026)." },
    sendEmail: async (to, _s, text) => void sent.push({ to, text }),
    ...over,
  };
  return { d, sent };
}
const get = (path: string, cookie?: string) => new Request(ORIGIN + path, cookie ? { headers: { cookie } } : {});
const sessionFor = async (exp = NOW / 1000 + 3600) => `${SESSION_COOKIE}=${encodeURIComponent(await signToken(KEY, "session", { sub: "admin", exp }))}`;

test("tokens: signed per purpose, expire, reject tampering", async () => {
  const t = await signToken(KEY, "session", { sub: "admin", exp: NOW / 1000 + 60 });
  assert.equal((await verifyToken(KEY, "session", t, NOW))?.sub, "admin");
  assert.equal(await verifyToken(KEY, "magic", t, NOW), undefined, "a session token isn't a sign-in link");
  assert.equal(await verifyToken("other", "session", t, NOW), undefined);
  assert.equal(await verifyToken(KEY, "session", t, NOW + 61_000), undefined, "expired");
  assert.equal(await verifyToken(KEY, "session", t.replace(/^./, "x"), NOW), undefined);
  assert.equal(await verifyToken(KEY, "session", undefined, NOW), undefined);
});

test("cookies and masking", () => {
  assert.deepEqual(parseCookies("a=1; aid_session=x%2Ey; b=2"), { a: "1", aid_session: "x.y", b: "2" });
  assert.deepEqual(parseCookies(null), {});
  assert.equal(maskEmail("kuba@example.com"), "k***@example.com");
});

test("without a session every page redirects to sign-in", async () => {
  const { d } = deps();
  for (const p of ["/v1/app", "/v1/app/digests/agent-memory"]) {
    const r = await app(get(p), d);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/v1/app/sign-in");
  }
  const expired = await app(get("/v1/app", await sessionFor(NOW / 1000 - 1)), d);
  assert.equal(expired.status, 303, "expired session");
  const signIn = await (await app(get("/v1/app/sign-in"), d)).text();
  assert.match(signIn, /Email me a sign-in link/);
});

test("sign-in: link emailed to the admin address, works once, sets a secure session cookie", async () => {
  const { d, sent } = deps();
  const r = await app(new Request(ORIGIN + "/v1/app/sign-in", { method: "POST" }), d);
  assert.match(await r.text(), /a\*\*\*@example\.com/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, "admin@example.com");
  const link = sent[0]!.text.match(/https:\/\/\S+/)![0];
  assert.ok(link.startsWith(ORIGIN + "/v1/app/auth?t="));
  const ok = await app(get(new URL(link).pathname + new URL(link).search), d);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/v1/app");
  const cookie = ok.headers.get("set-cookie")!;
  assert.match(cookie, /^aid_session=.+; Path=\/v1\/app; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
  const again = await app(get(new URL(link).pathname + new URL(link).search), d);
  assert.match(await again.text(), /expired or was already used/, "a link works once");
  const page = await app(get("/v1/app", cookie.split(";")[0]), d);
  assert.equal(page.status, 200);
});

test("sign-in links: at most one a minute; expired links are refused", async () => {
  const { d, sent } = deps();
  await app(new Request(ORIGIN + "/v1/app/sign-in", { method: "POST" }), d);
  const second = await app(new Request(ORIGIN + "/v1/app/sign-in", { method: "POST" }), d);
  assert.match(await second.text(), /Try again in 42 seconds/);
  assert.equal(sent.length, 1);
  const old = await signToken(KEY, "magic", { n: "nonce", exp: NOW / 1000 - 1 });
  assert.match(await (await app(get(`/v1/app/auth?t=${old}`), d)).text(), /expired or was already used/);
});

test("the list page shows each digest with its last issue, votes and memory", async () => {
  const { d } = deps();
  const html = await (await app(get("/v1/app", await sessionFor()), d)).text();
  assert.match(html, /Agent Memory Weekly/);
  assert.match(html, /14 days · 5–10 items/);
  assert.match(html, /Last issue 7 Nov 2026 · 7 items/);
  assert.match(html, /1 vote · 2 memories · updated 7 Nov 2026 \(v2\)/, "singular and plural");
  assert.match(html, /href="\/v1\/app\/digests\/agent-memory"/);
  assert.doesNotMatch(html.split("broken")[0]!, /Invalid definition/, "a valid digest isn't shown as invalid");
  assert.match(html, /Invalid definition/, "an invalid one is");
  assert.match(html, /AI Digest · made with/);
});

test("the digest page: settings, description, file, issues with signed view links, preferences, memory; no secrets", async () => {
  const { d } = deps();
  const html = await (await app(get("/v1/app/digests/agent-memory", await sessionFor()), d)).text();
  assert.match(html, /<td>Time window<\/td><td>14 days<\/td>/);
  assert.match(html, /<td>Recipients<\/td><td>default \(DIGEST_EMAIL_TO\)<\/td>/);
  assert.match(html, /Memory systems for AI agents/);
  assert.match(html, /<summary>Definition file<\/summary>/);
  assert.match(html, /href="https:\/\/digest\.example\.com\/v1\/feedback\?view=20261107-8xxl&amp;s=[^"]+">Agent Memory Weekly/);
  assert.doesNotMatch(html, /20261107-gfar/, "only this digest's issues");
  assert.match(html, /↑ mem0 · 1/);
  assert.match(html, /Agent Memory · profile agent-memory · 2 entries/);
  assert.match(html, /<strong>Mem0<\/strong>/);
  assert.doesNotMatch(html, /auth-key-for-tests|feedback-key/);
  assert.equal((await app(get("/v1/app/digests/nope", await sessionFor()), d)).status, 404);
});

test("read-only, sign-out, not configured", async () => {
  const { d } = deps();
  assert.equal((await app(new Request(ORIGIN + "/v1/app", { method: "POST", headers: { cookie: await sessionFor() } }), d)).status, 405);
  const out = await app(get("/v1/app/sign-out"), d);
  assert.equal(out.headers.get("location"), "/v1/app/sign-in");
  assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal((await app(get("/v1/app"), { ...d, authKey: undefined })).status, 503);
});

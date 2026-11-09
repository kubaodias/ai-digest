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
        { id: "agent-memory", title: "Agent Memory Weekly — {range}", windowDays: 14, items: { min: 5, max: 10 }, scout: null, updatedAt: "2026-11-07T22:00:00Z", versions: 2 },
        { id: "broken", title: null, windowDays: null, items: null, scout: null, updatedAt: "2026-11-07T22:00:00Z", versions: 1 },
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
  assert.equal(maskEmail("kuba@example.com"), "k*****a@example.com");
  assert.equal(maskEmail("kodeo.it.reader@example.com"), "k*****r@example.com", "the length stays hidden");
  assert.equal(maskEmail("k@example.com"), "k*****@example.com");
  assert.equal(maskEmail("no-at-sign"), "your address");
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
  assert.match(await r.text(), /a\*\*\*\*\*n@example\.com/);
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

test("the overview always shows the built-in General card, with recent one-off topics", async () => {
  const general = { id: "20261109-abcd", profile: "__general", topic: "agent harnesses", subject: "Agent harnesses — 2–9 November 2026", sentAt: "2026-11-09T08:00:00Z", items: 6 };
  const { d } = deps({
    feedback: { ...deps().d.feedback, appOverview: async () => ({ issues: [general], votes: { __general: 3 } }) },
    memory: { counts: async () => ({ __general: 2 }), summary: async () => null },
  });
  const html = await (await app(get("/v1/app", await sessionFor()), d)).text();
  assert.match(html, /href="\/v1\/app\/digests\/__general"/);
  assert.match(html, /built in · on demand/);
  assert.match(html, /Recent: agent harnesses/);
  assert.match(html, /3 votes · 2 memories/);
  const none = deps({ digests: { ...deps().d.digests, listDigests: async () => [] } }).d;
  const empty = await (await app(get("/v1/app", await sessionFor()), none)).text();
  assert.match(empty, /No digests of your own yet/);
  assert.match(empty, /General/, "the General card shows even with no stored digests");
});

test("the General page: how to ask, the template, its issues, what it learned, its memory profile", async () => {
  const general = { id: "20261109-abcd", profile: "__general", topic: "agent harnesses", subject: "Agent harnesses — 2–9 November 2026", sentAt: "2026-11-09T08:00:00Z", items: 6 };
  const asked: string[] = [];
  const { d } = deps({
    digests: { ...deps().d.digests, getDigest: async (id) => (asked.push(id), null) },
    feedback: { appOverview: async () => ({ issues: [general], votes: { __general: 1 } }), feedbackStats: async (p) => (asked.push(`stats:${p}`), deps().d.feedback.feedbackStats(p)) },
  });
  const r = await app(get("/v1/app/digests/__general", await sessionFor()), d);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<h1>General<\/h1>/);
  assert.match(html, /npm run digests -- ask/);
  assert.match(html, /would like to get information about \{topic\}/, "the template");
  assert.match(html, /Agent harnesses — 2–9 November 2026/);
  assert.match(html, /profile __general/);
  assert.doesNotMatch(html, /Sources/);
  assert.deepEqual(asked, ["stats:__general"], "no stored definition is looked up");
  assert.equal((await app(get("/v1/app/digests/_general", await sessionFor()), d)).status, 404);
});

test("a digest's page no longer lists sources", async () => {
  const { d } = deps();
  const html = await (await app(get("/v1/app/digests/agent-memory", await sessionFor()), d)).text();
  assert.doesNotMatch(html, /<td>Sources<\/td>/);
});

test("a scouting digest's page shows its pool: timing, counts, why no issue yet, the strongest candidates", async () => {
  const scouting = example.replace(/^---\n/, "---\nscout: 6h\nsend_at: 4\n");
  const view = {
    scout: { strong: 7, sendAt: 4, maxGapDays: 7 },
    nextPassAt: "2026-11-09T18:00:00Z",
    lastPassAt: "2026-11-09T12:00:00Z",
    passes: 3,
    passRunning: null,
    lastIssueAt: null,
    issueRunning: null,
    lastDecision: { action: "none", reason: "2 of 4 strong stories", dueBy: "2026-11-16T12:00:00Z" },
    counts: { candidates: 5, strong: 2, sent: 0, expired: 1 },
    entries: [
      { headline: "Zep ships temporal graphs", url: "https://zep.example.com/x", source: "zep.example.com", score: 8.5, state: "candidate", sightings: 2, sources: [1, 2] },
      { headline: "Old news", url: "https://x.example.com/", source: "x.example.com", score: 3, state: "expired", sightings: 1, sources: [1] },
    ],
  };
  const asked: string[] = [];
  const { d } = deps({
    digests: { ...deps().d.digests, getDigest: async (id) => ({ id, markdown: scouting, updatedAt: "2026-11-07T22:00:00Z", versions: 3 }) },
    pool: async (id) => (asked.push(id), view),
  });
  const html = await (await app(get("/v1/app/digests/agent-memory", await sessionFor()), d)).text();
  assert.deepEqual(asked, ["agent-memory"]);
  assert.match(html, /every 6 h · an issue at 4 stories scoring 7\+/);
  assert.match(html, /Scouting · 3 passes/);
  assert.match(html, /2 strong \(score 7\+, 4 needed\) · 5 candidates/);
  assert.match(html, /No issue yet: 2 of 4 strong stories\. An issue by 16 Nov, 12:00 UTC at the latest\./);
  assert.match(html, /8\.5<\/td><td><a href="https:\/\/zep\.example\.com\/x">Zep ships temporal graphs<\/a> <span class="faint">· zep\.example\.com \+1 · seen 2×/);
  assert.doesNotMatch(html, /Old news/, "only live candidates are listed");
  const plain = deps({ pool: async (id) => (asked.push(`plain:${id}`), view) }).d;
  const off = await (await app(get("/v1/app/digests/agent-memory", await sessionFor()), plain)).text();
  assert.match(off, /off: issues on request/);
  assert.doesNotMatch(off, /Scouting ·/);
  assert.ok(!asked.includes("plain:agent-memory"), "no pool lookup for a digest that doesn't scout");
});

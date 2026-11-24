import { test } from "node:test";
import assert from "node:assert/strict";
import { TALK_LIMITS, countTalkTool, addTalkLinkText, addTalkLinks, hasTalkLinks, issueTalkLink, rebaseLinks, digestName, headerValue, issueBrief, talkLinks, talkToken, verifyTalkToken } from "../src/talk.ts";
import { talkGreeting } from "../src/talk-instructions.ts";
import { thumbsRow, type DigestRecord } from "../src/feedback.ts";
import { renderEmailHtml } from "../src/agent.ts";

const KEY = "test-key";

test("talk tokens: round trip, story optional; tampered, foreign-key and expired tokens are refused", async () => {
  const e = Math.floor(Date.now() / 1000) + 60;
  const t = await talkToken(KEY, { d: "20261116-ab12", i: 3, e });
  assert.deepEqual(await verifyTalkToken(KEY, t), { d: "20261116-ab12", i: 3, e });
  assert.deepEqual(await verifyTalkToken(KEY, await talkToken(KEY, { d: "x", e })), { d: "x", e });
  const [payload, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ d: "other", i: 3, e })).toString("base64url");
  assert.equal(await verifyTalkToken(KEY, `${forged}.${sig}`), undefined);
  assert.equal(await verifyTalkToken("another-key", t), undefined);
  assert.equal(await verifyTalkToken(KEY, `${payload}`), undefined);
  assert.equal(await verifyTalkToken(KEY, await talkToken(KEY, { d: "x", e: 1 })), undefined);
});

// The email as it's sent: the renderer's HTML with feedback.ts's thumbs rows (as addFeedbackLinks puts them).
const row = (n: number) => thumbsRow("https://digest.example.com", `https://digest.example.com/v1/feedback?p=${n}u`, `https://digest.example.com/v1/feedback?p=${n}d`);
const email = renderEmailHtml(`# Agent Memory — Nov 3–16\n\n## 1. Mem0 adds graph memory\nWhy.${row(1)}## 2. Zep benchmark\nWhy.${row(2)}`, "Agent Memory — Nov 3–16");

test("addTalkLinks: a button under the title and a Discuss link in each story's thumbs row, in order; idempotent", async () => {
  const links = await talkLinks(KEY, "https://digest.example.com/v1/talk", "20261116-ab12", [{ n: 1 }, { n: 2 }]);
  const out = addTalkLinks(email, links);
  assert.match(out, /<\/h1>\n<p[^>]*><a href="https:\/\/digest\.example\.com\/v1\/talk\?t=[^"]+"[^>]*>🎧 Talk about this issue<\/a><\/p>/);
  const discuss = [...out.matchAll(/<a href="([^"]+)"[^>]*>🎧 Discuss<\/a>/g)].map((m) => m[1]);
  assert.deepEqual(discuss, links.stories);
  // Each Discuss link follows its own thumbs pair.
  assert.ok(out.indexOf("p=1d") < out.indexOf(links.stories[0]!) && out.indexOf(links.stories[0]!) < out.indexOf("p=2u"));
  const claims = await Promise.all(links.stories.map((l) => verifyTalkToken(KEY, new URL(l).searchParams.get("t")!)));
  assert.deepEqual(claims.map((c) => c?.i), [1, 2]);
  assert.equal(addTalkLinks(out, links), out);
  assert.equal(addTalkLinkText("# Agent Memory", links.issue), `🎧 Talk about this issue: ${links.issue}\n\n# Agent Memory`);
});

test("what the assistant gets: digest name, weekday, stories with numbers for tools, the story the link came from", () => {
  const record: DigestRecord = {
    id: "20261116-ab12",
    subject: "Agent Memory — Nov 3–16",
    sentAt: "2026-11-17T06:00:00Z",
    items: [
      { n: 1, headline: "Mem0 adds graph memory", why: "Relations between memories.", source: "mem0.ai", tags: [] },
      { n: 2, headline: "Zep's benchmark", why: "A new eval.", source: "getzep.com", tags: [] },
    ],
  };
  assert.equal(digestName(record.subject), "Agent Memory");
  const b = issueBrief(record);
  assert.equal(b.sent, "Tuesday");
  assert.deepEqual(b.stories.map((s) => s.story), [1, 2]);
  assert.equal(talkGreeting("Agent Memory", "Tuesday", 7), "Agent Memory, Tuesday's issue: 7 stories. Say go and I'll read the headlines first, or ask me about any of them.");
  assert.doesNotMatch(talkGreeting("Agent Memory", "Tuesday", 7, "Zep's benchmark"), /item|story \d|number/i);
});

test("header values are printable ASCII: dashes and quotes folded, accents stripped, length capped", () => {
  assert.equal(headerValue("Agent Memory — “Zep’s” café…"), `Agent Memory - "Zep's" cafe...`);
  assert.equal(headerValue("x".repeat(500), 10), "xxxxxxxxxx");
});

test("rebaseLinks: the issue's own links move to the public URL; article links stay", () => {
  const html = `<a href="https://other-fn.telnyxcompute.com/v1/feedback?p=1&s=x"><img src="https://other-fn.telnyxcompute.com/v1/assets/thumb-up.png"></a><a href="https://blog.example.org/v1/feedbackform">article</a>`;
  assert.equal(rebaseLinks(html, "https://digest.example.com"), `<a href="https://digest.example.com/v1/feedback?p=1&s=x"><img src="https://digest.example.com/v1/assets/thumb-up.png"></a><a href="https://blog.example.org/v1/feedbackform">article</a>`);
});

test("talk page: takes the issue out of the email it was sent as, and out of emails sent before the marks", async () => {
  const { emailBody } = await import("../src/talk-page.ts");
  const html = renderEmailHtml("# Weekly\n\n## 1. A story\n**Why it matters:** because\n", "Weekly");
  const body = emailBody(html)!;
  assert.match(body, /^<h1[^>]*>Weekly<\/h1>/);
  assert.match(body, /A story/);
  assert.doesNotMatch(body, /Telnyx Edge Compute|<td/);
  const legacy = html.replace(/<!--\/?ai-digest:issue-->\n/g, "");
  assert.equal(emailBody(legacy), body);
  assert.equal(emailBody(undefined), undefined);
});

test("talk tool limits: per issue and for the deployment, per UTC day; shared use can't overspend", () => {
  const use = { day: "", total: {}, issues: {} };
  const day1 = new Date("2026-11-23T10:00:00Z"), day2 = new Date("2026-11-24T00:00:01Z");
  for (let k = 0; k < TALK_LIMITS.issue.read_article; k++) assert.equal(countTalkTool(use, "a", "read_article", day1), undefined);
  assert.match(countTalkTool(use, "a", "read_article", day1)!, /for this issue is used up/);
  assert.equal(countTalkTool(use, "a", "search_web", day1), undefined, "each tool has its own count");
  assert.equal(countTalkTool(use, "b", "read_article", day1), undefined, "another issue has its own count");
  // The deployment-wide limit holds across issues.
  let refused: string | undefined;
  for (let k = 0; k < TALK_LIMITS.total.search_web && !refused; k++) refused = countTalkTool(use, `i${k % 9}`, "search_web", day1);
  assert.match(refused ?? countTalkTool(use, "z", "search_web", day1)!, /daily limit of web searches is used up/);
  assert.equal((use as any).total.search_web, TALK_LIMITS.total.search_web);
  // A new day starts over.
  assert.equal(countTalkTool(use, "a", "read_article", day2), undefined);
  assert.deepEqual((use as any).total, { read_article: 1 });
});

test("talk page: the issue's HTML is data, not markup; only the page's own script may run", async () => {
  const { talkPage } = await import("../src/talk-page.ts");
  const record = { id: "d1", subject: "Weekly", sentAt: "2026-11-16T08:00:00Z", items: [{ n: 1, headline: "A story", why: "w" }] } as unknown as DigestRecord;
  const body = `<h2>1. A story</h2><p>x</p><script>steal()</script><img src=x onerror="steal()"><div id="talk-data">{}</div>`;
  const res = talkPage({ token: "tok", assistantId: "a", record, body, votes: {}, autostart: false });
  const html = await res.text();
  const csp = res.headers.get("content-security-policy")!;
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce && nonce.length >= 16);
  assert.match(csp, /'strict-dynamic'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  // One script runs, with the nonce; the data block sits in <head>, ahead of anything the issue holds.
  assert.deepEqual([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]), ['<script type="application/json" id="talk-data">', `<script type="module" nonce="${nonce}">`]);
  assert.ok(html.indexOf('id="talk-data"') < html.indexOf("</head>"));
  assert.doesNotMatch(html, /<script>steal|onerror="steal/);
  assert.match(html, /<article id="issue"><\/article>/);
  const data = JSON.parse(html.match(/<script type="application\/json" id="talk-data">([\s\S]*?)<\/script>/)![1]!);
  assert.equal(data.body, body);
  // A new nonce each time.
  const again = talkPage({ token: "tok", assistantId: "a", record, body, votes: {}, autostart: false });
  assert.notEqual(again.headers.get("content-security-policy"), csp);
});

test("talk page: the page's script parses as a module (it ships as a string no other test runs)", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { talkPage } = await import("../src/talk-page.ts");
  const record = { id: "d1", subject: "Weekly", sentAt: "2026-11-16T08:00:00Z", items: [{ n: 1, headline: "A story", why: "w", entities: ["acme"], tags: ["t"] }] } as unknown as DigestRecord;
  const html = await talkPage({ token: "tok", assistantId: "a", record, body: "<h2>1. A story</h2>", votes: {}, start: 1 }).text();
  const script = html.match(/<script type="module" nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script && script.includes("function cleanHtml("), "the module script, with the sanitizer in it");
  const dir = mkdtempSync(join(tmpdir(), "talk-page-"));
  try {
    const file = join(dir, "page.mjs");
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("talk links in an issue: found, and the issue's own link is the first one", async () => {
  const links = await talkLinks(KEY, "https://digest.example.com/v1/talk", "20261116-ab12", [{ n: 1 }, { n: 2 }]);
  const out = addTalkLinks(email, links);
  assert.equal(hasTalkLinks(email), false);
  assert.equal(issueTalkLink(email), undefined);
  assert.equal(hasTalkLinks(out), true);
  assert.equal(issueTalkLink(out), links.issue);
});

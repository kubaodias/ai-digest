import { test } from "node:test";
import assert from "node:assert/strict";
import { addTalkLinkText, addTalkLinks, rebaseLinks, digestName, headerValue, issueBrief, talkLinks, talkToken, verifyTalkToken } from "../src/talk.ts";
import { talkGreeting } from "../src/talk-instructions.ts";
import type { DigestRecord } from "../src/feedback.ts";

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

const row = (n: number) =>
  `<div style="margin:14px 0 0;"><span style="vertical-align:middle;padding-right:4px;">Useful?</span><a href="https://digest.example.com/v1/feedback?p=${n}u" title="More like this"><img src="u.png" alt="More like this"></a><a href="https://digest.example.com/v1/feedback?p=${n}d" title="Less like this"><img src="d.png" alt="Less like this"></a></div>`;
const email = `<html><body><h1 style="font-size:24px;">Agent Memory — Nov 3–16</h1><h2>1. Mem0 adds graph memory</h2><p>Why.</p>${row(1)}<h2>2. Zep benchmark</h2><p>Why.</p>${row(2)}</body></html>`;

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
  const b = issueBrief(record, 2);
  assert.equal(b.sent, "Tuesday");
  assert.deepEqual(b.stories.map((s) => s.story), [1, 2]);
  assert.deepEqual(b.start_with, { story: 2, headline: "Zep's benchmark" });
  assert.equal(issueBrief(record).start_with, undefined);
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

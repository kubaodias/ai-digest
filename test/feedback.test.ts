import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addFeedbackLinks, digestItems, feedbackLink, nextVote, parseTags, preferencesFrom, thanksPage, verifyPayload, verifyView, viewLink,
  type DigestItemRecord, type FeedbackPayload, type StoredVote, type TelnyxClient,
} from "../src/feedback.ts";

const KEY = "test-key";
const BASE = "https://agent.example.com/v1/feedback";
const future = Math.floor(Date.now() / 1000) + 3600;
const params = (link: string) => new URL(link.replace(/&amp;/g, "&")).searchParams;

const DIGEST = `# AI & Software Engineering Digest — Nov 1–7, 2026

## 1. Postman's desktop app silently installed AI plugins
**Why it matters:** It wrote its own trust record for a startup hook.
**Source:** [HN](https://news.ycombinator.com/item?id=50354960) · Nov 5 · [GitHub issue](https://github.com/postmanlabs/postman-app-support/issues/14370)

## 2. OpenAI rewrote Git's backend for agent-scale concurrency
**Why it matters:** Pando is a Git-compatible backend.
**Source:** [OpenAI](https://openai.com/index/scaling-git-at-openai/) · Nov 2

![A diagram](https://images.ctfassets.net/x/y/z/a.svg)
*A diagram*

## 3. Tell HN: something
**Why it matters:** A discussion.
**Source:** [HN](https://news.ycombinator.com/item?id=1) · Nov 6

## Themes this week
- one
`;

// ── signing ──

test("links verify with the right key and fail with a wrong key, tampering or expiry", async () => {
  const link = await feedbackLink(KEY, BASE, { d: "20261107-abcd", i: 3, v: "down", e: future });
  const q = params(link);
  assert.deepEqual(await verifyPayload(KEY, q.get("p")!, q.get("s")!), { d: "20261107-abcd", i: 3, v: "down", e: future });
  assert.equal(await verifyPayload("other-key", q.get("p")!, q.get("s")!), undefined);
  assert.equal(await verifyPayload(KEY, q.get("p")!.slice(0, -2) + "AA", q.get("s")!), undefined);
  const expired = params(await feedbackLink(KEY, BASE, { d: "d", i: 1, v: "up", e: 1000 }));
  assert.equal(await verifyPayload(KEY, expired.get("p")!, expired.get("s")!), undefined);
});

test("a reason survives signing; a reason invalid for the direction is rejected", async () => {
  const ok = params(await feedbackLink(KEY, BASE, { d: "d", i: 1, v: "down", e: future, r: "entity" }));
  assert.equal((await verifyPayload(KEY, ok.get("p")!, ok.get("s")!))?.r, "entity");
  const bad = params(await feedbackLink(KEY, BASE, { d: "d", i: 1, v: "up", e: future, r: "known" }));
  assert.equal(await verifyPayload(KEY, bad.get("p")!, bad.get("s")!), undefined);
});

test("an entity index is only accepted with the entity reason and in range", async () => {
  const ok = params(await feedbackLink(KEY, BASE, { d: "d", i: 1, v: "down", e: future, r: "entity", x: 1 }));
  assert.equal((await verifyPayload(KEY, ok.get("p")!, ok.get("s")!))?.x, 1);
  for (const bad of [{ r: "topic" as const, x: 0 }, { r: "entity" as const, x: 7 }, { r: "entity" as const, x: -1 }]) {
    const q = params(await feedbackLink(KEY, BASE, { d: "d", i: 1, v: "down", e: future, ...bad }));
    assert.equal(await verifyPayload(KEY, q.get("p")!, q.get("s")!), undefined, JSON.stringify(bad));
  }
});

test("links stay short (only digest, item, vote, expiry)", async () => {
  assert.ok((await feedbackLink(KEY, BASE, { d: "20261107-abcd", i: 12, v: "down", e: future })).length < 200);
});

test("digest view links are signed per digest", async () => {
  const q = params(await viewLink(KEY, BASE, "20261107-abcd"));
  assert.ok(await verifyView(KEY, "20261107-abcd", q.get("s")!));
  assert.ok(!(await verifyView(KEY, "20261107-other", q.get("s")!)));
});

// ── parsing ──

test("digest items: numbers, summaries, article URL (non-HN first), image links ignored", () => {
  const items = digestItems(DIGEST);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.n), [1, 2, 3]);
  assert.equal(items[0]!.url, "https://github.com/postmanlabs/postman-app-support/issues/14370");
  assert.equal(items[0]!.source, "github.com");
  assert.equal(items[1]!.url, "https://openai.com/index/scaling-git-at-openai/");
  assert.equal(items[2]!.source, "news.ycombinator.com"); // only an HN link
  assert.equal(items[0]!.why, "It wrote its own trust record for a startup hook.");
});

test("tagger answers: topics and entities parsed, malformed answers become empty lists", () => {
  const good = parseTags('{"items":[{"topics":["Security","dev tooling"],"entities":["Postman"]},{"topics":["git"],"entities":[]}]}', 2);
  assert.deepEqual(good, [{ tags: ["security", "dev tooling"], entities: ["postman"] }, { tags: ["git"], entities: [] }]);
  assert.deepEqual(parseTags("not json", 2), [{ tags: [], entities: [] }, { tags: [], entities: [] }]);
  assert.deepEqual(parseTags('{"items":[{"topics":["a","b","c","d"]}]}', 1), [{ tags: ["a", "b", "c"], entities: [] }]);
});

test("addFeedbackLinks: one up and one down link per item, record carries tags and entities", async () => {
  const telnyx: TelnyxClient = {
    get: async () => ({}),
    delete: async () => ({}),
    post: async () => ({ choices: [{ message: { content: '{"items":[{"topics":["security"],"entities":["postman"]},{"topics":["git"],"entities":["openai"]},{"topics":["policy"],"entities":[]}]}' } }] }),
  };
  const { markdown, record } = await addFeedbackLinks(telnyx, KEY, BASE, "20261107-test", "Subject", DIGEST, DIGEST, [[], [{ url: "https://x/y.png", caption: "c" }], []]);
  const links = [...markdown.matchAll(/href="([^"]*feedback\?p=[^"]*)"/g)].map((m) => m[1]!);
  assert.equal(links.length, 6);
  const votes = await Promise.all(links.map(async (l) => { const q = params(l); return verifyPayload(KEY, q.get("p")!, q.get("s")!); }));
  assert.deepEqual(votes.map((v) => `${v!.i}${v!.v}`), ["1up", "1down", "2up", "2down", "3up", "3down"]);
  assert.deepEqual(record.items[0]!.entities, ["postman"]);
  assert.deepEqual(record.items[1]!.image, { url: "https://x/y.png", caption: "c" });
  assert.ok(!/Themes this week[\s\S]*Useful\?/.test(markdown), "no thumbs under the themes section");
  assert.ok(!/🖒|👍|👎/u.test(markdown), "thumbs are grey icons, not colour emoji");
});

// ── votes ──

const item: DigestItemRecord = { n: 7, headline: "Postman's desktop app", why: "w", url: "https://github.com/x", source: "github.com", tags: ["security", "dev tooling"], entities: ["postman", "codex"] };
const pay = (over: Partial<FeedbackPayload> = {}): FeedbackPayload => ({ d: "D", i: 7, v: "down", e: future, ...over });
const T = "2026-11-07T10:00:00Z";

test("first click records a vote without reasons, with the item's tags and entities", () => {
  const { vote, changed } = nextVote(undefined, pay(), item, T);
  assert.ok(changed);
  assert.equal(vote.vote, "down");
  assert.equal(vote.reasons, undefined);
  assert.deepEqual(vote.entities, ["postman", "codex"]);
  assert.deepEqual(vote.tags, ["security", "dev tooling"]);
});

test("opening the page again (same thumb) changes nothing and remembers the selected reasons", () => {
  let v = nextVote(undefined, pay(), item, T).vote;
  v = nextVote(v, pay({ r: "entity", x: 0 }), item, T).vote;
  v = nextVote(v, pay({ r: "topic" }), item, T).vote;
  const { vote, changed } = nextVote(v, pay(), item, "2026-11-08T00:00:00Z");
  assert.ok(!changed);
  assert.deepEqual(vote.reasons, [{ r: "entity", target: "postman" }, { r: "topic" }]);
});

test("reasons toggle: select several, click a selected one to deselect it", () => {
  let v = nextVote(undefined, pay(), item, T).vote;
  v = nextVote(v, pay({ r: "entity", x: 0 }), item, T).vote;
  v = nextVote(v, pay({ r: "topic" }), item, T).vote;
  v = nextVote(v, pay({ r: "known" }), item, T).vote;
  assert.equal(v.vote, "down");
  assert.deepEqual(v.reasons, [{ r: "entity", target: "postman" }, { r: "topic" }, { r: "known" }]);
  const off = nextVote(v, pay({ r: "topic" }), item, T);
  assert.ok(off.changed);
  assert.deepEqual(off.vote.reasons, [{ r: "entity", target: "postman" }, { r: "known" }]);
  const none = nextVote(nextVote(off.vote, pay({ r: "entity", x: 0 }), item, T).vote, pay({ r: "known" }), item, T);
  assert.deepEqual(none.vote.reasons, [], "all deselected: back to no reason");
});

test("'I don't use X' per entity: Postman and Codex can both be selected, and deselected separately", () => {
  let v = nextVote(undefined, pay(), item, T).vote;
  v = nextVote(v, pay({ r: "entity", x: 0 }), item, T).vote;
  v = nextVote(v, pay({ r: "entity", x: 1 }), item, T).vote;
  assert.deepEqual(v.reasons, [{ r: "entity", target: "postman" }, { r: "entity", target: "codex" }]);
  v = nextVote(v, pay({ r: "entity", x: 0 }), item, T).vote;
  assert.deepEqual(v.reasons, [{ r: "entity", target: "codex" }]);
});

test("the generic 'I don't use this product' option toggles the main entity once entities are known", () => {
  const prior: StoredVote = { ...nextVote(undefined, pay(), item, T).vote, reasons: [{ r: "entity", target: "postman" }] };
  assert.deepEqual(nextVote(prior, pay({ r: "entity" }), item, T).vote.reasons, []);
});

test("older single-reason votes are read and converted on the next toggle", () => {
  const legacy: StoredVote = { ...nextVote(undefined, pay(), item, T).vote, reason: "entity", target: "postman" };
  const { vote } = nextVote(legacy, pay({ r: "topic" }), item, T);
  assert.deepEqual(vote.reasons, [{ r: "entity", target: "postman" }, { r: "topic" }]);
  assert.equal(vote.reason, undefined);
  assert.equal(vote.target, undefined);
});

test("flipping the vote drops the reasons (they belonged to the other direction)", () => {
  const prior: StoredVote = { ...nextVote(undefined, pay(), item, T).vote, reasons: [{ r: "known" }] };
  const { vote, changed } = nextVote(prior, pay({ v: "up" }), item, T);
  assert.ok(changed);
  assert.equal(vote.vote, "up");
  assert.equal(vote.reasons, undefined);
});

test("a vote on a digest no longer stored falls back to the stored vote's details", () => {
  const prior: StoredVote = { digest: "D", item: 7, vote: "down", headline: "Old", tags: ["c++"], source: "a.com", at: T };
  const { vote } = nextVote(prior, pay({ r: "topic" }), undefined, T);
  assert.equal(vote.headline, "Old");
  assert.deepEqual(vote.tags, ["c++"]);
});

// ── thanks page ──

test("thanks page: several reasons shown selected (✓, aria-pressed), others not; no digest card or item counter", async () => {
  let vote = nextVote(undefined, pay({ r: "entity", x: 0 }), item, T).vote;
  vote = nextVote(vote, pay({ r: "known" }), item, T).vote;
  const reasons = { "entity:0": "#entity0", "entity:1": "#entity1", topic: "#topic", source: "#source", known: "#known" };
  const html = await thanksPage({ base: BASE, vote, item, prefs: preferencesFrom([vote]), links: { undo: "#undo", flip: "#flip", view: "#view", reasons } }).text();
  assert.match(html, /class="reason on" data-inplace href="#entity0" aria-pressed="true"[^>]*>✓ I don&#39;t use Postman/);
  assert.match(html, /class="reason on" data-inplace href="#known" aria-pressed="true"[^>]*>✓ I already knew this/);
  assert.match(html, /class="reason" data-inplace href="#entity1" aria-pressed="false"[^>]*>I don&#39;t use Codex/);
  assert.match(html, /class="reason" data-inplace href="#topic" aria-pressed="false"[^>]*>Not interested in security, dev tooling/);
  assert.match(html, /click one to deselect it/);
  assert.match(html, /Items mainly about postman will be skipped\. Noted as too obvious\. Its topics \(security, dev tooling\) aren&#39;t affected/);
  assert.doesNotMatch(html, /From the digest/);
  assert.doesNotMatch(html, /item \d+ of \d+/i);
  assert.match(html, /href="#view">View the digest/);
});

test("thanks page without a reason asks why and explains the weak default", async () => {
  const vote = nextVote(undefined, pay(), item, T).vote;
  const html = await thanksPage({ base: BASE, vote, item, prefs: preferencesFrom([vote]), links: { undo: "#u", flip: "#f", reasons: { "entity:0": "#e0", "entity:1": "#e1", topic: "#t", source: "#s", known: "#k" } } }).text();
  assert.match(html, /Why\? Select all that apply/);
  assert.match(html, /counts mostly toward postman/);
  assert.match(html, /not enough votes yet/);
});

test("an item with no known entities gets one generic 'I don't use this product' option", async () => {
  const bare: DigestItemRecord = { ...item, entities: [] };
  const vote = nextVote(undefined, pay(), bare, T).vote;
  const html = await thanksPage({ base: BASE, vote, item: bare, prefs: preferencesFrom([vote]), links: { undo: "#u", flip: "#f", reasons: { entity: "#e", topic: "#t", source: "#s", known: "#k" } } }).text();
  assert.match(html, /I don&#39;t use this product or company/);
});

test("👍 thanks page offers only 👍 reasons", async () => {
  const vote = nextVote(undefined, pay({ v: "up" }), item, T).vote;
  const html = await thanksPage({ base: BASE, vote, item, prefs: preferencesFrom([vote]), links: { undo: "#u", flip: "#f", reasons: { topic: "#t", "entity:0": "#e0", source: "#s" } } }).text();
  assert.match(html, /More about Postman/);
  assert.doesNotMatch(html, /already knew/);
});

test("thanks page: reason, change and undo links update in place (one Back returns to the email); article and digest links don't", async () => {
  const vote = nextVote(undefined, pay(), item, T).vote;
  const html = await thanksPage({ base: BASE, vote, item, prefs: preferencesFrom([vote]), links: { undo: "#undo", flip: "#flip", view: "#view", reasons: { "entity:0": "#e0", topic: "#t" } } }).text();
  assert.match(html, /class="reason" data-inplace href="#e0"/);
  assert.match(html, /data-inplace href="#flip"/);
  assert.match(html, /data-inplace href="#undo"/);
  assert.match(html, /<a href="#view">View the digest/);
  assert.doesNotMatch(html, /data-inplace href="https:\/\/github\.com/);
  assert.match(html, /history\.replaceState\(null, "", a\.href\)/);
  assert.match(html, /location\.replace\(a\.href\)/, "falls back to replacing the page, still without a new history entry");
});

test("thanks page order: article title, then More/Less like this, then the description, then What this feeds; footer at the bottom", async () => {
  const vote = nextVote(undefined, pay(), { ...item, why: "The description text." }, T).vote;
  const html = await thanksPage({ base: BASE, vote, item: { ...item, why: "The description text." }, prefs: preferencesFrom([vote]), links: { undo: "#u", flip: "#f", reasons: { topic: "#t" } } }).text();
  const at = (re: RegExp) => html.search(re);
  const order = [at(/<h1><a href="https:\/\/github\.com\/x">Postman/), at(/Less like this<\/h2>/), at(/The description text\./), at(/What this feeds/), at(/<footer>/)];
  assert.ok(order.every((x) => x >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sections in order");
  assert.match(html, /<footer><span>AI Digest · made with <a href="https:\/\/telnyx\.com\/products\/edge-compute">Telnyx Edge Compute<\/a><\/span><img src="https:\/\/www\.activepieces\.com\/piece-icon\/telnyx"/);
});

test("👎 options don't include 'weak source' (even if a link for it were passed); 👍 keeps 'good source'", async () => {
  const down = nextVote(undefined, pay(), item, T).vote;
  const dHtml = await thanksPage({ base: BASE, vote: down, item, prefs: preferencesFrom([down]), links: { undo: "#u", flip: "#f", reasons: { "entity:0": "#e0", topic: "#t", source: "#s", known: "#k" } } }).text();
  assert.doesNotMatch(dHtml, /weak source/);
  const up = nextVote(undefined, pay({ v: "up" }), item, T).vote;
  const uHtml = await thanksPage({ base: BASE, vote: up, item, prefs: preferencesFrom([up]), links: { undo: "#u", flip: "#f", reasons: { "entity:0": "#e0", topic: "#t", source: "#s" } } }).text();
  assert.match(uHtml, /github\.com is a good source/);
});

test("a 👎 'source' reason link is no longer accepted", async () => {
  const q = new URL((await feedbackLink(KEY, BASE, { d: "d", i: 1, v: "down", e: future, r: "source" })).replace(/&amp;/g, "&")).searchParams;
  assert.equal(await verifyPayload(KEY, q.get("p")!, q.get("s")!), undefined);
});

test("links and icons use the configured public URL, nothing hard-coded", async () => {
  const link = await feedbackLink(KEY, "https://other.example.org/v1/feedback", { d: "d", i: 1, v: "up", e: future });
  assert.ok(link.startsWith("https://other.example.org/v1/feedback?p="));
  const vote = nextVote(undefined, pay(), item, T).vote;
  const html = await thanksPage({ base: "https://other.example.org/v1/feedback", vote, item, prefs: preferencesFrom([vote]), links: { undo: "#u", flip: "#f", reasons: {} } }).text();
  assert.match(html, /src="https:\/\/other\.example\.org\/v1\/assets\/thumb-down\.png"/);
  assert.doesNotMatch(html, /telnyxcompute\.com/);
});


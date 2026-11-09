import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalUrl, decide, entryId, housekeep, mergeCandidates, parseScoutReply, rescore, sameStory, scoreEntry, slotOf, titleOverlap,
  MAX_PER_PASS, RESERVATION_MS, type Candidate, type PoolEntry, type ScoutSettings,
} from "../src/pool.ts";
import { quietNote, scoutMessage, writerMessage, SCOUT_BUDGET } from "../src/scout-instructions.ts";
import { parseProfile } from "../src/profile.ts";

const NOW = "2026-11-09T12:00:00.000Z";
const DAY = 24 * 3600 * 1000;
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();
const S: ScoutSettings = { scoutHours: 6, sendAt: 3, strong: 7, minGapDays: 2, maxGapDays: 7 };

const cand = (o: Partial<Candidate> = {}): Candidate => ({
  headline: "Acme releases Harness 2.0 with sandboxed tool calls",
  url: "https://acme.example.com/blog/harness-2",
  source: "acme.example.com",
  published: "2026-11-08",
  summary: "Acme's agent harness adds sandboxing.",
  importance: 7,
  why: "Safer tool use.",
  otherSources: [],
  primary: true,
  tags: ["agent harnesses"],
  entities: ["acme harness"],
  ...o,
});
const entry = (o: Partial<PoolEntry> = {}): PoolEntry => {
  const base = mergeCandidates([], [cand()], ago(1)).pool[0]!;
  return { ...base, score: 7, ...o };
};

// ── URLs ──

test("canonicalUrl: one article, whatever link it came with", () => {
  const c = canonicalUrl("https://www.Example.com/post/1/?utm_source=x&utm_medium=y&id=3#comments")!;
  assert.equal(c, "https://example.com/post/1?id=3");
  assert.equal(canonicalUrl("http://example.com/post/1/"), "https://example.com/post/1");
  assert.equal(canonicalUrl("https://m.example.com/post/1"), "https://example.com/post/1");
  assert.equal(canonicalUrl("https://example.com/post/1/amp"), "https://example.com/post/1");
  assert.equal(canonicalUrl("https://example.com/"), "https://example.com");
  assert.equal(canonicalUrl("ftp://example.com/x"), undefined);
  assert.equal(canonicalUrl("not a url"), undefined);
  assert.equal(entryId(c), entryId(canonicalUrl("https://example.com/post/1?id=3&fbclid=abc")!));
  assert.notEqual(entryId(c), entryId("https://example.com/post/2"));
});

test("slotOf: a short time name", () => assert.equal(slotOf("2026-11-16T06:00:00.000Z"), "2026-11-16t0600"));

// ── the scout reply ──

test("parseScoutReply: fenced JSON, validated, dates in the window, capped", () => {
  const items = [
    { headline: "Good", url: "https://a.example.com/x", importance: 12, published: "2026-11-08", otherSources: ["https://b.example.com/y", "nope"] },
    { headline: "No URL" },
    { headline: "Bad URL", url: "javascript:alert(1)" },
    { headline: "", url: "https://c.example.com/" },
    { headline: "Too old", url: "https://d.example.com/", published: "2026-10-01" },
    { headline: "No date is fine", url: "https://e.example.com/", importance: "x" },
  ];
  const text = "Here you go:\n```json\n" + JSON.stringify({ candidates: items }) + "\n```";
  const r = parseScoutReply(text, { since: "2026-11-07T00:00:00Z", until: NOW });
  assert.deepEqual(r.candidates.map((c) => c.headline), ["Good", "No date is fine"]);
  assert.equal(r.candidates[0]!.importance, 10, "clamped");
  assert.equal(r.candidates[1]!.importance, 5, "missing → 5");
  assert.deepEqual(r.candidates[0]!.otherSources, ["https://b.example.com/y"]);
  assert.equal(r.candidates[0]!.source, "a.example.com", "source from the URL when missing");
  assert.equal(r.dropped, 4);
  const many = { candidates: Array.from({ length: 30 }, (_, k) => ({ headline: `S${k}`, url: `https://x.example.com/${k}` })) };
  assert.equal(parseScoutReply(JSON.stringify(many), { since: ago(2), until: NOW }).candidates.length, MAX_PER_PASS);
  assert.deepEqual(parseScoutReply("I couldn't find anything.", { since: ago(1), until: NOW }).candidates, []);
});

// ── merging ──

test("merge: the same URL is one story; more sightings and sources", () => {
  const a = mergeCandidates([], [cand()], ago(1));
  assert.equal(a.added, 1);
  const b = mergeCandidates(a.pool, [cand({ url: "https://www.acme.example.com/blog/harness-2/?utm_source=hn", otherSources: ["https://news.example.org/acme"], importance: 8 })], NOW);
  assert.equal(b.pool.length, 1);
  assert.equal(b.merged, 1);
  const e = b.pool[0]!;
  assert.equal(e.sightings, 2);
  assert.equal(e.importance, 8, "the newer estimate");
  assert.deepEqual(e.sources.map((s) => s.domain).sort(), ["acme.example.com", "news.example.org"]);
  assert.equal(e.firstSeen, ago(1));
  assert.equal(e.lastSeen, NOW);
  assert.equal(a.pool[0]!.sightings, 1, "the input pool isn't changed");
});

test("merge: sameAs joins only when the stories plausibly match", () => {
  const pool = mergeCandidates([], [cand()], ago(1)).pool;
  const id = pool[0]!.id;
  const same = cand({ headline: "Acme's Harness 2.0 sandboxes every tool call", url: "https://press.example.net/acme-harness", sameAs: id, primary: false });
  assert.equal(mergeCandidates(pool, [same], NOW).pool.length, 1, "shares the entity");
  const wrong = cand({ headline: "Bank raises rates", url: "https://bank.example.net/rates", sameAs: id, entities: ["central bank"], primary: false });
  assert.equal(mergeCandidates(pool, [wrong], NOW).pool.length, 2, "a model mistake can't merge unrelated stories");
  assert.ok(sameStory({ headline: "OpenAI ships new Codex CLI release", entities: [] }, { headline: "New Codex CLI release ships from OpenAI", entities: [] }));
  assert.ok(titleOverlap("a b c", "x y z") === 0);
});

test("merge: a repeat of a sent story counts as a sighting but doesn't come back", () => {
  const pool = [entry({ state: "sent", sentAt: ago(1) })];
  const r = mergeCandidates(pool, [cand({ importance: 10 })], NOW);
  assert.equal(r.pool[0]!.state, "sent");
  assert.equal(r.pool[0]!.importance, 7, "a sent entry keeps its data");
});

test("merge: two candidates for one story in a pass count one sighting", () => {
  const r = mergeCandidates([], [cand(), cand({ url: "https://acme.example.com/blog/harness-2?utm_campaign=x" })], NOW);
  assert.equal(r.pool.length, 1);
  assert.equal(r.pool[0]!.sightings, 1);
});

// ── scoring ──

test("score: importance, corroboration, sightings, primary source, age", () => {
  const base = entry({ importance: 6, primary: false, sources: [{ domain: "a", url: "u" }], sightings: 1, published: NOW.slice(0, 10) });
  assert.equal(scoreEntry(base, undefined, undefined, NOW).score, 6);
  assert.equal(scoreEntry({ ...base, sources: [1, 2, 3, 4, 5].map((k) => ({ domain: `d${k}`, url: "u" })) }, undefined, undefined, NOW).score, 8, "+2 at most");
  assert.equal(scoreEntry({ ...base, sightings: 9 }, undefined, undefined, NOW).score, 7.5, "+1.5 at most");
  assert.equal(scoreEntry({ ...base, primary: true }, undefined, undefined, NOW).score, 6.5);
  assert.equal(scoreEntry({ ...base, published: "2026-10-25" }, undefined, undefined, NOW).score, 4, "−1 per full week");
  assert.equal(scoreEntry({ ...base, importance: 10, sources: [1, 2, 3].map((k) => ({ domain: `d${k}`, url: "u" })) }, undefined, undefined, NOW).score, 10, "capped at 10");
});

test("score: preferences; a product the reader doesn't use drops the story", () => {
  const e = entry({ importance: 6, primary: false, sources: [{ domain: "a", url: "u" }], published: NOW.slice(0, 10), entities: ["acme harness", "mcp"], tags: ["agent harnesses", "security"] });
  const p = (entities: any[], topics: any[] = []) => ({ entities, topics });
  assert.equal(scoreEntry(e, p([{ name: "Acme-Harness", direction: "less" }]), undefined, NOW).drop, "doesn't use Acme-Harness", "names compared loosely");
  assert.equal(scoreEntry(e, p([{ name: "mcp", direction: "less" }]), undefined, NOW).drop, undefined, "only the main entity drops a story");
  assert.equal(scoreEntry(e, undefined, { entities: [{ name: "acme harness", direction: "less" } as any] }, NOW).drop, "doesn't use acme harness", "shared 'I don't use' too");
  assert.equal(scoreEntry(e, p([{ name: "mcp", direction: "more" }]), undefined, NOW).score, 7);
  assert.equal(scoreEntry(e, undefined, { entities: [{ name: "mcp", direction: "more" } as any] }, NOW).score, 6.5);
  assert.equal(scoreEntry(e, p([], [{ name: "security", direction: "less" }, { name: "agent harnesses", direction: "more" }]), undefined, NOW).score, 6);
  const r = rescore([e], p([{ name: "acme harness", direction: "less" }]), undefined, NOW);
  assert.equal(r[0]!.state, "expired");
  assert.match(r[0]!.dropped!, /doesn't use/);
});

// ── housekeeping ──

test("housekeep: expiry by window, stale reservations return, old sent entries forgotten", () => {
  const pool = [
    entry({ id: "old", published: "2026-10-20" }),
    entry({ id: "nodate", published: undefined, firstSeen: ago(9) }),
    entry({ id: "fresh", published: "2026-11-08" }),
    entry({ id: "stale-res", state: "reserved", issue: "s", reservedAt: new Date(Date.parse(NOW) - RESERVATION_MS - 1).toISOString() }),
    entry({ id: "live-res", state: "reserved", issue: "s", reservedAt: NOW }),
    entry({ id: "ancient", state: "sent", sentAt: ago(91) }),
  ];
  const out = housekeep(pool, 7, NOW);
  const by = Object.fromEntries(out.map((e) => [e.id, e]));
  assert.equal(by.old!.state, "expired");
  assert.equal(by.nodate!.state, "expired", "no date: by first sighting");
  assert.equal(by.fresh!.state, "candidate");
  assert.equal(by["stale-res"]!.state, "candidate");
  assert.equal(by["stale-res"]!.issue, undefined);
  assert.equal(by["live-res"]!.state, "reserved");
  assert.equal(by.ancient, undefined);
});

// ── the decision ──

const live = (n: number, score: number) => Array.from({ length: n }, (_, k) => entry({ id: `s${score}-${k}`, score }));

test("decide: enough strong stories and the minimum gap → an issue of the strongest", () => {
  const d = decide([...live(3, 8), ...live(4, 5)], S, ago(3), NOW, 5);
  assert.equal(d.action, "issue");
  if (d.action !== "none") assert.deepEqual(d.ids.slice(0, 3), ["s8-0", "s8-1", "s8-2"]);
  if (d.action !== "none") assert.equal(d.ids.length, 5, "filled up to items with the next best");
});

test("decide: the minimum gap holds an issue back", () => {
  const d = decide(live(5, 9), S, ago(1), NOW, 5);
  assert.equal(d.action, "none");
  assert.match(d.reason, /less than 2 days ago/);
});

test("decide: too few strong stories → nothing yet, with the reason and the latest date", () => {
  const d = decide([...live(2, 8), ...live(5, 4)], S, ago(3), NOW, 5);
  assert.equal(d.action, "none");
  assert.equal(d.reason, "2 of 3 strong stories");
  if (d.action === "none") assert.equal(d.dueBy, new Date(Date.parse(ago(3)) + 7 * DAY).toISOString());
});

test("decide: the maximum gap sends anyway, whatever the pool holds, even nothing", () => {
  const d = decide(live(2, 4), S, ago(7), NOW, 5);
  assert.equal(d.action, "issue-anyway");
  if (d.action !== "none") assert.equal(d.ids.length, 2);
  const empty = decide([], S, ago(8), NOW, 5);
  assert.equal(empty.action, "issue-anyway");
  if (empty.action !== "none") assert.deepEqual(empty.ids, []);
});

test("decide: only live candidates count; force sends what there is", () => {
  const pool = [...live(3, 9).map((e) => ({ ...e, state: "sent" as const })), ...live(1, 9)];
  assert.equal(decide(pool, S, ago(3), NOW, 5).action, "none");
  const f = decide(pool, S, ago(0), NOW, 5, true);
  assert.equal(f.action, "issue");
  if (f.action !== "none") assert.equal(f.ids.length, 1);
});

// ── the requests ──

const profile = parseProfile("harness-watch", "---\ntitle: \"Harness Watch — {range}\"\nitems: 3-6\nscout: 6h\n---\nAgent harnesses, for engineers building agents.\n");

test("the scout request: window, budget, known stories with ids, JSON only", () => {
  const m = scoutMessage(profile, { since: "2026-11-09T05:00:00.000Z", until: NOW, known: [{ id: "abc", headline: "Known story" }] });
  assert.match(m, /^SCOUT PASS\./);
  assert.match(m, /between 2026-11-09 05:00 and 2026-11-09 12:00 UTC/);
  assert.match(m, new RegExp(`at most ${SCOUT_BUDGET} tool calls`));
  assert.match(m, /- \[abc\] Known story/);
  assert.match(m, /Agent harnesses, for engineers/);
  assert.match(m, /"candidates"/);
  assert.match(scoutMessage(profile, { since: ago(7), until: NOW, known: [] }), /first pass/);
});

test("the writer request: the stories, no search, title and items", () => {
  const e = entry({ sources: [{ domain: "acme.example.com", url: "https://acme.example.com/blog/harness-2" }, { domain: "news.example.org", url: "https://news.example.org/acme" }] });
  const m = writerMessage(profile, [e], { quiet: true, focus: "security angle" });
  assert.match(m, /^WRITE AN ISSUE FROM THESE STORIES\. Don't search the web/);
  assert.match(m, /Title: Harness Watch — <the date range the stories cover>/);
  assert.match(m, /at most 6/);
  assert.match(m, /quieter period/);
  assert.match(m, /1\. Acme releases Harness 2\.0/);
  assert.match(m, /also covered by: https:\/\/news\.example\.org\/acme/);
  assert.match(m, /For this issue in particular: security angle/);
  assert.doesNotMatch(writerMessage(profile, [e], { quiet: false }), /quieter period/);
});

test("the quiet note: title with the range, no items", () => {
  const n = quietNote(profile, "2026-11-02T08:00:00Z", NOW);
  assert.equal(n.subject, "Harness Watch — 2 November 2026 – 9 November 2026");
  assert.match(n.markdown, /Nothing new met the bar/);
  assert.doesNotMatch(n.markdown, /^## \d+\./m);
});

test("seen: known stories found again count as sightings, with new sources; unknown ids are ignored", () => {
  const pool = mergeCandidates([], [cand()], ago(1)).pool;
  const id = pool[0]!.id;
  const text = JSON.stringify({ candidates: [], seen: [{ id, sources: ["https://news.example.org/acme", "bad"] }, "unknown-id", { nope: 1 }] });
  const r = parseScoutReply(text, { since: ago(2), until: NOW });
  assert.deepEqual(r.seen, [{ id, sources: ["https://news.example.org/acme"] }, { id: "unknown-id", sources: [] }]);
  const m = mergeCandidates(pool, [], NOW, r.seen);
  assert.equal(m.resighted, 1);
  assert.equal(m.pool[0]!.sightings, 2);
  assert.deepEqual(m.pool[0]!.sources.map((s) => s.domain).sort(), ["acme.example.com", "news.example.org"]);
  const both = mergeCandidates(pool, [cand({ url: "https://acme.example.com/blog/harness-2?utm_source=x" })], NOW, [{ id, sources: [] }]);
  assert.equal(both.pool[0]!.sightings, 2, "seen and re-reported in one pass: one sighting");
  assert.match(scoutMessage(profile, { since: ago(1), until: NOW, known: [{ id: "abc", headline: "K" }] }), /under "seen"/);
});

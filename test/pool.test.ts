import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalUrl, capPerEntity, trending, FLOOR, decide, entryId, housekeep, mergeCandidates, parseCheckReply, rescore, sameStory, scoreEntry, slotOf, titleOverlap,
  MAX_PER_CHECK, RESERVATION_MS, type Candidate, type PoolEntry, type WatchSettings,
} from "../src/pool.ts";
import { formatRange, quietNote, checkMessage, spendTool, storiesRange, toolBudget, writerMessage, CHECK_BUDGET, WRITER_CHECKS } from "../src/watch-instructions.ts";
import { parseProfile } from "../src/profile.ts";

const NOW = "2026-11-09T12:00:00.000Z";
const DAY = 24 * 3600 * 1000;
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();
const S: WatchSettings = { watchHours: 6, sendAt: 3, strong: 7, minGapDays: 2, maxGapDays: 7 };

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

// ── the check reply ──

test("parseCheckReply: fenced JSON, validated, dates in the window, capped", () => {
  const items = [
    { headline: "Good", url: "https://a.example.com/x", importance: 12, published: "2026-11-08", otherSources: ["https://b.example.com/y", "nope"] },
    { headline: "No URL" },
    { headline: "Bad URL", url: "javascript:alert(1)" },
    { headline: "", url: "https://c.example.com/" },
    { headline: "Too old", url: "https://d.example.com/", published: "2026-10-01" },
    { headline: "No date is fine", url: "https://e.example.com/", importance: "x" },
  ];
  const text = "Here you go:\n```json\n" + JSON.stringify({ candidates: items }) + "\n```";
  const r = parseCheckReply(text, { since: "2026-11-07T00:00:00Z", until: NOW });
  assert.deepEqual(r.candidates.map((c) => c.headline), ["Good", "No date is fine"]);
  assert.equal(r.candidates[0]!.importance, 10, "clamped");
  assert.equal(r.candidates[1]!.importance, 5, "missing → 5");
  assert.deepEqual(r.candidates[0]!.otherSources, ["https://b.example.com/y"]);
  assert.equal(r.candidates[0]!.source, "a.example.com", "source from the URL when missing");
  assert.equal(r.dropped, 4);
  const many = { candidates: Array.from({ length: 30 }, (_, k) => ({ headline: `S${k}`, url: `https://x.example.com/${k}` })) };
  assert.equal(parseCheckReply(JSON.stringify(many), { since: ago(2), until: NOW }).candidates.length, MAX_PER_CHECK);
  assert.deepEqual(parseCheckReply("I couldn't find anything.", { since: ago(1), until: NOW }).candidates, []);
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

test("merge: two candidates for one story in a check count one sighting", () => {
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

const live = (n: number, score: number) => Array.from({ length: n }, (_, k) => entry({ id: `s${score}-${k}`, score, entities: [`product ${score}-${k}`] }));

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

const profile = parseProfile("harness-watch", "---\ntitle: \"Harness Watch — {range}\"\nitems: 3-6\nwatch: 6h\n---\nAgent harnesses, for engineers building agents.\n");

test("the check request: window, budget, known stories with ids, JSON only", () => {
  const m = checkMessage(profile, { since: "2026-11-09T05:00:00.000Z", until: NOW, known: [{ id: "abc", headline: "Known story" }] });
  assert.match(m, /^WATCH CHECK\./);
  assert.match(m, /between 2026-11-09 05:00 and 2026-11-09 12:00 UTC/);
  assert.match(m, new RegExp(`at most ${CHECK_BUDGET} tool calls`));
  assert.match(m, /- \[abc\] Known story/);
  assert.match(m, /Agent harnesses, for engineers/);
  assert.match(m, /"candidates"/);
  assert.match(checkMessage(profile, { since: ago(7), until: NOW, known: [] }), /first check/);
});

test("the writer request: the stories, no search, title and items", () => {
  const e = entry({ sources: [{ domain: "acme.example.com", url: "https://acme.example.com/blog/harness-2" }, { domain: "news.example.org", url: "https://news.example.org/acme" }] });
  const m = writerMessage(profile, [e], { quiet: true, focus: "security angle" });
  assert.match(m, /^WRITE AN ISSUE FROM THESE STORIES\. Don't search the web/);
  assert.match(m, /Title: Harness Watch — November 8, 2026 \(use it as given\)/, "the range the stories cover, computed");
  assert.match(m, /at most 6/);
  assert.match(m, /quieter period/);
  assert.match(m, /1\. Acme releases Harness 2\.0/);
  assert.match(m, /also covered by: https:\/\/news\.example\.org\/acme/);
  assert.match(m, /For this issue in particular: security angle/);
  assert.doesNotMatch(writerMessage(profile, [e], { quiet: false }), /quieter period/);
});

test("the quiet note: title with the range, no items", () => {
  const n = quietNote(profile, "2026-11-02T08:00:00Z", NOW);
  assert.equal(n.subject, "Harness Watch — November 2–9, 2026");
  assert.match(n.markdown, /Nothing new met the bar/);
  assert.doesNotMatch(n.markdown, /^## \d+\./m);
});

test("seen: known stories found again count as sightings, with new sources; unknown ids are ignored", () => {
  const pool = mergeCandidates([], [cand()], ago(1)).pool;
  const id = pool[0]!.id;
  const text = JSON.stringify({ candidates: [], seen: [{ id, sources: ["https://news.example.org/acme", "bad"] }, "unknown-id", { nope: 1 }] });
  const r = parseCheckReply(text, { since: ago(2), until: NOW });
  assert.deepEqual(r.seen, [{ id, sources: ["https://news.example.org/acme"] }, { id: "unknown-id", sources: [] }]);
  const m = mergeCandidates(pool, [], NOW, r.seen);
  assert.equal(m.resighted, 1);
  assert.equal(m.pool[0]!.sightings, 2);
  assert.deepEqual(m.pool[0]!.sources.map((s) => s.domain).sort(), ["acme.example.com", "news.example.org"]);
  const both = mergeCandidates(pool, [cand({ url: "https://acme.example.com/blog/harness-2?utm_source=x" })], NOW, [{ id, sources: [] }]);
  assert.equal(both.pool[0]!.sightings, 2, "seen and re-reported in one check: one sighting");
  assert.match(checkMessage(profile, { since: ago(1), until: NOW, known: [{ id: "abc", headline: "K" }] }), /under "seen"/);
});

// ── quality and variety ──

test("floor: forced and max_gap issues leave out weak stories, unless nothing reaches the floor", () => {
  const pool = [...live(2, 8), ...live(2, FLOOR), ...live(3, 3)];
  const f = decide(pool, S, ago(0), NOW, 10, true);
  if (f.action !== "none") assert.deepEqual(f.ids.length, 4, "only stories scoring 5+");
  const a = decide(pool, S, ago(8), NOW, 10);
  assert.equal(a.action, "issue-anyway");
  if (a.action !== "none") assert.equal(a.ids.length, 4);
  const weak = decide(live(5, 2), S, ago(8), NOW, 10);
  if (weak.action !== "none") assert.equal(weak.ids.length, 3, "nothing reaches the floor: the best three anyway");
  const t = decide([...live(3, 8), ...live(3, 4)], S, ago(3), NOW, 10);
  if (t.action !== "none") assert.equal(t.ids.length, 3, "a threshold issue isn't padded with weak stories either");
});

test("capPerEntity: at most two candidates per product per check, most important first; untagged check", () => {
  const c = (h: string, e: string[]) => ({ headline: h, entities: e });
  const r = capPerEntity([c("a", ["Claude Code"]), c("b", ["claude-code"]), c("c", ["claude code", "mcp"]), c("d", ["codex"]), c("e", []), c("f", [])]);
  assert.deepEqual(r.kept.map((x) => x.headline), ["a", "b", "d", "e", "f"]);
  assert.equal(r.capped, 1);
});

test("trending: four independent sources; being found again isn't wide coverage", () => {
  assert.equal(trending({ sources: [1, 2, 3, 4].map((k) => ({ domain: `d${k}`, url: "u" })) }), true);
  assert.equal(trending({ sources: [1, 2, 3].map((k) => ({ domain: `d${k}`, url: "u" })) }), false);
  assert.equal(trending({ sources: [{ domain: "a", url: "u" }, { domain: "b", url: "u" }] }), false);
});

test("decide: an issue has at most two stories about the same product; the rest wait", () => {
  const pool = ["claude code", "Claude Code", "claude-code", "codex", "pi"].map((e, k) => entry({ id: `p${k}`, score: 9 - k * 0.1, entities: [e] }));
  const d = decide(pool, S, ago(0), NOW, 10, true);
  if (d.action !== "none") assert.deepEqual(d.ids, ["p0", "p1", "p3", "p4"]);
});

test("the check request asks for variety and for the other outlets covering a story", () => {
  const m = checkMessage(profile, { since: ago(1), until: NOW, known: [] });
  assert.match(m, /Hacker News, Reddit/);
  assert.match(m, /at most 2 tool calls on release notes/);
  assert.match(m, /at most 2 candidates about the same product/);
  assert.match(m, /"otherSources": that's how stories everyone is talking about are recognised/);
  assert.match(m, /not link roundups, newsletters/);
  assert.match(m, /Set "url" to the maker's own page/);
});

test("the writer request: limited link checks, several sources per item, trending stories marked", () => {
  const hot = entry({ sightings: 2, sources: ["acme.example.com", "news.example.org", "blog.example.net", "forum.example.io"].map((d) => ({ domain: d, url: `https://${d}/x` })) });
  const cold = entry({ id: "cold", headline: "Quiet story", sources: [{ domain: "a.example.com", url: "https://a.example.com/x" }], sightings: 1 });
  const m = writerMessage(profile, [hot, cold], { quiet: false });
  assert.match(m, new RegExp(`fetch_page at most ${WRITER_CHECKS} times`));
  assert.match(m, /\*\*Sources:\*\* \[site\]\(url\) · \[site\]\(url\) · date/);
  assert.match(m, /trending: covered by 4 independent sources/);
  assert.equal(m.match(/trending:/g)?.length, 1, "only the trending story is marked");
  assert.match(m, /maker's own page first/);
  assert.match(m, /leave out link roundups/);
  assert.match(m, /don't call other stories widely covered/);
  assert.match(m, /Merge stories about the same product/);
  assert.match(m, /about: acme harness/);
});

test("tool budgets: checks and issues are capped in code, other runs aren't", () => {
  assert.equal(toolBudget("ai-swe--2026-11-09t1500"), undefined);
  assert.equal(toolBudget("ai-swe--pool"), undefined);
  assert.equal(toolBudget("__general--check-point-security-2026-11-09t1200"), undefined, "a one-off on a topic that starts with 'check' is no check");
  assert.equal(toolBudget("__general--issue-tracking-2026-11-09t1200"), undefined);
  const check = toolBudget("harness-test--check-2026-11-09t151355")!;
  const used = { search: 0, fetch: 0 };
  for (let k = 0; k < CHECK_BUDGET; k++) assert.equal(spendTool(check, used, k % 2 ? "/web_search" : "/web_search/contents"), undefined);
  assert.match(spendTool(check, used, "/web_search")!, /budget spent: 8 tool calls/);
  assert.equal(used.search + used.fetch, CHECK_BUDGET, "a refused call isn't counted");
  assert.equal(spendTool(check, used, "/ai/chat/completions"), undefined, "other platform calls pass");
  const issue = toolBudget("harness-test--issue-2026-11-09t1524")!;
  const u2 = { search: 0, fetch: 0 };
  assert.match(spendTool(issue, u2, "/web_search")!, /no web searches/);
  for (let k = 0; k < WRITER_CHECKS; k++) assert.equal(spendTool(issue, u2, "/web_search/contents"), undefined);
  assert.match(spendTool(issue, u2, "/web_search/contents")!, /budget spent/);
});

test("date ranges read like a title", () => {
  assert.equal(formatRange("2026-11-04", "2026-11-07"), "November 4–7, 2026");
  assert.equal(formatRange("2026-11-07", "2026-11-04"), "November 4–7, 2026");
  assert.equal(formatRange("2026-10-30", "2026-11-05"), "October 30 – November 5, 2026");
  assert.equal(formatRange("2026-12-30", "2027-01-02"), "December 30, 2026 – January 2, 2027");
  assert.equal(formatRange("2026-11-08", "2026-11-08"), "November 8, 2026");
  assert.equal(storiesRange([{ published: "2026-11-06", firstSeen: NOW }, { firstSeen: "2026-11-04T10:00:00Z" }]), "November 4–6, 2026");
  assert.equal(storiesRange([]), undefined);
});

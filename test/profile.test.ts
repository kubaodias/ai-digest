import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULTS, GENERAL_ID, ID_PATTERN, LEGACY_PROFILE, ProfileError, TOPIC_MAX, audienceOf, cleanTopic, generalProfile, isDigestId, parseProfile, profileIdOf, runConversation, runMessage } from "../src/profile.ts";
import { GENERAL_TEMPLATE } from "../src/general.ts";

const example = (name: string) => readFileSync(new URL(`../examples/digests/${name}.md`, import.meta.url), "utf8");
const file = (settings: string, body = "Memory systems for AI agents, for an engineer building agents.") => `---\n${settings}\n---\n${body}\n`;

test("the example digests parse", () => {
  const ai = parseProfile("ai-swe", example("ai-swe"));
  assert.equal(ai.title, "AI & Software Engineering Digest — {range}");
  assert.equal(ai.windowDays, 7);
  assert.deepEqual(ai.items, { min: 5, max: 15 });
  assert.equal(ai.closing, "Themes this week");
  assert.match(ai.description, /Hacker News/);
  const mem = parseProfile("agent-memory", example("agent-memory"));
  assert.equal(mem.windowDays, 14);
  assert.deepEqual(mem.items, { min: 5, max: 10 });
  assert.equal(mem.closing, "Takeaways");
  assert.deepEqual(mem.to, []);
});

test("only title and description are required; the rest defaults", () => {
  const p = parseProfile("x", file(`title: Weekly`));
  assert.equal(p.windowDays, DEFAULTS.windowDays);
  assert.deepEqual(p.items, DEFAULTS.items);
  assert.equal(p.closing, DEFAULTS.closing);
  assert.equal(p.images, true);
  assert.equal(p.watch, undefined, "no watching unless asked");
});

test("settings: quotes, comments, closing none, images off, recipients", () => {
  const p = parseProfile("x", file(`title: "Q — {range}"   # subject\n# a comment line\nclosing: none\nimages: off\nto: a@example.com, b@example.org\nitems: 3`));
  assert.equal(p.title, "Q — {range}");
  assert.equal(p.closing, null);
  assert.equal(p.images, false);
  assert.deepEqual(p.to, ["a@example.com", "b@example.org"]);
  assert.deepEqual(p.items, { min: 3, max: 3 });
});

test("mistakes are named precisely", () => {
  const err = (id: string, md: string) => {
    try {
      parseProfile(id, md);
    } catch (e) {
      assert.ok(e instanceof ProfileError);
      return (e as Error).message;
    }
    assert.fail("expected an error");
  };
  assert.match(err("Bad_Name", file("title: x")), /file name/);
  assert.match(err("a--b", file("title: x")), /file name/);
  assert.match(err("x", "no settings block"), /settings block/);
  assert.match(err("x", file("window: 7d")), /"title" is required/);
  assert.match(err("x", file("title: x", "")), /describe the digest/);
  assert.match(err("x", file("title: x\nwindow: 2 weeks")), /"window"/);
  assert.match(err("x", file("title: x\nitems: 10-5")), /"items"/);
  assert.match(err("x", file("title: x\nto: not-an-email")), /invalid address/);
  assert.match(err("x", file("title: x\ncolour: blue")), /unknown setting "colour"/);
  assert.match(err("x", file("title: x\nschedule: whenever")), /"schedule" was replaced by "watch"/);
});

test("conversation names carry the digest", () => {
  assert.equal(runConversation("agent-memory", "2026-11-07t2155"), "agent-memory--2026-11-07t2155");
  assert.equal(profileIdOf("agent-memory--2026-11-07t2155"), "agent-memory");
  assert.equal(profileIdOf("digest-auto-1"), undefined, "older conversations have no digest");
  assert.equal(profileIdOf("feedback"), undefined);
  assert.equal(profileIdOf(undefined), undefined);
  assert.equal(profileIdOf(`${GENERAL_ID}--agent-harnesses-2026-11-09t0712`), GENERAL_ID, "General runs aren't mistaken for the legacy digest");
  assert.equal(profileIdOf("_general--x"), undefined);
  assert.equal(LEGACY_PROFILE, "ai-swe");
});

test("the run message carries the definition and the issue's focus", () => {
  const p = parseProfile("agent-memory", example("agent-memory"));
  const m = runMessage(p, "anything about MCP memory servers");
  assert.match(m, /Title: Agent Memory — <the date range you cover>/);
  assert.match(m, /Time window: the last 14 days\./);
  assert.match(m, /Items: 5–10, most important first/);
  assert.match(m, /Closing section: "## Takeaways"/);
  assert.match(m, /Memory systems for AI agents/);
  assert.match(m, /For this issue in particular: anything about MCP memory servers/);
  assert.match(runMessage({ ...p, closing: null }), /Closing section: none\./);
  assert.doesNotMatch(runMessage(p), /For this issue/);
});

test("the audience for picture judging is the description's first sentence", () => {
  const p = parseProfile("agent-memory", example("agent-memory"));
  assert.match(audienceOf(p), /^Memory systems for AI agents, for an engineer building agents/);
  assert.match(audienceOf(undefined), /software engineer/);
});

test("the General digest: the built-in id can't be a file name", () => {
  assert.equal(GENERAL_ID, "__general");
  assert.equal(ID_PATTERN.test(GENERAL_ID), false);
  assert.throws(() => parseProfile(GENERAL_ID, GENERAL_TEMPLATE), /lowercase letters/);
  assert.equal(isDigestId(GENERAL_ID), true);
  assert.equal(isDigestId("ai-swe"), true);
  assert.equal(isDigestId("_x"), false);
});

test("the General digest: the template with {topic} filled in, defaults and overrides", () => {
  const p = generalProfile("agent harnesses");
  assert.equal(p.id, GENERAL_ID);
  assert.equal(p.topic, "agent harnesses");
  assert.equal(p.title, "Agent harnesses — {range}");
  assert.match(p.description, /^The reader would like to get information about agent harnesses:/);
  assert.doesNotMatch(p.description + p.title, /\{topic\}/);
  assert.deepEqual([p.windowDays, p.items], [7, { min: 5, max: 10 }]);
  assert.deepEqual(p.to, [], "default recipients");
  const o = generalProfile("x", { window: "14d", items: "3-5" });
  assert.deepEqual([o.windowDays, o.items], [14, { min: 3, max: 5 }]);
  assert.equal(generalProfile("x", { window: 21 }).windowDays, 21, "a number of days works too");
  assert.throws(() => generalProfile("x", { window: "100d" }), /"window"/);
  assert.throws(() => generalProfile("x", { items: "9-3" }), /"items"/);
});

test("the General digest: topics are cleaned to one line and limited", () => {
  assert.equal(cleanTopic("  agent\n\tharnesses\u2028 now "), "agent harnesses now");
  assert.throws(() => cleanTopic(""), /give a topic/);
  assert.throws(() => cleanTopic(undefined), /give a topic/);
  assert.throws(() => cleanTopic("x".repeat(TOPIC_MAX + 1)), /under 200/);
  const p = generalProfile("agents\nto: someone@example.com\nimages: off");
  assert.deepEqual(p.to, []);
  assert.equal(p.images, true);
  assert.equal(p.topic, "agents to: someone@example.com images: off");
  assert.match(runMessage(p), /information about agents to: someone@example\.com images: off:/);
});

test("watching settings: defaults, ranges, and they need watch", () => {
  const err = (id: string, md: string) => {
    try {
      parseProfile(id, md);
    } catch (e) {
      return (e as Error).message;
    }
    return assert.fail("expected an error");
  };
  const d = parseProfile("x", file("title: x\nitems: 4-9\nwatch: 6h"));
  assert.deepEqual(d.watch, { watchHours: 6, sendAt: 4, strong: 7, minGapDays: 2, maxGapDays: 7 }, "send_at defaults to the lower bound of items");
  const c = parseProfile("x", file("title: x\nwatch: 12\nsend_at: 3\nstrong: 8\nmin_gap: 0d\nmax_gap: 3d"));
  assert.deepEqual(c.watch, { watchHours: 12, sendAt: 3, strong: 8, minGapDays: 0, maxGapDays: 3 });
  assert.equal(parseProfile("x", file("title: x\nwatch: off")).watch, undefined);
  assert.match(err("x", file("title: x\nwatch: 0h")), /"watch" must be 1h–24h/);
  assert.match(err("x", file("title: x\nwatch: 25h")), /"watch" must be 1h–24h/);
  assert.match(err("x", file("title: x\nwatch: 6h\nstrong: 11")), /"strong" must be 1–10/);
  assert.match(err("x", file("title: x\nwatch: 6h\nmin_gap: 5d\nmax_gap: 2d")), /"max_gap" must be at least "min_gap"/);
  assert.match(err("x", file("title: x\nsend_at: 4")), /"send_at" needs "watch"/);
});

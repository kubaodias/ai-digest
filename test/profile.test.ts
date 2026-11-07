import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULTS, LEGACY_PROFILE, ProfileError, audienceOf, parseProfile, profileIdOf, runConversation, runMessage } from "../src/profile.ts";

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
  assert.equal(p.schedule, undefined);
});

test("settings: quotes, comments, closing none, images off, recipients", () => {
  const p = parseProfile("x", file(`title: "Q — {range}"   # subject\n# a comment line\nclosing: none\nimages: off\nto: a@example.com, b@example.org\nschedule: "Thu 08:00 Europe/Warsaw"\nitems: 3`));
  assert.equal(p.title, "Q — {range}");
  assert.equal(p.closing, null);
  assert.equal(p.images, false);
  assert.deepEqual(p.to, ["a@example.com", "b@example.org"]);
  assert.equal(p.schedule, "Thu 08:00 Europe/Warsaw");
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
  assert.match(err("x", file("title: x\nschedule: whenever")), /"schedule"/);
});

test("conversation names carry the digest", () => {
  assert.equal(runConversation("agent-memory", "2026-11-07t2155"), "agent-memory--2026-11-07t2155");
  assert.equal(profileIdOf("agent-memory--2026-11-07t2155"), "agent-memory");
  assert.equal(profileIdOf("digest-auto-1"), undefined, "older conversations have no digest");
  assert.equal(profileIdOf("feedback"), undefined);
  assert.equal(profileIdOf(undefined), undefined);
  assert.equal(LEGACY_PROFILE, "ai-swe");
});

test("the run message carries the definition and the issue's focus", () => {
  const p = parseProfile("agent-memory", example("agent-memory"));
  const m = runMessage(p, "anything about MCP memory servers");
  assert.match(m, /Title: Agent Memory Weekly — <the date range you cover>/);
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

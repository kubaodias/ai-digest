import { test } from "node:test";
import assert from "node:assert/strict";
import { computePreferences, memorySentence, reasonLabel, selectionsOf, toggleSelection, validReason, type VoteLike } from "../src/preferences.ts";

const postman: VoteLike = {
  vote: "down",
  headline: "Postman's desktop app silently installed AI plugins into Codex and Claude Code",
  tags: ["security", "dev tooling"],
  entities: ["postman", "codex", "claude code"],
  source: "github.com",
  at: "2026-11-07T09:44:00Z",
};
const names = (list: { name: string }[]) => list.map((p) => p.name);

test("the Postman case: 👎 with 'I don't use Postman' applies to Postman only, not to its topics or other entities", () => {
  const p = computePreferences([{ ...postman, reason: "entity", target: "postman" }]);
  assert.deepEqual(names(p.entities), ["postman"]);
  assert.equal(p.entities[0]!.direction, "less");
  assert.deepEqual(p.topics, []);
  assert.deepEqual(p.tentativeTopics, []);
  assert.deepEqual(p.sources, []);
});

test("one 👎 without a reason: counts against the main entity only, topics stay tentative", () => {
  const p = computePreferences([postman]);
  assert.deepEqual(names(p.entities), ["postman"], "Codex and Claude Code are mentioned, not the subject");
  assert.deepEqual(p.topics, []);
  assert.deepEqual(names(p.tentativeTopics).sort(), ["dev tooling", "security"]);
});

test("a topic needs three same-way votes without a reason before it counts", () => {
  const funding = (n: number): VoteLike => ({ vote: "down", headline: `IPO ${n}`, tags: ["funding"], entities: [`company${n}`], source: "cnbc.com", at: `2026-11-0${n}T00:00:00Z` });
  assert.deepEqual(computePreferences([funding(1), funding(2)]).topics, []);
  const p = computePreferences([funding(1), funding(2), funding(3)]);
  assert.deepEqual(names(p.topics), ["funding"]);
  assert.equal(p.topics[0]!.direction, "less");
});

test("'I don't use Codex' on the same item applies to Codex, not Postman", () => {
  const p = computePreferences([{ ...postman, reason: "entity", target: "codex" }]);
  assert.deepEqual(names(p.entities), ["codex"]);
});

test("an entity reason without a target means the main entity", () => {
  assert.deepEqual(names(computePreferences([{ ...postman, reason: "entity" }]).entities), ["postman"]);
});

test("one explicit topic reason is enough for a topic", () => {
  const p = computePreferences([{ ...postman, reason: "topic" }]);
  assert.deepEqual(names(p.topics).sort(), ["dev tooling", "security"]);
  // a topic reason still nudges the entity a little, below the entity threshold
  assert.deepEqual(p.entities, []);
});

test("'already knew this' changes no preference", () => {
  const p = computePreferences([{ ...postman, reason: "known" }]);
  assert.deepEqual(p.entities, []);
  assert.deepEqual(p.topics, []);
  assert.deepEqual(p.tentativeTopics, []);
  assert.deepEqual(p.alreadyKnown, [postman.headline]);
});

test("a source reason applies to the source domain only", () => {
  const p = computePreferences([{ ...postman, reason: "source", source: "stocktitan.net" }]);
  assert.deepEqual(names(p.sources), ["stocktitan.net"]);
  assert.deepEqual(p.entities, []);
  assert.deepEqual(p.topics, []);
});

test("opposite votes on the same topic cancel out", () => {
  const up: VoteLike = { ...postman, vote: "up", entities: ["kimi"], reason: "topic" };
  const down: VoteLike = { ...postman, entities: ["postman"], reason: "topic" };
  const p = computePreferences([up, down]);
  assert.deepEqual(p.topics, []);
});

test("👍 with 'more about this company' makes a positive entity preference", () => {
  const p = computePreferences([{ vote: "up", headline: "Kimi K3.1 Pro weights", tags: ["open-weight models"], entities: ["kimi k3.1"], source: "huggingface.co", reason: "entity", at: "2026-11-07T00:00:00Z" }]);
  assert.equal(p.entities[0]!.name, "kimi k3.1");
  assert.equal(p.entities[0]!.direction, "more");
});

test("votes recorded before entities existed still work (no entities field)", () => {
  const old: VoteLike = { vote: "down", headline: "C++26 draft rejected", tags: ["c++", "standards"], source: "andreasfertig.com", at: "2026-11-07T09:44:19Z" };
  const p = computePreferences([old]);
  assert.deepEqual(p.entities, []);
  assert.deepEqual(names(p.tentativeTopics).sort(), ["c++", "standards"]);
});

test("recent votes are newest first and list their reasons", () => {
  const p = computePreferences([
    { ...postman, at: "2026-11-01T00:00:00Z" },
    { ...postman, headline: "newer", reasons: [{ r: "entity", target: "postman" }, { r: "known" }], at: "2026-11-05T00:00:00Z" },
  ]);
  assert.equal(p.recent[0]!.headline, "newer");
  assert.deepEqual(p.recent[0]!.reasons, ["entity:postman", "known"]);
  assert.deepEqual(p.recent[1]!.reasons, []);
});

test("several reasons on one vote: each applies, nothing counted twice", () => {
  const p = computePreferences([{ ...postman, reasons: [{ r: "entity", target: "postman" }, { r: "topic" }] }]);
  assert.deepEqual(names(p.entities), ["postman"]);
  assert.equal(p.entities[0]!.score, -1, "entity reason (1) and topic reason's nudge (0.3) don't add up");
  assert.deepEqual(names(p.topics).sort(), ["dev tooling", "security"]);
});

test("'I don't use Postman' and 'I don't use Codex' together: both entities, still not the topics", () => {
  const p = computePreferences([{ ...postman, reasons: [{ r: "entity", target: "postman" }, { r: "entity", target: "codex" }] }]);
  assert.deepEqual(names(p.entities).sort(), ["codex", "postman"]);
  assert.deepEqual(p.topics, []);
  assert.deepEqual(p.tentativeTopics, []);
});

test("'already knew this' with another reason: the other reason still applies", () => {
  const p = computePreferences([{ ...postman, reasons: [{ r: "known" }, { r: "source" }] }]);
  assert.deepEqual(names(p.sources), ["github.com"]);
  assert.deepEqual(p.alreadyKnown, [postman.headline]);
});

test("an empty reason list (all deselected) counts like no reason", () => {
  const a = computePreferences([{ ...postman, reasons: [] }]);
  const b = computePreferences([postman]);
  assert.deepEqual(a.entities, b.entities);
  assert.deepEqual(a.tentativeTopics, b.tentativeTopics);
});

test("selection helpers: legacy single reason read as a list; toggle adds and removes", () => {
  assert.deepEqual(selectionsOf({ reason: "entity", target: "postman" }), [{ r: "entity", target: "postman" }]);
  assert.deepEqual(selectionsOf({}), []);
  const one = toggleSelection([], { r: "topic" });
  assert.deepEqual(one, [{ r: "topic" }]);
  assert.deepEqual(toggleSelection(one, { r: "topic" }), []);
  assert.deepEqual(toggleSelection([{ r: "entity", target: "a" }], { r: "entity", target: "b" }), [{ r: "entity", target: "a" }, { r: "entity", target: "b" }]);
});

test("memory gets one sentence per selected reason", () => {
  const m = memorySentence({ ...postman, reasons: [{ r: "entity", target: "postman" }, { r: "topic" }] });
  assert.match(m, /I don't use Postman/);
  assert.match(m, /not interested in security, dev tooling/);
});

test("reasons are validated per direction", () => {
  assert.ok(validReason("down", "known"));
  assert.ok(!validReason("down", "source"), "no 'weak source' option");
  assert.ok(validReason("up", "source"));
  assert.ok(!validReason("up", "known"));
  assert.ok(validReason("up", "topic"));
  assert.ok(!validReason("down", "bogus"));
  assert.ok(!validReason("down", undefined));
});

test("memory sentences say where the vote applies", () => {
  const entity = memorySentence({ ...postman, reason: "entity", target: "postman" });
  assert.match(entity, /^Digest feedback: I don't use Postman — skip news mainly about Postman \(from /, "only the chosen entity, not Codex or Claude Code");
  assert.match(memorySentence({ ...postman, reason: "entity", target: "codex" }), /I don't use Codex/);
  assert.match(entity, /I don't use Postman/);
  assert.match(entity, /nothing about the wider topic/);
  assert.doesNotMatch(entity, /security|dev tooling/);
  assert.match(memorySentence({ ...postman, reason: "topic" }), /not interested in security, dev tooling/);
  assert.match(memorySentence({ ...postman, reason: "known" }), /already knew/);
  assert.match(memorySentence({ ...postman, reason: "source" }), /github\.com a weak source/);
  assert.match(memorySentence(postman), /don't assume I dislike its topics/);
  assert.match(memorySentence({ ...postman, vote: "up", reason: "entity", target: "postman" }), /more news about Postman\b/);
  assert.match(memorySentence({ ...postman, entities: [], reason: "entity" }), /the product or company in "Postman's/);
});

test("reason labels name the entity, topics and source", () => {
  assert.equal(reasonLabel("down", "entity", ["postman"], ["security"], "github.com"), "I don't use Postman");
  assert.equal(reasonLabel("down", "topic", ["postman"], ["security", "dev tooling"], "github.com"), "Not interested in security, dev tooling");
  assert.equal(reasonLabel("up", "source", [], [], "go.dev"), "go.dev is a good source");
  assert.equal(reasonLabel("down", "entity", [], [], ""), "I don't use this product or company");
});

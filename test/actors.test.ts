import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { AiDigest } from "../src/agent.ts";
import { DIGESTS_CONVERSATION, FEEDBACK_CONVERSATION, poolConversation } from "../src/actors.ts";
import { profileIdOf } from "../src/profile.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const files = readdirSync(new URL("../src/", import.meta.url)).filter((f) => f.endsWith(".ts"));

// Scans the sources for schedule(…, "name") and later(…, "name") calls: a task whose method name isn't a
// string literal right there (or whose delay argument has a comma) isn't seen, so keep calls in that form.
test("every method a task is scheduled for exists on AiDigest (the runtime calls it by name)", () => {
  const names = new Set(files.flatMap((f) => [...src(f).matchAll(/\b(?:schedule|later)\(\s*[^,]+,\s*"(\w+)"/g)].map((m) => m[1]!)));
  assert.ok(names.size >= 6, `found ${[...names].join(", ")}`);
  for (const n of names) assert.equal(typeof (AiDigest.prototype as any)[n], "function", `${n} is scheduled but AiDigest has no such method`);
});

test("actor names: the service actors aren't digests; a pool belongs to its digest", () => {
  assert.equal(FEEDBACK_CONVERSATION, "feedback");
  assert.equal(DIGESTS_CONVERSATION, "digests");
  assert.equal(profileIdOf(poolConversation("agent-memory")), "agent-memory");
});

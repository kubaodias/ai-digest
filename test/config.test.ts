import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseRecipients } from "../src/config.ts";
import { feedbackBase } from "../src/feedback.ts";

const env = (values: Record<string, string>) => ({ SECRETS: { get: async (k: string) => values[k] ?? "" } }) as any;

test("all settings come from secrets", async () => {
  const { config, missing } = await loadConfig(env({
    DIGEST_EMAIL_FROM: "digest@example.com",
    DIGEST_EMAIL_TO: "you@example.com, team@example.org",
    PUBLIC_URL: "https://ai-digest-abcd1234-a.telnyxcompute.com/",
  }));
  assert.deepEqual(missing, []);
  assert.deepEqual(config, {
    emailFrom: "digest@example.com",
    emailTo: ["you@example.com", "team@example.org"],
    publicUrl: "https://ai-digest-abcd1234-a.telnyxcompute.com",
  });
});

test("missing secrets are named, so the log says what to add", async () => {
  const { config, missing } = await loadConfig(env({ DIGEST_EMAIL_FROM: "digest@example.com" }));
  assert.equal(config, undefined);
  assert.deepEqual(missing, ["DIGEST_EMAIL_TO", "PUBLIC_URL"]);
  assert.deepEqual((await loadConfig({} as any)).missing, ["DIGEST_EMAIL_FROM", "DIGEST_EMAIL_TO", "PUBLIC_URL"]);
});

test("recipients: separated by commas, semicolons or spaces; invalid entries dropped", () => {
  assert.deepEqual(parseRecipients("a@example.com; b@example.com c@example.com,not-an-email"), ["a@example.com", "b@example.com", "c@example.com"]);
  assert.deepEqual(parseRecipients(undefined), []);
});

test("the feedback URL is built from the public URL", () => {
  assert.equal(feedbackBase("https://agent.example.com/"), "https://agent.example.com/v1/feedback");
});

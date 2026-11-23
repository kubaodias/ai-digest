import { test } from "node:test";
import assert from "node:assert/strict";
import { sendDigestEmail } from "../src/delivery.ts";
import { ISSUE_START } from "../src/email.ts";

const MARKDOWN = "# Weekly — Nov 3\n\n## 1. A story\n**Why it matters:** because.\n**Source:** [Blog](https://blog.example.org/a)\n\n## 2. Another\n**Why it matters:** also.\n";

/** A deployment: its secrets, the Telnyx API (tagging and email) and the feedback actor. */
function deployment(secrets: Record<string, string>, opts: { failEmail?: boolean } = {}) {
  const posts: { path: string; body: any }[] = [];
  const registered: any[] = [];
  const env: any = {
    SECRETS: { get: async (n: string) => secrets[n] ?? "" },
    TELNYX: {
      post: async (path: string, { body }: any) => {
        posts.push({ path, body });
        if (path === "/ai/chat/completions") return { choices: [{ message: { content: JSON.stringify([{ tags: ["memory"], entities: ["acme"] }, { tags: ["evals"], entities: [] }]) } }] };
        if (path === "/emails") {
          if (opts.failEmail) throw new Error("422 sender not verified");
          return { data: { id: "em-1", status: "queued" } };
        }
        throw new Error(`unexpected ${path}`);
      },
    },
    AI_DIGEST: { idFromName: (name: string) => (name === "feedback" ? { registerDigest: async (r: any) => void registered.push(r) } : assert.fail(name)) },
  };
  return { env, posts, registered };
}

const SECRETS = { DIGEST_EMAIL_FROM: "digest@example.com", DIGEST_EMAIL_TO: "reader@example.com", PUBLIC_URL: "https://digest.example.com", FEEDBACK_KEY: "k" };

test("sendDigestEmail: thumbs and talk links, one email to the digest's recipients, the issue registered with what was sent", async () => {
  const { env, posts, registered } = deployment({ ...SECRETS, TALK_ASSISTANT_ID: "asst" });
  const profile: any = { images: false, to: ["team@example.com"] };
  const r: any = await sendDigestEmail(env, { subject: "Weekly — Nov 3", markdown: MARKDOWN, profileId: "weekly", profile });
  assert.equal(r.ok, true);
  assert.equal(r.id, "em-1");
  assert.equal(r.feedbackItems, 2);
  const emails = posts.filter((p) => p.path === "/emails");
  assert.equal(emails.length, 1);
  const mail = emails[0]!.body;
  assert.deepEqual(Object.keys(mail).sort(), ["from", "html_body", "subject", "text_body", "to"]);
  assert.equal(mail.from, "digest@example.com");
  assert.deepEqual(mail.to, ["team@example.com"]);
  assert.ok(mail.html_body.includes(ISSUE_START));
  assert.equal((mail.html_body.match(/\/v1\/feedback\?p=/g) ?? []).length, 4, "👍 and 👎 per story");
  assert.match(mail.html_body, /🎧 Talk about this issue/);
  assert.match(mail.text_body, /^🎧 Talk about this issue: https:\/\/digest\.example\.com\/v1\/talk\?t=/);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, r.digestId);
  assert.equal(registered[0].profile, "weekly");
  assert.equal(registered[0].html, mail.html_body);
});

test("sendDigestEmail: without the assistant no talk links; without the key no thumbs and nothing registered", async () => {
  const noTalk = deployment(SECRETS);
  await sendDigestEmail(noTalk.env, { subject: "Weekly", markdown: MARKDOWN, profileId: "weekly", profile: { images: false, to: [] } as any });
  const mail = noTalk.posts.find((p) => p.path === "/emails")!.body;
  assert.deepEqual(mail.to, ["reader@example.com"], "DIGEST_EMAIL_TO when the digest names none");
  assert.doesNotMatch(mail.html_body + mail.text_body, /\/v1\/talk/);
  assert.equal(noTalk.registered.length, 1);

  const { FEEDBACK_KEY: _, ...noKey } = SECRETS;
  const plain = deployment({ ...noKey, TALK_ASSISTANT_ID: "asst" });
  const r: any = await sendDigestEmail(plain.env, { subject: "Weekly", markdown: MARKDOWN, profileId: "weekly", profile: { images: false, to: [] } as any });
  assert.equal(r.ok, true);
  const body = plain.posts.find((p) => p.path === "/emails")!.body;
  assert.doesNotMatch(body.html_body, /\/v1\/(feedback|talk)/);
  assert.equal(plain.registered.length, 0);
});

test("sendDigestEmail: a refused email is reported, not registered; missing secrets send nothing", async () => {
  const failing = deployment(SECRETS, { failEmail: true });
  const r: any = await sendDigestEmail(failing.env, { subject: "Weekly", markdown: MARKDOWN, profileId: "weekly", profile: { images: false, to: [] } as any });
  assert.deepEqual(r, { ok: false, error: "422 sender not verified" });
  assert.equal(failing.registered.length, 0);

  const missing = deployment({ PUBLIC_URL: "https://digest.example.com" });
  const m: any = await sendDigestEmail(missing.env, { subject: "Weekly", markdown: MARKDOWN, profileId: "weekly" });
  assert.equal(m.ok, false);
  assert.match(m.error, /DIGEST_EMAIL_FROM, DIGEST_EMAIL_TO/);
  assert.equal(missing.posts.length, 0);
});

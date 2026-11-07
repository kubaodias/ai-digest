import { test } from "node:test";
import assert from "node:assert/strict";
import { digestFromReply } from "../src/digest.ts";
import { renderEmailHtml } from "../src/agent.ts";

test("a reply with numbered items is a digest; subject from the title", () => {
  const d = digestFromReply("# AI & Software Engineering Digest — Nov 1–7, 2026\n\n## 1. Something\n**Why it matters:** x\n");
  assert.equal(d?.subject, "AI & Software Engineering Digest — Nov 1–7, 2026");
});

test("answers, errors and questions are not emailed", () => {
  assert.equal(digestFromReply("Hello! How can I help?"), undefined);
  assert.equal(digestFromReply("## Themes this week\n- a"), undefined);
  assert.equal(digestFromReply("I couldn't find anything this week."), undefined);
  assert.equal(digestFromReply(""), undefined);
});

test("a digest without a title gets the default subject", () => {
  assert.equal(digestFromReply("## 1. Item\ntext")?.subject, "AI & Software Engineering Digest");
});

test("email: images become captioned blocks with one style attribute; footer is one short line with the Telnyx mark", () => {
  const html = renderEmailHtml("# T\n\n## 1. X\n**Why it matters:** y\n\n![A cap](https://go.dev/a.png)\n*A cap*\n", "T");
  const imgs = html.match(/<img[^>]*>/g) ?? [];
  assert.ok(imgs.every((t) => (t.match(/style=/g) ?? []).length === 1), "no duplicate style attributes");
  assert.match(html, /<img width="600" src="https:\/\/go\.dev\/a\.png"/);
  assert.match(html, /AI Digest · made with <a href="https:\/\/telnyx\.com\/products\/edge-compute"[^>]*>Telnyx Edge Compute<\/a><\/span><img src="https:\/\/www\.activepieces\.com\/piece-icon\/telnyx"/);
  assert.doesNotMatch(html, /Delivered by/);
  assert.doesNotMatch(html, /👍|👎/u);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { digestSections, dimensions, distinctImages, extractCandidates, imageKey, rasterUrl, stableUrl } from "../src/images.ts";

test("imageKey: one picture at any size is one key; different pictures stay apart", () => {
  const base = "https://static.example.com/story-media/123/HWbLl";
  assert.equal(imageKey(`${base}-medium.jpg`), imageKey(`${base}-small.jpg`));
  assert.equal(imageKey("https://example.com/a/chart-1024x576.png"), imageKey("https://example.com/a/chart.png?w=600"));
  assert.equal(imageKey("https://example.com/a/chart@2x.png"), imageKey("https://example.com/a/chart.png"));
  assert.notEqual(imageKey("https://example.com/a/diagram1.png"), imageKey("https://example.com/a/diagram2.png"));
  assert.notEqual(imageKey("https://example.com/a/chart.png"), imageKey("https://example.com/b/chart.png"));
  const picked = distinctImages([{ url: `${base}-medium.jpg` }, { url: `${base}-small.jpg` }, { url: "https://example.com/a/other.png" }]);
  assert.deepEqual(picked.map((p) => p.url), [`${base}-medium.jpg`, "https://example.com/a/other.png"]);
});

test("an OpenAI-style page: described figures first (SVGs rasterized), teaser cards later, og image last", () => {
  const html = `<html><head><meta property="og:image" content="https://images.ctfassets.net/k/og/banner.png"></head><body>
<article><p>tiny teaser article that is short</p></article>
<article>${"x".repeat(3000)}
  <figure><img alt="The branch refs/heads/main points to commit C2, whose parent is C1." width="601" height="470" srcSet="https://images.ctfassets.net/k/a/b/how-git-objects.svg?w=640&amp;q=90 640w, https://images.ctfassets.net/k/a/b/how-git-objects.svg?w=1080&amp;q=90 1080w"></figure>
  <figure aria-label="Pushing and Fetching a Branch in Pando"><svg></svg></figure>
  <img src="https://images.ctfassets.net/k/c/d/related.png" alt="Rethinking the ad stack — Art card image">
  <img src="https://images.ctfassets.net/k/e/f/chart.png" alt="Median push latency dropped about five times after the rollout" width="800">
  <img src="https://example.com/logo.png" alt="Company">
  <img src="https://example.com/inline.png">
</article></body></html>`;
  const c = extractCandidates(html, "https://openai.com/index/scaling-git-at-openai/");
  assert.equal(c[0]!.origin, "figure");
  assert.equal(c[0]!.url, "https://images.ctfassets.net/k/a/b/how-git-objects.svg?fm=png&w=1200");
  assert.equal(c[1]!.url, "https://images.ctfassets.net/k/e/f/chart.png");
  assert.ok(!c.some((x) => /related\.png/.test(x.url)), "teaser 'card image' skipped");
  assert.ok(!c.some((x) => /logo/.test(x.url)), "logos skipped");
  assert.equal(c.at(-1)!.origin, "og");
});

test("SVGs: Contentful ones become PNG, others are dropped; non-SVG unchanged", () => {
  assert.equal(rasterUrl("https://images.ctfassets.net/a/b/c/d.svg?w=640&q=90"), "https://images.ctfassets.net/a/b/c/d.svg?fm=png&w=1200");
  assert.equal(rasterUrl("https://example.com/diagram.svg"), undefined);
  assert.equal(rasterUrl("https://example.com/photo.jpg?w=1"), "https://example.com/photo.jpg?w=1");
});

test("stable URLs: GitHub's 5-minute signed links become the permanent attachment URL; other signed links are dropped", () => {
  assert.equal(
    stableUrl("https://private-user-images.githubusercontent.com/141689453/693815905-22da1820-10fd-4cab-91db-17c955d5279d.png?jwt=abc"),
    "https://github.com/user-attachments/assets/22da1820-10fd-4cab-91db-17c955d5279d",
  );
  assert.equal(stableUrl("https://bucket.s3.amazonaws.com/x.png?X-Amz-Expires=300&X-Amz-Signature=abc"), undefined);
  assert.equal(stableUrl("https://go.dev/blog/jsonv2/api.png"), "https://go.dev/blog/jsonv2/api.png");
});

test("image dimensions from headers: PNG, JPEG, GIF, WebP (VP8, VP8L, VP8X)", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(png.buffer).setUint32(16, 1988);
  new DataView(png.buffer).setUint32(20, 714);
  assert.deepEqual(dimensions(png), { w: 1988, h: 714 });

  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0xe8, 0x07, 0x6c, 0x03]);
  assert.deepEqual(dimensions(jpg), { h: 1000, w: 1900 });

  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x58, 0x02, 0x2c, 0x01]);
  assert.deepEqual(dimensions(gif), { w: 600, h: 300 });

  const riff = (chunk: string, body: number[]) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...[...chunk].map((c) => c.charCodeAt(0)), ...body]);
  // VP8X: canvas width-1 and height-1 as 24-bit little endian at 24 and 27
  const vp8x = riff("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 0x5f, 0x09, 0x00, 0x50, 0x02, 0x00]);
  assert.deepEqual(dimensions(vp8x), { w: 2400, h: 593 });
  const vp8 = riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x60, 0x09, 0x51, 0x02]);
  assert.deepEqual(dimensions(vp8), { w: 2400, h: 593 });

  assert.equal(dimensions(new Uint8Array([1, 2, 3, 4])), undefined);
});

test("digest sections: numbered items only, image links not counted as article links", () => {
  const md = `# T\n\n## 1. One\n**Why it matters:** a\n**Source:** [A](https://a.com/x)\n\n![pic](https://img.com/p.png)\n*pic*\n\n## 2. Two\n**Why it matters:** b\n**Source:** [B](https://b.com/y) · [HN](https://news.ycombinator.com/item?id=5)\n\n## Themes this week\n- t\n`;
  const s = digestSections(md);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0]!.links, ["https://a.com/x"]);
  assert.deepEqual(s[1]!.links, ["https://b.com/y", "https://news.ycombinator.com/item?id=5"]);
  assert.equal(s[1]!.context, "b");
});

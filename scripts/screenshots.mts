// Regenerates the screenshots in docs/images from docs/fixtures/sample-digest.md.
// Offline (no Telnyx API calls): renders the email and a feedback page on a local
// server and photographs them with Chrome.
//
//   npm run screenshots              # Chrome at the default macOS path
//   CHROME_PATH=/usr/bin/chromium npm run screenshots

import http from "node:http";
import { readFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { renderEmailHtml } from "../src/agent.ts";
import { THUMB_DOWN_PNG_BASE64, THUMB_UP_PNG_BASE64 } from "../src/assets.ts";
import { addFeedbackLinks, digestItems, nextVote, preferencesFrom, thanksPage, type DigestItemRecord } from "../src/feedback.ts";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../docs/images/", import.meta.url).pathname;
const md = await readFile(new URL("../docs/fixtures/sample-digest.md", import.meta.url), "utf8");
const subject = md.split("\n")[0]!.replace(/^#\s*/, "");

// Entities and tags as the tagger would give them (fixed, so the screenshots are reproducible).
const TAGS: Record<number, { tags: string[]; entities: string[] }> = {
  1: { tags: ["security", "dev tooling"], entities: ["postman", "codex", "claude code"] },
};
const telnyx = {
  get: async () => ({}),
  delete: async () => ({}),
  post: async (_: string, { body }: any) => {
    const n = (String(body?.messages?.[0]?.content).match(/^\d+\./gm) ?? []).length;
    const items = Array.from({ length: n }, (_, k) => ({ topics: TAGS[k + 1]?.tags ?? ["ai"], entities: TAGS[k + 1]?.entities ?? [] }));
    return { choices: [{ message: { content: JSON.stringify({ items }) } }] };
  },
};

let base = "";
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, base);
  const send = (body: string | Uint8Array, type: string) => { res.setHeader("content-type", type); res.end(body); };
  if (url.searchParams.get("asset") === "thumb-up.png") return send(Buffer.from(THUMB_UP_PNG_BASE64, "base64"), "image/png");
  if (url.searchParams.get("asset") === "thumb-down.png") return send(Buffer.from(THUMB_DOWN_PNG_BASE64, "base64"), "image/png");
  const feedback = `${base}/agents/ai-digest/feedback`;
  if (url.pathname === "/email") {
    const { markdown } = await addFeedbackLinks(telnyx, "screenshot-key", feedback, "20261107-demo", subject, md, md, []);
    return send(renderEmailHtml(markdown, subject), "text/html");
  }
  if (url.pathname === "/feedback") {
    const it = digestItems(md)[0]!;
    const item: DigestItemRecord = { ...it, ...TAGS[1]!, image: { url: md.match(/!\[[^\]]*\]\(([^)]+)\)/)![1]!, caption: md.match(/!\[([^\]]*)\]/)![1]! } };
    let vote = nextVote(undefined, { d: "20261107-demo", i: 1, v: "down", e: 9e9 }, item, "2026-11-07T10:00:00Z").vote;
    vote = nextVote(vote, { d: "20261107-demo", i: 1, v: "down", e: 9e9, r: "entity", x: 0 }, item, "2026-11-07T10:00:05Z").vote;
    const reasons = { "entity:0": "#", "entity:1": "#", "entity:2": "#", topic: "#", known: "#" };
    return send(await thanksPage({ base: feedback, vote, item, prefs: preferencesFrom([vote]), links: { undo: "#", flip: "#", view: "#", reasons } }).text(), "text/html");
  }
  res.statusCode = 404;
  res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${(server.address() as any).port}`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
async function shoot(path: string, file: string, width: number, clip?: (p: typeof page) => Promise<{ y: number; height: number }>) {
  await page.setViewport({ width, height: 1000, deviceScaleFactor: 2 });
  await page.goto(base + path, { waitUntil: "networkidle0", timeout: 90_000 });
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  const c = clip ? await clip(page) : undefined;
  await page.screenshot({ path: OUT + file, ...(c ? { clip: { x: 0, y: c.y, width, height: c.height } } : { fullPage: true }) });
  console.log("wrote docs/images/" + file);
}
const headingTop = (text: string) => async (p: typeof page) => ({
  y: await p.evaluate((t) => { const h = [...document.querySelectorAll("h1,h2")].find((e) => e.textContent!.includes(t))!; return h.getBoundingClientRect().top + scrollY - 24; }, text),
  height: 0,
});

await shoot("/email", "email-top.png", 700, async () => ({ y: 0, height: 1250 }));
await shoot("/email", "email-diagrams.png", 700, async (p) => ({ ...(await headingTop("Git's backend")(p)), height: 1250 }));
await shoot("/email", "email-footer.png", 700, async (p) => ({ y: await p.evaluate(() => document.body.scrollHeight - 260), height: 260 }));
await shoot("/feedback", "feedback-page.png", 480);
await browser.close();
server.close();

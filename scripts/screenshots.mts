// Regenerates the screenshots in docs/images from scripts/fixtures/sample-digest.md.
// Offline (no Telnyx API calls): renders the email and a feedback page on a local
// server and photographs them with Chrome.
//
//   ai-digest screenshots              # Chrome at the default macOS path
//   CHROME_PATH=/usr/bin/chromium ai-digest screenshots

import http from "node:http";
import { readFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { renderEmailHtml } from "../src/agent.ts";
import { THUMB_DOWN_PNG_BASE64, THUMB_UP_PNG_BASE64 } from "../src/assets.ts";
import { addFeedbackLinks, digestItems, nextVote, preferencesFrom, thanksPage, type DigestItemRecord } from "../src/feedback.ts";
import { digestPage, listPage } from "../src/app.ts";
import { parseProfile } from "../src/profile.ts";
import { computePreferences } from "../src/preferences.ts";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = new URL("../docs/images/", import.meta.url).pathname;
const md = await readFile(new URL("./fixtures/sample-digest.md", import.meta.url), "utf8");
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
  if (url.pathname === "/v1/assets/thumb-up.png") return send(Buffer.from(THUMB_UP_PNG_BASE64, "base64"), "image/png");
  if (url.pathname === "/v1/assets/thumb-down.png") return send(Buffer.from(THUMB_DOWN_PNG_BASE64, "base64"), "image/png");
  const feedback = `${base}/v1/feedback`;
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
  // The digests page (/v1/app), with sample data.
  const ex = (n: string) => readFile(new URL(`../examples/digests/${n}.md`, import.meta.url), "utf8");
  const stored = [
    { id: "agent-memory", markdown: await ex("agent-memory"), updatedAt: "2026-11-07T22:00:00Z", versions: 2 },
    { id: "ai-swe", markdown: await ex("ai-swe"), updatedAt: "2026-11-07T21:30:00Z", versions: 1 },
  ];
  const issues = [
    { id: "20261107-8xxl", profile: "agent-memory", subject: "Agent Memory Weekly — Oct 25 – Nov 8, 2026", sentAt: "2026-11-07T22:11:56Z", items: 7 },
    { id: "20261031-q1zr", profile: "agent-memory", subject: "Agent Memory Weekly — Oct 18 – Nov 1, 2026", sentAt: "2026-10-31T08:00:00Z", items: 8 },
    { id: "20261107-gfar", profile: "ai-swe", subject: "AI & Software Engineering Digest — 1–7 November 2026", sentAt: "2026-11-07T10:20:00Z", items: 13 },
    { id: "20261109-k2pd", profile: "__general", topic: "agent harnesses", subject: "Agent harnesses — 2–9 November 2026", sentAt: "2026-11-09T08:00:00Z", items: 6 },
  ];
  const summaries = stored.map((d) => {
    const p = parseProfile(d.id, d.markdown);
    return { id: d.id, title: p.title, windowDays: p.windowDays, items: p.items, schedule: p.schedule ?? null, updatedAt: d.updatedAt, versions: d.versions };
  });
  if (url.pathname === "/app") return send(await listPage(summaries, { issues, votes: { "agent-memory": 3, "ai-swe": 5, __general: 2 } }, { "agent-memory": 4, "ai-swe": 8, __general: 2 }).text(), "text/html");
  if (url.pathname === "/app-digest") {
    const prefs = computePreferences([
      { vote: "up", headline: "Mem0 state of memory", tags: ["agent memory", "benchmarks"], entities: ["mem0"], source: "mem0.ai", reasons: [{ r: "entity", target: "mem0" }], at: "2026-11-07T21:37:00Z" },
      { vote: "up", headline: "Letta sleep-time compute", tags: ["agent memory", "retrieval"], entities: ["letta"], source: "letta.com", reasons: [{ r: "topic" }], at: "2026-11-07T21:40:00Z" },
      { vote: "down", headline: "Membase launch", tags: ["agent memory", "dev tooling"], entities: ["membase"], source: "unibase.io", reasons: [{ r: "entity", target: "membase" }], at: "2026-11-07T22:13:00Z" },
    ]);
    const summary = "## Wants more of\n- **Mem0** — liked the state-of-memory report with benchmark numbers (7 Nov 2026).\n- **Retrieval for agents** — wants more on retrieval and context management (7 Nov 2026).\n\n## Wants less of\n- **Membase** — doesn't use it (7 Nov 2026).";
    return send(await digestPage({ digest: stored[0]!, issues: issues.filter((i) => i.profile === "agent-memory").map((issue) => ({ issue, view: "#" })), prefs, memorySummary: summary, memoryCount: 4 }).text(), "text/html");
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
await shoot("/app", "app-digests.png", 900, async () => ({ y: 0, height: 720 }));
await shoot("/app-digest", "app-digest.png", 900);
await browser.close();
server.close();

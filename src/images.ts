// Picking illustrative images for digest items, done in code (not by the
// research model): for each item, fetch its source article, collect candidate
// images (og:image, figures, in-body images), and ask a vision model whether
// each one actually shows something relevant to the headline. Only images that
// pass are kept, at most two per item.

/** The vision model: hosted by Telnyx, accepts base64 images (checked: Qwen3.8-27B answers in ~2 s). */
export const VISION_MODEL = "Qwen/Qwen3.8-27B";
/** A candidate needs at least this score (0–10) from the vision model to be used. */
export const MIN_SCORE = 7;
export const MAX_IMAGES_PER_ITEM = 2;
const MAX_CANDIDATES = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 8_000;
const VISION_TIMEOUT_MS = 25_000;
/** The whole enrichment stops waiting after this; items still pending get no images. */
const TOTAL_BUDGET_MS = 75_000;
const CONCURRENCY = 5;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const SKIP = /(logo|icon|avatar|sprite|badge|pixel|spacer|emoji|gravatar|favicon|placeholder|blank|tracking|\/ads?\/|doubleclick|author|headshot|profile)/i;
const VISION_FORMATS = /^image\/(jpeg|jpg|png|webp|gif)$/i;

/** What `post` needs: the Telnyx client's raw POST (env.TELNYX). */
export interface TelnyxPoster {
  post(path: string, opts: { body: unknown }): Promise<any>;
}

export interface Candidate {
  url: string;
  alt?: string;
  caption?: string;
  origin: "og" | "figure" | "img";
}

export interface PickedImage {
  url: string;
  caption: string;
  score: number;
  kind: string;
}

export interface ItemImages {
  headline: string;
  article?: string;
  images: PickedImage[];
  /** Why nothing was picked, when nothing was. */
  note?: string;
}

type Log = (event: Record<string, unknown>) => void;

// ── candidates ───────────────────────────────────────────────────────────────

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x2F;/g, "/");
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
};
/** The largest entry of a srcset ("a.jpg 480w, b.jpg 1200w"). */
const largestSrc = (srcset: string) =>
  srcset
    .split(",")
    .map((p) => p.trim().split(/\s+/))
    .map(([u, d]) => ({ u, n: parseFloat(d ?? "1") || 1 }))
    .sort((a, b) => b.n - a.n)[0]?.u;

function imgUrl(tag: string): string | undefined {
  const srcset = attr(tag, "srcset") ?? attr(tag, "data-srcset");
  return (srcset && largestSrc(srcset)) || attr(tag, "data-src") || attr(tag, "data-original") || attr(tag, "src");
}

function tooSmall(tag: string): boolean {
  const w = Number(attr(tag, "width"));
  const h = Number(attr(tag, "height"));
  return (w > 0 && w < 300) || (h > 0 && h < 150);
}

/**
 * A URL that still works when the email is opened days later. GitHub's signed
 * private-user-images links expire after 5 minutes; the attachment URL behind
 * them redirects to a fresh one. Other short-lived signed links are dropped.
 */
export function stableUrl(url: string): string | undefined {
  const gh = url.match(/^https:\/\/private-user-images\.githubusercontent\.com\/\d+\/\d+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i);
  if (gh) return `https://github.com/user-attachments/assets/${gh[1]}`;
  if (/[?&](jwt|X-Amz-Expires|X-Amz-Signature|Expires|Signature|token)=/i.test(url)) return undefined;
  return url;
}

/** Candidate images of an article page, best first: og/twitter image, figures with captions, then in-body images. */
/**
 * A raster version of an SVG when its host can render one (Gmail shows no SVG).
 * Contentful's image API turns `.svg` into PNG with `fm=png` (checked: OpenAI's
 * diagrams come back as clean ~600 px PNGs). Other SVGs: undefined (skipped).
 */
export function rasterUrl(url: string): string | undefined {
  if (!/\.svg(\?|$)/i.test(url)) return url;
  const u = new URL(url);
  if (u.hostname === "images.ctfassets.net") {
    u.search = "";
    u.searchParams.set("fm", "png");
    u.searchParams.set("w", "1200");
    return u.href;
  }
  return undefined;
}

/** Alt text of a teaser or chrome image rather than an illustration of the article. */
const SKIP_ALT = /(card image|thumbnail|related|avatar|logo|icon|headshot|portrait of|profile photo)/i;

/** The article body: the largest <article>, else <main>, else the page. */
function articleBody(html: string): string {
  const arts = [...html.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => m[0]).sort((a, b) => b.length - a.length);
  return arts[0] && arts[0].length > 2000 ? arts[0] : (html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html);
}

/**
 * Candidate images of an article page, best first: the article's own figures
 * (described ones first), then in-body images with descriptive alt text, then
 * other in-body images, and the og/twitter share image last (it's usually a
 * branded banner).
 */
export function extractCandidates(html: string, pageUrl: string): Candidate[] {
  const seen = new Set<string>();
  const make = (raw: string | undefined, c: Omit<Candidate, "url">): Candidate | undefined => {
    if (!raw || raw.startsWith("data:")) return undefined;
    let url: string;
    try {
      url = new URL(raw, pageUrl).href;
    } catch {
      return undefined;
    }
    url = rasterUrl(stableUrl(url) ?? "") ?? "";
    if (!/^https:\/\//i.test(url) || SKIP.test(url.replace(/[?#].*$/, ""))) return undefined;
    const key = url.replace(/[?#].*$/, "");
    if (seen.has(key)) return undefined;
    seen.add(key);
    return { url, ...c };
  };
  const described = (c: Candidate) => ((c.caption?.length ?? 0) + (c.alt?.length ?? 0)) >= 25;

  const body = articleBody(html);
  const figures: Candidate[] = [];
  for (const m of body.matchAll(/<figure\b[\s\S]*?<\/figure>/gi)) {
    const fig = m[0];
    const img = fig.match(/<img\b[^>]*>/i)?.[0];
    if (!img || tooSmall(img)) continue;
    const alt = attr(img, "alt");
    if (alt && SKIP_ALT.test(alt)) continue;
    const cap = fig.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] ?? fig.match(/aria-label="([^"]+)"/i)?.[1];
    const c = make(imgUrl(img), { origin: "figure", alt, caption: cap ? strip(cap).slice(0, 300) : undefined });
    if (c) figures.push(c);
  }
  const imgs: Candidate[] = [];
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const img = m[0];
    if (tooSmall(img)) continue;
    const alt = attr(img, "alt");
    if (alt !== undefined && (SKIP.test(alt) || SKIP_ALT.test(alt))) continue;
    const c = make(imgUrl(img), { origin: "img", alt });
    if (c) imgs.push(c);
  }
  const og: Candidate[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const prop = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    if (prop === "og:image" || prop === "og:image:secure_url" || prop === "twitter:image" || prop === "twitter:image:src") {
      const c = make(attr(tag, "content"), { origin: "og", alt: undefined });
      if (c) og.push(c);
    }
  }
  return [
    ...figures.filter(described),
    ...imgs.filter(described),
    ...figures.filter((c) => !described(c)),
    ...imgs.filter((c) => !described(c)),
    ...og,
  ];
}

// ── fetching and judging ─────────────────────────────────────────────────────

async function fetchLimited(url: string, timeoutMs: number, maxBytes: number, accept: string): Promise<{ bytes: Uint8Array; type: string; finalUrl: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, redirect: "follow", signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const len = Number(res.headers.get("content-length"));
    if (len > maxBytes) throw new Error(`too large (${len} bytes)`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`too large (${buf.byteLength} bytes)`);
    return { bytes: buf, type, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

/** A caption of at most ~25 words: the first sentence, or cut at a word boundary. */
function shorten(text: string): string {
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const words = first.split(/\s+/);
  return words.length <= 25 ? first : words.slice(0, 25).join(" ").replace(/[,;:]$/, "") + "…";
}

/** Width and height from the image header (PNG, JPEG, GIF, WebP); undefined when unreadable. */
export function dimensions(b: Uint8Array): { w: number; h: number } | undefined {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  if (b[0] === 0x89 && b[1] === 0x50) return { w: u32be(16), h: u32be(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { w: u16le(6), h: u16le(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: u16be(i + 5), w: u16be(i + 7) };
      i += 2 + u16be(i + 2);
    }
    return undefined;
  }
  if (b[0] === 0x52 && b[8] === 0x57) {
    const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (chunk === "VP8X") return { w: u24le(24) + 1, h: u24le(27) + 1 };
    if (chunk === "VP8 ") return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return undefined;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The image type from its first bytes; servers often send a generic content-type. */
function sniff(bytes: Uint8Array, header: string): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return VISION_FORMATS.test(header) ? header : undefined;
}

const VISION_PROMPT = (headline: string, context: string, c: Candidate) => `You are choosing illustrations for an engineering news digest.

News item: ${headline}
Summary: ${context || "(none)"}
Image alt text: ${c.alt || "(none)"}
Image caption on the page: ${c.caption || "(none)"}

Look at the image. Score 0–10 how much it helps a software engineer understand THIS news item:
- 8–10: shows the actual subject: a benchmark chart or table, an architecture diagram, a product/UI/terminal screenshot, a code snippet, a photo of the specific device or event.
- 4–7: related but generic (a lab's branded banner with the model name, a conference stage photo).
- 0–3: decorative or irrelevant: stock photo, abstract art, logo only, author headshot, ad, cookie banner, mostly text of a headline.

Answer with JSON only, no prose: {"score": <0-10>, "kind": "<chart|diagram|screenshot|photo|banner|logo|stock|other>", "caption": "<one factual sentence describing what the image shows, max 20 words>"}`;

async function judge(telnyx: TelnyxPoster, dataUrl: string, headline: string, context: string, c: Candidate): Promise<{ score: number; kind: string; caption: string }> {
  const call = telnyx.post("/ai/chat/completions", {
    body: {
      model: VISION_MODEL,
      max_tokens: 400,
      temperature: 0,
      // Qwen3.8 reasons by default and spends the budget before answering; "none" answers in ~1 s.
      reasoning_effort: "none",
      messages: [{ role: "user", content: [{ type: "text", text: VISION_PROMPT(headline, context, c) }, { type: "image_url", image_url: { url: dataUrl } }] }],
    },
  });
  const res: any = await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error("vision timeout")), VISION_TIMEOUT_MS))]);
  const text: string = res?.choices?.[0]?.message?.content ?? "";
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`vision answered without JSON: ${text.slice(0, 80)}`);
  const v = JSON.parse(json);
  return { score: Number(v.score) || 0, kind: String(v.kind ?? "other"), caption: shorten(String(v.caption ?? "").trim()) };
}

/** Up to MAX_IMAGES_PER_ITEM images from one article that the vision model judged relevant. */
export async function pickImages(telnyx: TelnyxPoster, article: string, headline: string, context: string, log: Log = () => {}): Promise<PickedImage[]> {
  const page = await fetchLimited(article, PAGE_TIMEOUT_MS, MAX_PAGE_BYTES, "text/html,application/xhtml+xml");
  if (!page.type.includes("html")) throw new Error(`not an HTML page (${page.type || "no type"})`);
  const html = new TextDecoder().decode(page.bytes);
  const candidates = extractCandidates(html, page.finalUrl).slice(0, MAX_CANDIDATES);
  log({ images: "candidates", article, count: candidates.length });
  const judged = await Promise.all(
    candidates.map(async (c) => {
      try {
        const img = await fetchLimited(c.url, IMAGE_TIMEOUT_MS, MAX_IMAGE_BYTES, "image/avif;q=0,image/webp,image/png,image/jpeg,image/*;q=0.8");
        const type = sniff(img.bytes, img.type);
        if (!type) throw new Error(`unsupported image type ${img.type}`);
        if (img.bytes.byteLength < 1_500) throw new Error("too small to be an illustration"); // flat diagrams compress to a few KB; the size check below decides
        // Email-friendly shapes only: wide enough to read, not taller than wide (a tall screenshot fills the screen).
        const dim = dimensions(img.bytes);
        if (dim && dim.w < 500) throw new Error(`too narrow (${dim.w}x${dim.h})`);
        if (dim && dim.h > dim.w) throw new Error(`taller than wide (${dim.w}x${dim.h})`);
        const v = await judge(telnyx, `data:${type};base64,${base64(img.bytes)}`, headline, context, c);
        log({ images: "judged", url: c.url, origin: c.origin, score: v.score, kind: v.kind });
        return { url: c.url, caption: c.caption && c.caption.length <= 200 ? c.caption : v.caption, score: v.score, kind: v.kind };
      } catch (err) {
        log({ images: "skipped", url: c.url, error: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
    }),
  );
  return judged
    .filter((j): j is PickedImage => !!j && j.score >= MIN_SCORE && !!j.caption)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_IMAGES_PER_ITEM);
}

// ── the digest ───────────────────────────────────────────────────────────────

interface Section {
  start: number;
  end: number;
  headline: string;
  context: string;
  links: string[];
}

/** The digest's numbered items ("## 1. …"), each with its headline, "Why it matters" text and links in order. */
export function digestSections(markdown: string): Section[] {
  const heads = [...markdown.matchAll(/^##\s+\d+\.\s+(.+)$/gm)];
  return heads.map((h, i) => {
    const start = h.index!;
    const nextHeading = markdown.slice(start + h[0].length).search(/^##\s/m);
    const end = nextHeading === -1 ? markdown.length : start + h[0].length + nextHeading;
    const block = markdown.slice(start, end);
    const context = block.match(/\*\*Why it matters:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
    const links = [...block.matchAll(/(?<!!)\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!).filter((u) => !/reddit\.com|lobste\.rs|x\.com|twitter\.com|news\.ycombinator\.com\/(?!item)/i.test(u));
    return { start, end, headline: h[1]!.trim(), context, links };
  });
}

/** An HN discussion link → the story it points to (HN pages themselves have no pictures). */
async function resolveArticle(link: string): Promise<string | undefined> {
  const id = link.match(/news\.ycombinator\.com\/item\?id=(\d+)/)?.[1];
  if (!id) return link;
  const r = await fetchLimited(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, PAGE_TIMEOUT_MS, 200_000, "application/json");
  const url = JSON.parse(new TextDecoder().decode(r.bytes))?.url;
  return typeof url === "string" && /^https?:\/\//.test(url) ? url : undefined;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/**
 * The digest with picked images inserted under each item (as Markdown images,
 * each followed by an italic caption line), plus a per-item report. Items
 * whose articles fail or have nothing relevant are left as they were.
 */
export async function addImages(telnyx: TelnyxPoster, markdown: string, log: Log = () => {}): Promise<{ markdown: string; report: ItemImages[] }> {
  const sections = digestSections(markdown);
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  // One look per article page, even when several items or links point at it.
  const seen = new Map<string, Promise<PickedImage[]>>();
  const pick = (article: string, s: Section) => {
    if (!seen.has(article)) seen.set(article, pickImages(telnyx, article, s.headline, s.context, log));
    return seen.get(article)!;
  };
  const report = await pool(sections, CONCURRENCY, async (s): Promise<ItemImages> => {
    for (const link of s.links.slice(0, 2)) {
      if (Date.now() > deadline) return { headline: s.headline, images: [], note: "time budget spent" };
      let article = link;
      try {
        const resolved = await resolveArticle(link);
        if (!resolved) continue;
        article = resolved;
        const left = deadline - Date.now();
        const images = await Promise.race([
          pick(article, s),
          new Promise<PickedImage[]>((_, rej) => setTimeout(() => rej(new Error("time budget spent")), left)),
        ]);
        if (images.length) return { headline: s.headline, article, images };
      } catch (err) {
        log({ images: "article failed", article, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { headline: s.headline, images: [], note: s.links.length ? "nothing relevant" : "no article link" };
  });
  // Insert from the last section backwards so earlier offsets stay valid.
  let out = markdown;
  for (let i = sections.length - 1; i >= 0; i--) {
    const imgs = report[i]!.images;
    if (!imgs.length) continue;
    const md = imgs.map((im) => `\n![${im.caption.replace(/[\[\]]/g, "")}](${im.url})\n*${im.caption.replace(/\*/g, "")}*\n`).join("");
    const end = sections[i]!.end;
    out = out.slice(0, end).replace(/\s*$/, "\n") + md + "\n" + out.slice(end);
  }
  return { markdown: out, report };
}

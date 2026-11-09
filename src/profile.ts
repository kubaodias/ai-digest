// Digest definitions ("profiles"): one Markdown file per digest, settings in a
// front-matter block, the description in the body. Pure functions, covered by
// test/profile.test.ts.
//
//   ---
//   title: "Agent Memory Weekly — {range}"
//   window: 14d
//   items: 5-10
//   closing: Takeaways
//   ---
//   Memory systems for AI agents: … (what to cover, for whom, sources, what to leave out)

import { GENERAL_TEMPLATE } from "./general.ts";

export interface DigestProfile {
  /** From the file name: lowercase letters, digits and single dashes. Also the Agent Memory profile name. */
  id: string;
  /** Email subject and heading; `{range}` becomes the dates covered. */
  title: string;
  /** Days to look back. */
  windowDays: number;
  /** How many items, at least and at most. */
  items: { min: number; max: number };
  /** The closing section's heading, or null for none. */
  closing: string | null;
  /** Pictures from the source articles. */
  images: boolean;
  /** Recipients overriding DIGEST_EMAIL_TO. */
  to: string[];
  /** Continuous scouting (docs/spec/0010-continuous-scouting.md): set when the file has `scout:`. */
  scout?: { scoutHours: number; sendAt: number; strong: number; minGapDays: number; maxGapDays: number };
  /** What to cover, for whom, sources, what to leave out: given to the research model as written. */
  description: string;
  /** For the built-in General digest: the topic this run is about. */
  topic?: string;
}

export const DEFAULTS = { windowDays: 7, items: { min: 5, max: 15 }, closing: "Themes this week", images: true } as const;

/** Ids are file names: lowercase letters, digits and dashes, no "--" (it separates the id from a run name). */
export const ID_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/;

/**
 * The built-in on-demand digest (`npm run digests -- ask "<topic>"`). Its id
 * starts with "_", which ID_PATTERN never allows, so no stored digest can take
 * it. Its votes, preferences and Agent Memory profile use this id too.
 */
export const GENERAL_ID = "__general";

/** A digest id: a stored digest's, or the built-in General one. */
export function isDigestId(id: string | undefined): id is string {
  return !!id && (id === GENERAL_ID || ID_PATTERN.test(id));
}

/** The longest topic `ask` accepts, after cleaning. */
export const TOPIC_MAX = 200;

const KNOWN = new Set(["title", "window", "items", "closing", "images", "to", "scout", "send_at", "strong", "min_gap", "max_gap"]);
const SCOUT_ONLY = ["send_at", "strong", "min_gap", "max_gap"];

export class ProfileError extends Error {
  readonly id: string;
  constructor(id: string, message: string) {
    super(`${id}: ${message}`);
    this.id = id;
  }
}

function unquote(v: string): string {
  const t = v.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

function intIn(id: string, key: string, v: string, min: number, max: number, unit = ""): number {
  const m = v.trim().match(unit ? new RegExp(`^(\\d+)\\s*${unit}?$`) : /^(\d+)$/);
  const n = m ? +m[1]! : NaN;
  if (!m || n < min || n > max) throw new ProfileError(id, `"${key}" must be ${min}${unit}–${max}${unit}`);
  return n;
}

/** The scouting settings, or undefined without `scout:`. The others need it. */
function parseScout(id: string, s: Record<string, string>, items: { min: number; max: number }): DigestProfile["scout"] {
  if (s.scout === undefined || /^(off|no|none)$/i.test(s.scout)) {
    const stray = SCOUT_ONLY.find((k) => s[k] !== undefined);
    if (stray) throw new ProfileError(id, `"${stray}" needs "scout" (e.g. scout: 6h)`);
    return undefined;
  }
  const scoutHours = intIn(id, "scout", s.scout, 1, 24, "h");
  const sendAt = s.send_at !== undefined ? intIn(id, "send_at", s.send_at, 1, 30) : items.min;
  const strong = s.strong !== undefined ? intIn(id, "strong", s.strong, 1, 10) : 7;
  const minGapDays = s.min_gap !== undefined ? intIn(id, "min_gap", s.min_gap, 0, 30, "d") : 2;
  const maxGapDays = s.max_gap !== undefined ? intIn(id, "max_gap", s.max_gap, 1, 30, "d") : 7;
  if (maxGapDays < minGapDays) throw new ProfileError(id, `"max_gap" must be at least "min_gap"`);
  return { scoutHours, sendAt, strong, minGapDays, maxGapDays };
}

/** "14d" → 14 (1–90 days). */
export function parseWindow(id: string, value: string): number {
  const w = value.trim().match(/^(\d+)\s*d?$/);
  if (!w || +w[1]! < 1 || +w[1]! > 90) throw new ProfileError(id, `"window" must be days, 1d–90d (e.g. 14d)`);
  return +w[1]!;
}

/** "5-10" or "8" → { min, max } (1–30). */
export function parseItems(id: string, value: string): { min: number; max: number } {
  const r = value.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  const min = r ? +r[1]! : NaN;
  const max = r ? +(r[2] ?? r[1])! : NaN;
  if (!r || min < 1 || max > 30 || min > max) throw new ProfileError(id, `"items" must be a count or range between 1 and 30 (e.g. 5-10)`);
  return { min, max };
}

/** Parse and check one digest file. Throws ProfileError with a precise message. */
export function parseProfile(id: string, markdown: string): DigestProfile {
  if (!ID_PATTERN.test(id)) throw new ProfileError(id, `the file name must be lowercase letters, digits and single dashes (e.g. agent-memory.md)`);
  return parseDefinition(id, markdown);
}

function parseDefinition(id: string, markdown: string): DigestProfile {
  const m = markdown.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new ProfileError(id, `missing the settings block: start the file with --- … --- (see examples/digests)`);
  const settings: Record<string, string> = {};
  m[1]!.split(/\r?\n/).forEach((line, n) => {
    const raw = line.replace(/\s+#.*$/, "").trimEnd();
    if (!raw.trim() || raw.trim().startsWith("#")) return;
    const kv = raw.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!kv) throw new ProfileError(id, `settings line ${n + 1} isn't "key: value": ${line.trim()}`);
    if (kv[1] === "schedule") throw new ProfileError(id, `"schedule" was replaced by "scout" (e.g. scout: 6h; see docs/spec/0010-continuous-scouting.md)`);
    if (!KNOWN.has(kv[1]!)) throw new ProfileError(id, `unknown setting "${kv[1]}" (known: ${[...KNOWN].join(", ")})`);
    settings[kv[1]!] = unquote(kv[2]!);
  });
  const description = m[2]!.trim();
  if (!settings.title) throw new ProfileError(id, `"title" is required`);
  if (!description) throw new ProfileError(id, `describe the digest below the settings block`);

  const windowDays = settings.window !== undefined ? parseWindow(id, settings.window) : DEFAULTS.windowDays;
  const items = settings.items !== undefined ? parseItems(id, settings.items) : { ...DEFAULTS.items };
  let closing: string | null = DEFAULTS.closing;
  if (settings.closing !== undefined) closing = /^(none|off|no)$/i.test(settings.closing) ? null : settings.closing;
  let images: boolean = DEFAULTS.images;
  if (settings.images !== undefined) {
    if (!/^(on|off|true|false|yes|no)$/i.test(settings.images)) throw new ProfileError(id, `"images" must be on or off`);
    images = /^(on|true|yes)$/i.test(settings.images);
  }
  const to = (settings.to ?? "").split(/[,;\s]+/).filter(Boolean);
  const bad = to.find((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
  if (bad) throw new ProfileError(id, `"to" has an invalid address: ${bad}`);
  const scout = parseScout(id, settings, items);
  return { id, title: settings.title, windowDays, items, closing, images, to, ...(scout ? { scout } : {}), description };
}

/** The conversation name for a run of a digest: "<id>--<run>". */
export function runConversation(id: string, run: string): string {
  return `${id}--${run}`;
}

/** The digest id a conversation belongs to, or undefined (conversations from before profiles). */
export function profileIdOf(conversation: string | undefined): string | undefined {
  const id = conversation?.split("--")[0];
  return conversation?.includes("--") && isDigestId(id) ? id : undefined;
}

/**
 * A topic for the General digest, as one clean line: control characters and
 * line breaks become spaces, runs of spaces collapse. It's only ever put into
 * the template's {topic} placeholders, after the template is parsed, so it
 * can't add settings. Throws ProfileError when empty or too long.
 */
export function cleanTopic(raw: unknown): string {
  const t = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!t) throw new ProfileError(GENERAL_ID, `give a topic, e.g. "agent harnesses"`);
  if (t.length > TOPIC_MAX) throw new ProfileError(GENERAL_ID, `the topic is ${t.length} characters; keep it under ${TOPIC_MAX}`);
  return t;
}

/** One run of the General digest: the template (src/general.ts) with {topic} filled in, and optional window and items. */
export function generalProfile(topic: unknown, overrides: { window?: unknown; items?: unknown } = {}): DigestProfile {
  const t = cleanTopic(topic);
  const p = parseDefinition(GENERAL_ID, GENERAL_TEMPLATE);
  const fill = (s: string) => s.split("{topic}").join(t);
  const heading = t.charAt(0).toUpperCase() + t.slice(1);
  const ov = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
  const window = ov(overrides.window);
  const items = ov(overrides.items);
  return {
    ...p,
    title: p.title.split("{topic}").join(heading),
    description: fill(p.description),
    topic: t,
    ...(window ? { windowDays: parseWindow(GENERAL_ID, window) } : {}),
    ...(items ? { items: parseItems(GENERAL_ID, items) } : {}),
  };
}

/** The digest every conversation without a profile belongs to (and the default for old feedback). */
export const LEGACY_PROFILE = "ai-swe";

/** The request the research model gets for one run of a digest. */
export function runMessage(p: DigestProfile, extra?: string): string {
  const lines = [
    `Write this digest.`,
    ``,
    `Title: ${p.title.includes("{range}") ? p.title.replace("{range}", "<the date range you cover>") : p.title}`,
    `Time window: the last ${p.windowDays} days.`,
    `Items: ${p.items.min === p.items.max ? p.items.min : `${p.items.min}–${p.items.max}`}, most important first. Return fewer if there isn't enough worth reporting.`,
    p.closing ? `Closing section: "## ${p.closing}" with 2–4 bullets connecting the items.` : `Closing section: none.`,
    ``,
    `What it covers and who it's for:`,
    p.description,
  ];
  if (extra?.trim()) lines.push(``, `For this issue in particular: ${extra.trim()}`);
  return lines.join("\n");
}

/** Who the digest is for, in a few words, for prompts that judge relevance (pictures). The first sentence of the description. */
export function audienceOf(p: DigestProfile | undefined): string {
  if (!p) return "a software engineer following AI and software engineering news";
  const first = p.description.replace(/^#.*$/gm, "").trim().split(/(?<=[.!?])\s/)[0] ?? p.description;
  return first.slice(0, 300);
}

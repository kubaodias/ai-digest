// Continuous scouting (docs/spec/0010-continuous-scouting.md): the candidate
// pool a digest's scout passes fill, and the decision when to send an issue.
// Pure functions, no I/O, covered by test/pool.test.ts. The pool actor
// (agent.ts) holds the state and starts the runs; prompts are in
// scout-instructions.ts.

import type { DigestProfile } from "./profile.ts";
import type { Preferences, SharedPreferences } from "./preferences.ts";
import { normalizeName } from "./preferences.ts";

export type EntryState = "candidate" | "reserved" | "sent" | "expired";

export interface PoolEntry {
  /** Hash of the canonical URL of the primary link. */
  id: string;
  headline: string;
  summary: string;
  why: string;
  url: string;
  source: string;
  /** Every distinct domain seen covering it, with one link each. */
  sources: { domain: string; url: string }[];
  /** YYYY-MM-DD when known. */
  published?: string;
  firstSeen: string;
  lastSeen: string;
  /** How many passes found it. */
  sightings: number;
  /** The model's 1–10 estimate, latest pass wins. */
  importance: number;
  primary: boolean;
  tags: string[];
  entities: string[];
  /** Computed by scoreEntry, kept for display. */
  score: number;
  state: EntryState;
  /** For reserved and sent entries: the issue's slot. */
  issue?: string;
  reservedAt?: string;
  sentAt?: string;
  /** Why it was removed from consideration (e.g. a product the reader doesn't use). */
  dropped?: string;
}

/** A known story a pass came across again, with any sources it hadn't been seen on. */
export interface Sighting {
  id: string;
  sources: string[];
}

/** One candidate as a scout pass reports it, after validation and tagging. */
export interface Candidate {
  headline: string;
  url: string;
  source: string;
  published?: string;
  summary: string;
  importance: number;
  why: string;
  otherSources: string[];
  sameAs?: string;
  primary: boolean;
  tags: string[];
  entities: string[];
}

export interface ScoutSettings {
  /** Hours between passes. */
  scoutHours: number;
  sendAt: number;
  strong: number;
  minGapDays: number;
  maxGapDays: number;
}

/** Sent and expired entries are kept this long, so a story is never sent twice. */
export const KEEP_DAYS = 90;
/** Live candidates kept at most (lowest scores dropped first). */
export const MAX_CANDIDATES = 200;
/** A reservation for an issue being written returns to the pool after this long. */
export const RESERVATION_MS = 60 * 60 * 1000;
/** Candidates a single pass may report. */
export const MAX_PER_PASS = 15;
/** Candidates a single pass may add about the same product or company (variety). */
export const MAX_PER_ENTITY = 2;
/** Forced and max_gap issues leave out stories below this score, unless none reach it. */
export const FLOOR = 5;
/** A story counts as trending from this many independent sources or sightings. */
export const TRENDING = 3;
/** Pool headlines listed in a scout request as "known". */
export const KNOWN_IN_REQUEST = 60;
const DAY = 24 * 3600 * 1000;

// ── URLs ──────────────────────────────────────────────────────────────────────

const TRACKING = /^(utm_.*|ref|ref_src|ref_url|fbclid|gclid|mc_cid|mc_eid|igshid|si|source|via|s|share)$/i;

/** The same article whatever link it came with: no www, fragment, tracking parameters, trailing slash or AMP. */
export function canonicalUrl(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(u.protocol)) return undefined;
  u.protocol = "https:";
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^(www|m|amp)\./, "");
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/amp\/?$/, "/").replace(/\.amp(\.html)?$/, "$1").replace(/\/+$/, "") || "/";
  return u.toString().replace(/\/(\?|$)/, "$1");
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A short stable id for a canonical URL (FNV-1a, 32-bit, base 36). */
export function entryId(canonical: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ── the scout reply ──────────────────────────────────────────────────────────

/**
 * The candidates in a scout pass's reply (JSON, possibly fenced), validated:
 * a parseable http(s) URL, a headline, importance 1–10 (clamped), a date in
 * the window when given (else dropped), at most MAX_PER_PASS. Untagged: tags
 * and entities are added by the caller.
 */
export function parseScoutReply(text: string, window: { since: string; until: string }): { candidates: Omit<Candidate, "tags" | "entities">[]; dropped: number; seen: Sighting[] } {
  let raw: unknown[] = [];
  let seenRaw: unknown[] = [];
  try {
    const json = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    const j = JSON.parse(json);
    raw = Array.isArray(j.candidates) ? j.candidates : [];
    seenRaw = Array.isArray(j.seen) ? j.seen : [];
  } catch {}
  const seen: Sighting[] = [];
  for (const x of seenRaw.slice(0, 60)) {
    const o = (typeof x === "string" ? { id: x } : (x ?? {})) as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) continue;
    const urls = (Array.isArray(o.sources) ? o.sources : typeof o.url === "string" ? [o.url] : []).filter((u): u is string => typeof u === "string" && !!canonicalUrl(u)).slice(0, 5);
    seen.push({ id: o.id, sources: urls });
  }
  const out: Omit<Candidate, "tags" | "entities">[] = [];
  const since = window.since.slice(0, 10);
  const until = window.until.slice(0, 10);
  for (const r of raw) {
    const c = (r ?? {}) as Record<string, unknown>;
    const url = typeof c.url === "string" ? c.url : "";
    const headline = typeof c.headline === "string" ? c.headline.trim().slice(0, 200) : "";
    if (!canonicalUrl(url) || !headline) continue;
    const published = typeof c.published === "string" && /^\d{4}-\d{2}-\d{2}/.test(c.published) ? c.published.slice(0, 10) : undefined;
    // A day of slack either side: publication dates are often in another time zone.
    if (published && (published < shiftDate(since, -1) || published > shiftDate(until, 1))) continue;
    const importance = Math.min(10, Math.max(1, Math.round(Number(c.importance) || 5)));
    const otherSources = Array.isArray(c.otherSources) ? c.otherSources.filter((x): x is string => typeof x === "string" && !!canonicalUrl(x)).slice(0, 5) : [];
    out.push({
      headline,
      url,
      source: typeof c.source === "string" && c.source ? c.source.toLowerCase().replace(/^www\./, "") : domainOf(url),
      ...(published ? { published } : {}),
      summary: typeof c.summary === "string" ? c.summary.trim().slice(0, 600) : "",
      importance,
      why: typeof c.why === "string" ? c.why.trim().slice(0, 400) : "",
      otherSources,
      ...(typeof c.sameAs === "string" && c.sameAs ? { sameAs: c.sameAs } : {}),
      primary: c.primary === true,
    });
    if (out.length >= MAX_PER_PASS) break;
  }
  return { candidates: out, dropped: raw.length - out.length, seen };
}

function shiftDate(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** At most `max` candidates per main entity (the first ones, i.e. the most important); untagged ones always pass. */
export function capPerEntity<T extends { entities: string[] }>(candidates: T[], max = MAX_PER_ENTITY): { kept: T[]; capped: number } {
  const count = new Map<string, number>();
  const kept: T[] = [];
  for (const c of candidates) {
    const main = c.entities[0] ? normalizeName(c.entities[0]) : "";
    const n = main ? (count.get(main) ?? 0) : 0;
    if (main && n >= max) continue;
    if (main) count.set(main, n + 1);
    kept.push(c);
  }
  return { kept, capped: candidates.length - kept.length };
}

/** Whether a story is trending: several independent sources, or found again and again. */
export function trending(e: Pick<PoolEntry, "sources" | "sightings">): boolean {
  return e.sources.length >= TRENDING || e.sightings >= TRENDING;
}

// ── merging ──────────────────────────────────────────────────────────────────

const words = (s: string) => new Set(normalizeName(s).split(" ").filter((w) => w.length > 2));

/** Share of title words in common (Jaccard). */
export function titleOverlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** Whether a candidate may join an existing entry the model says it's the same story as. */
export function sameStory(entry: Pick<PoolEntry, "headline" | "entities">, c: Pick<Candidate, "headline" | "entities">): boolean {
  const shared = c.entities.some((e) => entry.entities.map(normalizeName).includes(normalizeName(e)));
  return shared || titleOverlap(entry.headline, c.headline) >= 0.5;
}

/**
 * Add one pass's candidates to the pool (a new array; entries are copied when
 * changed). A candidate joins an entry with the same canonical URL, or the
 * entry it names in `sameAs` when they share an entity or most title words;
 * otherwise it's new. Joining adds a sighting and its domains to `sources`,
 * and takes the newer importance. Sent and expired entries absorb repeats
 * without coming back.
 */
export function mergeCandidates(pool: PoolEntry[], candidates: Candidate[], now: string, seen: Sighting[] = []): { pool: PoolEntry[]; added: number; merged: number; resighted: number } {
  const next = pool.map((e) => ({ ...e, sources: [...e.sources] }));
  const byId = new Map(next.map((e) => [e.id, e]));
  let added = 0;
  let merged = 0;
  let resighted = 0;
  const seenThisPass = new Set<string>();
  // Known stories reported as seen again: a sighting, and any new sources (unknown ids are ignored).
  for (const x of seen) {
    const e = byId.get(x.id);
    if (!e || seenThisPass.has(e.id)) continue;
    e.sightings++;
    e.lastSeen = now;
    seenThisPass.add(e.id);
    for (const u of x.sources) {
      const domain = domainOf(u);
      if (domain && !e.sources.some((s) => s.domain === domain)) e.sources.push({ domain, url: u });
    }
    resighted++;
  }
  for (const c of candidates) {
    const canon = canonicalUrl(c.url)!;
    const id = entryId(canon);
    let target = byId.get(id);
    if (!target && c.sameAs) {
      const named = byId.get(c.sameAs);
      if (named && sameStory(named, c)) target = named;
    }
    const domains = [{ domain: domainOf(c.url) || c.source, url: c.url }, ...c.otherSources.map((u) => ({ domain: domainOf(u), url: u }))];
    if (target) {
      if (!seenThisPass.has(target.id)) {
        target.sightings++;
        seenThisPass.add(target.id);
      }
      target.lastSeen = now;
      for (const d of domains) if (d.domain && !target.sources.some((s) => s.domain === d.domain)) target.sources.push(d);
      if (target.state === "candidate") {
        target.importance = c.importance;
        if (c.primary && !target.primary) Object.assign(target, { primary: true, url: c.url, source: c.source, headline: c.headline });
        if (!target.published && c.published) target.published = c.published;
        if (!target.tags.length) target.tags = c.tags;
        if (!target.entities.length) target.entities = c.entities;
      }
      merged++;
      continue;
    }
    const entry: PoolEntry = {
      id,
      headline: c.headline,
      summary: c.summary,
      why: c.why,
      url: c.url,
      source: c.source,
      sources: domains.filter((d, i) => d.domain && domains.findIndex((x) => x.domain === d.domain) === i),
      ...(c.published ? { published: c.published } : {}),
      firstSeen: now,
      lastSeen: now,
      sightings: 1,
      importance: c.importance,
      primary: c.primary,
      tags: c.tags,
      entities: c.entities,
      score: 0,
      state: "candidate",
    };
    next.push(entry);
    byId.set(id, entry);
    seenThisPass.add(id);
    added++;
  }
  return { pool: next, added, merged, resighted };
}

// ── scoring ──────────────────────────────────────────────────────────────────

/** Score weights (spec 0010). Tuned from feedback later. */
export const SCORE = { corroborationMax: 2, sightingStep: 0.5, sightingMax: 1.5, primary: 0.5, entityMore: 1, topic: 0.5, sharedMore: 0.5, perWeek: 1 } as const;

/**
 * An entry's score, 0–10, or `drop` when a product the reader doesn't use is
 * its subject (the digest's own preference, or a shared "I don't use X").
 */
export function scoreEntry(e: PoolEntry, prefs: Pick<Preferences, "entities" | "topics"> | undefined, shared: Pick<SharedPreferences, "entities"> | undefined, now: string): { score: number; drop?: string } {
  const ents = e.entities.map(normalizeName);
  const main = ents[0];
  const less = [...(prefs?.entities ?? []), ...(shared?.entities ?? [])].find((p) => p.direction === "less" && main && normalizeName(p.name) === main);
  if (less) return { score: 0, drop: `doesn't use ${less.name}` };
  let s = e.importance;
  s += Math.min(SCORE.corroborationMax, Math.max(0, e.sources.length - 1));
  s += Math.min(SCORE.sightingMax, SCORE.sightingStep * Math.max(0, e.sightings - 1));
  if (e.primary) s += SCORE.primary;
  if (prefs?.entities.some((p) => p.direction === "more" && ents.includes(normalizeName(p.name)))) s += SCORE.entityMore;
  else if (shared?.entities.some((p) => p.direction === "more" && ents.includes(normalizeName(p.name)))) s += SCORE.sharedMore;
  for (const t of prefs?.topics ?? []) if (e.tags.includes(t.name)) s += t.direction === "more" ? SCORE.topic : -SCORE.topic;
  const ageFrom = e.published ? Date.parse(`${e.published}T00:00:00Z`) : Date.parse(e.firstSeen);
  const weeks = Math.floor(Math.max(0, Date.parse(now) - ageFrom) / (7 * DAY));
  s -= SCORE.perWeek * weeks;
  return { score: Math.round(Math.min(10, Math.max(0, s)) * 10) / 10 };
}

/** Re-score live candidates; drop the ones the reader's preferences rule out. */
export function rescore(pool: PoolEntry[], prefs: Pick<Preferences, "entities" | "topics"> | undefined, shared: Pick<SharedPreferences, "entities"> | undefined, now: string): PoolEntry[] {
  return pool.map((e) => {
    if (e.state !== "candidate") return e;
    const r = scoreEntry(e, prefs, shared, now);
    return r.drop ? { ...e, score: 0, state: "expired" as const, dropped: r.drop } : { ...e, score: r.score };
  });
}

// ── housekeeping ─────────────────────────────────────────────────────────────

/**
 * Expire candidates older than the window (by publication date, else first
 * sighting), return stale reservations to the pool, forget sent and expired
 * entries after KEEP_DAYS, and keep at most MAX_CANDIDATES live candidates.
 */
export function housekeep(pool: PoolEntry[], windowDays: number, now: string): PoolEntry[] {
  const t = Date.parse(now);
  const out = pool
    .filter((e) => !((e.state === "sent" || e.state === "expired") && t - Date.parse(e.sentAt ?? e.lastSeen) > KEEP_DAYS * DAY))
    .map((e) => {
      if (e.state === "reserved" && t - Date.parse(e.reservedAt ?? now) > RESERVATION_MS) {
        const { issue: _i, reservedAt: _r, ...rest } = e;
        return { ...rest, state: "candidate" as const };
      }
      if (e.state !== "candidate") return e;
      const from = e.published ? Date.parse(`${e.published}T00:00:00Z`) : Date.parse(e.firstSeen);
      return t - from > windowDays * DAY ? { ...e, state: "expired" as const, dropped: "older than the window" } : e;
    });
  const live = out.filter((e) => e.state === "candidate").sort((a, b) => b.score - a.score);
  const over = new Set(live.slice(MAX_CANDIDATES).map((e) => e.id));
  return over.size ? out.map((e) => (over.has(e.id) ? { ...e, state: "expired" as const, dropped: "pool full" } : e)) : out;
}

// ── the decision ─────────────────────────────────────────────────────────────

export type Decision =
  | { action: "none"; reason: string; strong: number; dueBy: string }
  | { action: "issue" | "issue-anyway"; reason: string; ids: string[]; strong: number };

/**
 * Whether to send an issue now (spec 0010, "When to send"):
 *   - `force` (a manual run): send what the pool has;
 *   - at least `sendAt` strong candidates and `minGap` since the last issue;
 *   - `maxGap` since the last issue: send anyway, whatever the pool holds (it may be empty);
 *   - otherwise nothing, with the reason.
 * `ids` are the candidates to include, strongest first, at most `maxItems`.
 */
export function decide(pool: PoolEntry[], s: ScoutSettings, lastIssueAt: string, now: string, maxItems: number, force = false): Decision {
  const live = pool.filter((e) => e.state === "candidate").sort((a, b) => b.score - a.score || b.sources.length - a.sources.length);
  const strong = live.filter((e) => e.score >= s.strong);
  const since = Date.parse(now) - Date.parse(lastIssueAt);
  const pick = (list: PoolEntry[]) => list.slice(0, maxItems).map((e) => e.id);
  // Worth sending at all: at least FLOOR; when nothing reaches it, the best three anyway.
  const worthy = live.filter((e) => e.score >= FLOOR);
  const anyway = worthy.length ? worthy : live.slice(0, 3);
  if (force) return { action: "issue", reason: "requested", ids: pick(anyway), strong: strong.length };
  if (strong.length >= s.sendAt && since >= s.minGapDays * DAY) {
    return { action: "issue", reason: `${strong.length} strong stories (≥ ${s.sendAt})`, ids: pick(worthy), strong: strong.length };
  }
  if (since >= s.maxGapDays * DAY) {
    return { action: "issue-anyway", reason: `${s.maxGapDays} days since the last issue`, ids: pick(anyway), strong: strong.length };
  }
  const dueBy = new Date(Date.parse(lastIssueAt) + s.maxGapDays * DAY).toISOString();
  const reason =
    strong.length >= s.sendAt
      ? `${strong.length} strong stories, but the last issue was less than ${s.minGapDays} days ago`
      : `${strong.length} of ${s.sendAt} strong stories`;
  return { action: "none", reason, strong: strong.length, dueBy };
}

/** A slot name for a time: 2026-11-16t0600. */
export function slotOf(iso: string): string {
  return iso.slice(0, 16).replace(/[:]/g, "").toLowerCase();
}

/** Scout settings from a definition, or undefined when the digest doesn't scout. */
export function scoutSettings(p: DigestProfile | undefined): ScoutSettings | undefined {
  return p?.scout ? { ...p.scout } : undefined;
}

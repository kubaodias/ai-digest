// Turning thumbs votes into reader preferences. Pure functions, no I/O, so
// they're covered by test/preferences.test.ts.
//
// A vote is about one digest item, which has topic tags ("security", "dev
// tooling"), entities (the specific products, companies or projects it's
// about: "postman") and a source domain. A thumb alone doesn't say which of
// those it's about, so:
//   - the reader can add a reason (one tap on the thanks page), which says
//     where the vote applies: the entity, the topic, the source, or nowhere
//     ("already knew it");
//   - "I don't use X" names one entity (an item about Postman also mentions
//     Codex and Claude Code; the reader picks which one they mean);
//   - without a reason, a vote applies to the item's main entity (listed
//     first) and only lightly to its topics;
//   - a topic counts as a preference only with evidence: an explicit "topic"
//     reason, or several votes the same way. One 👎 on a Postman story is
//     "skip Postman", not "less dev tooling".

export type Vote = "up" | "down";
export type DownReason = "entity" | "topic" | "source" | "known";
export type UpReason = "entity" | "topic" | "source";
export type Reason = DownReason | UpReason;

/** The 👎 options offered (no "weak source": the reader didn't want it). Older votes with a source reason still count. */
export const DOWN_REASONS: readonly DownReason[] = ["entity", "topic", "known"];
export const UP_REASONS: readonly UpReason[] = ["topic", "entity", "source"];

export function validReason(vote: Vote, r: unknown): r is Reason {
  return typeof r === "string" && (vote === "down" ? (DOWN_REASONS as readonly string[]) : (UP_REASONS as readonly string[])).includes(r);
}

/** The reason options' labels for the thanks page. */
export function reasonLabel(vote: Vote, r: Reason, entities: string[], tags: string[], source: string): string {
  const ent = entities.length ? entities.map(titleCase).join(", ") : "this product or company"; // pass one entity for a per-entity option
  const top = tags.length ? tags.join(", ") : "this topic";
  const src = source || "this source";
  if (vote === "down") {
    return { entity: `I don't use ${ent}`, topic: `Not interested in ${top}`, source: `${src} is a weak source`, known: "I already knew this" }[r as DownReason];
  }
  return { entity: `More about ${ent}`, topic: `More on ${top}`, source: `${src} is a good source`, known: "" }[r as UpReason];
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** One reason the reader selected; for "entity", which entity they meant. */
export interface Selection {
  r: Reason;
  target?: string;
}

export interface VoteLike {
  vote: Vote;
  tags: string[];
  entities?: string[];
  source: string;
  headline: string;
  /** The reasons the reader selected (any number; none means "no reason given"). */
  reasons?: Selection[];
  /** Older single-reason votes. Read through `selectionsOf`. */
  reason?: Reason;
  target?: string;
  at: string;
}

/** A vote's selected reasons, also for votes stored before multi-select. */
export function selectionsOf(v: Pick<VoteLike, "reasons" | "reason" | "target">): Selection[] {
  if (v.reasons) return v.reasons;
  return v.reason ? [{ r: v.reason, ...(v.target ? { target: v.target } : {}) }] : [];
}

const sameSelection = (a: Selection, b: Selection) => a.r === b.r && (a.target ?? "") === (b.target ?? "");

/** Select a reason if it isn't selected, deselect it if it is. */
export function toggleSelection(list: Selection[], sel: Selection): Selection[] {
  return list.some((x) => sameSelection(x, sel)) ? list.filter((x) => !sameSelection(x, sel)) : [...list, sel];
}

/**
 * How much one vote counts toward the item's main entity (or the reader's
 * chosen one), its other entities, its topics and its source, by reason.
 * With several reasons selected, each entity, topic and source takes the
 * strongest weight any of them gives it (so "I don't use Postman" plus "not
 * interested in security" is 1 for Postman and 1 for security, not more).
 */
export const WEIGHTS: Record<Reason | "none", { entity: number; otherEntities: number; topic: number; source: number }> = {
  none: { entity: 0.7, otherEntities: 0.2, topic: 0.25, source: 0.1 },
  entity: { entity: 1, otherEntities: 0, topic: 0, source: 0 },
  topic: { entity: 0.3, otherEntities: 0, topic: 1, source: 0 },
  source: { entity: 0, otherEntities: 0, topic: 0, source: 1 },
  known: { entity: 0, otherEntities: 0, topic: 0, source: 0 },
};

/** A topic needs this much net weight, and an explicit topic reason or this many same-direction votes, to count. */
export const TOPIC_MIN_SCORE = 0.75;
export const TOPIC_MIN_VOTES = 3;
/** An entity counts from one unexplained vote (0.7). */
export const ENTITY_MIN_SCORE = 0.7;
/** A source counts from an explicit reason, or many votes. */
export const SOURCE_MIN_SCORE = 1;

interface Acc {
  score: number;
  up: number;
  down: number;
  explicit: number;
}

export interface Preference {
  name: string;
  direction: "more" | "less";
  score: number;
  votes: number;
  basis: string;
}

export interface Preferences {
  votes: number;
  /** Specific products/companies/projects. Apply strictly. */
  entities: Preference[];
  /** Topics with enough evidence. Apply softly (ranking weight). */
  topics: Preference[];
  /** Topics with some signal but not enough evidence yet. Don't act on these. */
  tentativeTopics: Preference[];
  sources: Preference[];
  /** Items the reader marked "already knew this". */
  alreadyKnown: string[];
  recent: { vote: Vote; reasons: string[]; headline: string; entities: string[]; tags: string[]; at: string }[];
  guidance: string;
}

function add(map: Map<string, Acc>, key: string, sign: number, weight: number, vote: Vote, explicit: boolean) {
  if (!key || weight === 0) return;
  const a = map.get(key) ?? { score: 0, up: 0, down: 0, explicit: 0 };
  a.score += sign * weight;
  a[vote]++;
  if (explicit) a.explicit++;
  map.set(key, a);
}

const round = (n: number) => Math.round(n * 100) / 100;

function toPrefs(map: Map<string, Acc>, keep: (a: Acc) => boolean, basis: (a: Acc) => string): Preference[] {
  return [...map.entries()]
    .filter(([, a]) => keep(a) && a.score !== 0)
    .map(([name, a]) => ({ name, direction: a.score > 0 ? ("more" as const) : ("less" as const), score: round(a.score), votes: a.up + a.down, basis: basis(a) }))
    .sort((x, y) => Math.abs(y.score) - Math.abs(x.score));
}

/** The reader's preferences from the vote log. */
export function computePreferences(votes: VoteLike[]): Preferences {
  const entities = new Map<string, Acc>();
  const topics = new Map<string, Acc>();
  const sources = new Map<string, Acc>();
  const alreadyKnown: string[] = [];
  for (const v of votes) {
    const sign = v.vote === "up" ? 1 : -1;
    const ents = v.entities ?? [];
    const sels = selectionsOf(v);
    if (!sels.length) {
      const w = WEIGHTS.none;
      if (ents[0]) add(entities, ents[0], sign, w.entity, v.vote, false);
      for (const e of ents.slice(1)) add(entities, e, sign, w.otherEntities, v.vote, false);
      for (const t of v.tags) add(topics, t, sign, w.topic, v.vote, false);
      add(sources, v.source, sign, w.source, v.vote, false);
      continue;
    }
    // Several reasons: the strongest weight per entity/topic/source, counted once.
    const ew = new Map<string, { w: number; explicit: boolean }>();
    const tw = new Map<string, { w: number; explicit: boolean }>();
    const sw = new Map<string, { w: number; explicit: boolean }>();
    const bump = (m: Map<string, { w: number; explicit: boolean }>, k: string | undefined, w: number, explicit: boolean) => {
      if (!k || w === 0) return;
      const c = m.get(k);
      m.set(k, { w: Math.max(w, c?.w ?? 0), explicit: explicit || !!c?.explicit });
    };
    for (const sel of sels) {
      if (sel.r === "known") alreadyKnown.push(v.headline);
      if (sel.r === "entity") bump(ew, sel.target ?? ents[0], WEIGHTS.entity.entity, true);
      if (sel.r === "topic") {
        for (const t of v.tags) bump(tw, t, WEIGHTS.topic.topic, true);
        bump(ew, ents[0], WEIGHTS.topic.entity, false);
      }
      if (sel.r === "source") bump(sw, v.source, WEIGHTS.source.source, true);
    }
    for (const [k, x] of ew) add(entities, k, sign, x.w, v.vote, x.explicit);
    for (const [k, x] of tw) add(topics, k, sign, x.w, v.vote, x.explicit);
    for (const [k, x] of sw) add(sources, k, sign, x.w, v.vote, x.explicit);
  }
  const sameWay = (a: Acc) => Math.max(a.up, a.down);
  const topicQualifies = (a: Acc) => Math.abs(a.score) >= TOPIC_MIN_SCORE - 1e-9 && (a.explicit > 0 || sameWay(a) >= TOPIC_MIN_VOTES);
  const basis = (kind: string) => (a: Acc) => (a.explicit ? `${a.explicit} explicit ${kind} reason${a.explicit > 1 ? "s" : ""}` : `${a.up + a.down} vote${a.up + a.down > 1 ? "s" : ""} without a reason`);
  const recent = [...votes]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 12)
    .map((v) => ({ vote: v.vote, reasons: selectionsOf(v).map((x) => (x.target ? `${x.r}:${x.target}` : x.r)), headline: v.headline, entities: v.entities ?? [], tags: v.tags, at: v.at.slice(0, 10) }));
  return {
    votes: votes.length,
    entities: toPrefs(entities, (a) => Math.abs(a.score) >= ENTITY_MIN_SCORE - 1e-9, basis("entity")),
    topics: toPrefs(topics, topicQualifies, basis("topic")),
    tentativeTopics: toPrefs(topics, (a) => !topicQualifies(a), basis("topic")),
    sources: toPrefs(sources, (a) => Math.abs(a.score) >= SOURCE_MIN_SCORE - 1e-9, basis("source")),
    alreadyKnown,
    recent,
    guidance:
      "Apply entity preferences strictly (skip or favour items mainly about that product/company), topic preferences softly (ranking weight only), and ignore tentativeTopics. Never drop major news because of a preference.",
  };
}

/** What's written to Agent Memory for a vote: one sentence per selected reason, or the no-reason sentence. */
export function memorySentence(v: VoteLike): string {
  const sels = selectionsOf(v);
  return sels.length ? sels.map((sel) => sentence(v, sel)).join(" ") : sentence(v, undefined);
}

function sentence(v: VoteLike, sel: Selection | undefined): string {
  const ents = (sel?.r === "entity" && sel.target ? [sel.target] : (v.entities ?? []).slice(0, 1)).map(titleCase).join(", ");
  const tags = v.tags.join(", ");
  const item = `"${v.headline}"`;
  if (v.vote === "down") {
    switch (sel?.r) {
      case "entity":
        return ents
          ? `Digest feedback: I don't use ${ents} — skip news mainly about ${ents} (from ${item}). This says nothing about the wider topic.`
          : `Digest feedback: I don't use the product or company in ${item} — skip news mainly about it. This says nothing about the wider topic.`;
      case "topic":
        return `Digest feedback: I'm not interested in ${tags || "the topic of " + item} — show less of it (from ${item}).`;
      case "source":
        return `Digest feedback: I find ${v.source || "this source"} a weak source — prefer other coverage (from ${item}).`;
      case "known":
        return `Digest feedback: I already knew about ${item}; it was too obvious to include. No topic preference.`;
      default:
        return `Digest feedback: ${item} wasn't useful to me${ents ? ` (about ${ents})` : ""}. Reason not given, so don't assume I dislike its topics (${tags || "unspecified"}).`;
    }
  }
  switch (sel?.r) {
    case "entity":
      return `Digest feedback: I want more news about ${ents || "the company or product in " + item} (from ${item}).`;
    case "topic":
      return `Digest feedback: I want more on ${tags || "the topic of " + item} (from ${item}).`;
    case "source":
      return `Digest feedback: ${v.source || "this source"} is a good source for me (from ${item}).`;
    default:
      return `Digest feedback: I found ${item} useful${ents ? ` (about ${ents})` : ""}; topics: ${tags || "unspecified"}.`;
  }
}

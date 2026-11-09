// The requests for watching (docs/spec/0010-continuous-scouting.md):
// a check (find new candidates, answer JSON) and an issue written from
// the pool (no new search). Kept apart from agent.ts so the class file has no
// long template strings. Pure; covered by test/pool.test.ts.

import { GENERAL_ID, type DigestProfile } from "./profile.ts";
import type { PoolEntry } from "./pool.ts";
import { KNOWN_IN_REQUEST, MAX_PER_ENTITY, MAX_PER_CHECK, trending } from "./pool.ts";

/** Tool calls a check may make. */
export const CHECK_BUDGET = 8;
/** Links an issue's writer may check with fetch_page. */
export const WRITER_CHECKS = 3;
/** Sources listed per item. */
export const SOURCES_PER_ITEM = 3;

/** What a run may spend on the web tools, by its conversation: checks and issues written from the pool. */
export interface ToolBudget {
  /** web_search and research calls. */
  search: number;
  /** fetch_page calls. */
  fetch: number;
  /** Both together. */
  total: number;
  what: string;
}

export function toolBudget(conversation: string): ToolBudget | undefined {
  // One-off General runs are named after their topic ("__general--check-point-…"): never a check or an issue.
  if (conversation.startsWith(`${GENERAL_ID}--`)) return undefined;
  if (/--check-[a-z0-9-]+$/.test(conversation)) return { search: CHECK_BUDGET, fetch: CHECK_BUDGET, total: CHECK_BUDGET, what: "this check" };
  if (/--issue-[a-z0-9-]+$/.test(conversation)) return { search: 0, fetch: WRITER_CHECKS, total: WRITER_CHECKS, what: "writing this issue" };
  return undefined;
}

/**
 * Count one web tool call against a budget. Returns why it's refused (the model
 * sees it as the tool's error and answers with what it has), or undefined and
 * counts it. Paths are the TELNYX client's: /web_search, /web_search/contents, /web_search/research.
 */
export function spendTool(budget: ToolBudget, used: { search: number; fetch: number }, path: string): string | undefined {
  const kind = /\/web_search\/contents/.test(path) ? "fetch" : /\/web_search/.test(path) ? "search" : undefined;
  if (!kind) return undefined;
  if (kind === "search" && budget.search === 0) return `no web searches when ${budget.what}: write from what you were given`;
  if (used.search + used.fetch >= budget.total || used[kind] >= budget[kind]) {
    return `budget spent: ${budget.total} tool calls is the limit for ${budget.what}. Don't call tools again; answer now with what you have`;
  }
  used[kind]++;
  return undefined;
}

/** A date range as titles show it: "November 4–7, 2026", "October 30 – November 5, 2026". */
export function formatRange(from: string, to: string): string {
  const d = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  const [a, b] = [d(from), d(to)].sort((x, y) => x.getTime() - y.getTime()) as [Date, Date];
  const month = (x: Date) => x.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const [ay, by, ad, bd] = [a.getUTCFullYear(), b.getUTCFullYear(), a.getUTCDate(), b.getUTCDate()];
  if (ay !== by) return `${month(a)} ${ad}, ${ay} – ${month(b)} ${bd}, ${by}`;
  if (month(a) !== month(b)) return `${month(a)} ${ad} – ${month(b)} ${bd}, ${by}`;
  return ad === bd ? `${month(a)} ${ad}, ${ay}` : `${month(a)} ${ad}–${bd}, ${ay}`;
}

/** The range an issue's stories cover: their publication dates (else when they were found). */
export function storiesRange(entries: Pick<PoolEntry, "published" | "firstSeen">[]): string | undefined {
  const days = entries.map((e) => e.published ?? e.firstSeen.slice(0, 10)).filter((x) => /^\d{4}-\d{2}-\d{2}/.test(x)).sort();
  return days.length ? formatRange(days[0]!, days[days.length - 1]!) : undefined;
}

const fence = "```";

/** The request for one check. */
export function checkMessage(p: DigestProfile, opts: { since: string; until: string; known: Pick<PoolEntry, "id" | "headline">[] }): string {
  const known = opts.known.slice(0, KNOWN_IN_REQUEST);
  return [
    `WATCH CHECK. This is not a digest request: don't write a digest and don't call reader_preferences.`,
    ``,
    `Find new stories for the digest described below, published between ${opts.since.slice(0, 16).replace("T", " ")} and ${opts.until.slice(0, 16).replace("T", " ")} UTC.`,
    `Budget: at most ${CHECK_BUDGET} tool calls in total (web_search and fetch_page together), a few at a time. Count them; when you reach ${CHECK_BUDGET}, stop and answer with what you have, even if it's little. Report at most ${MAX_PER_CHECK} candidates, the most important first. Only stories you found with your tools in this check; link the specific article, prefer primary sources (the maker's own post, release notes, the paper, the repository). Never invent links, dates or facts.`,
    `Look broadly: news sites and blogs, Hacker News, Reddit and other communities, research, as well as the makers' own announcements. Spend at most 2 tool calls on release notes or changelog pages, and report at most ${MAX_PER_ENTITY} candidates about the same product or company.`,
    `When other outlets cover the same story, list their article URLs (up to 4) in "otherSources": that's how stories everyone is talking about are recognised. Count articles that report on the story and discussion threads (Hacker News, Reddit); not link roundups, newsletters or lists that only collect links. Set "url" to the maker's own page when you found it (the post, changelog, paper, repository), not a third-party write-up of it.`,
    ``,
    `What the digest covers and who it's for:`,
    p.description,
    ``,
    known.length
      ? `Already known (don't report these as candidates; list the ids of any you come across again under "seen", with the URLs of sources covering them that you found; report a better primary source as a candidate with "sameAs" set to its id):\n${known.map((k) => `- [${k.id}] ${k.headline}`).join("\n")}`
      : `Nothing is known yet: this is the first check.`,
    ``,
    `Answer with JSON only, no prose before or after:`,
    `${fence}json`,
    `{"candidates": [{"headline": "…", "url": "https://…", "source": "example.com", "published": "YYYY-MM-DD", "summary": "one or two sentences", "importance": 1-10, "why": "why it matters for this digest's reader", "otherSources": ["https://…"], "primary": true, "sameAs": null}], "seen": [{"id": "…", "sources": ["https://…"]}]}`,
    fence,
    `importance: 9–10 only for major, field-changing news; 7–8 clearly worth the reader's time; 5–6 useful; 1–4 marginal. An empty list is a fine answer when nothing new fits.`,
  ].join("\n");
}

/** The request for an issue written from the pool's chosen stories. */
export function writerMessage(p: DigestProfile, entries: PoolEntry[], opts: { quiet: boolean; focus?: string }): string {
  const range = storiesRange(entries);
  const title = p.title.includes("{range}") ? p.title.replace("{range}", range ?? "<the date range the stories cover>") : p.title;
  const stories = entries.map((e, k) =>
    [
      `${k + 1}. ${e.headline}`,
      `   link: ${e.url}${e.published ? ` (published ${e.published})` : ""}`,
      ...(e.sources.length > 1 ? [`   also covered by: ${e.sources.filter((s) => s.url !== e.url).map((s) => s.url).join(", ")}`] : []),
      ...(e.entities[0] ? [`   about: ${e.entities[0]}`] : []),
      ...(trending(e) ? [`   trending: covered by ${e.sources.length} independent sources`] : []),
      `   summary: ${e.summary}`,
      ...(e.why ? [`   why: ${e.why}`] : []),
    ].join("\n"),
  );
  return [
    `WRITE AN ISSUE FROM THESE STORIES. Don't search the web and don't call reader_preferences: the stories were already found, checked and ranked. Use fetch_page at most ${WRITER_CHECKS} times, only for a story without a primary source or whose summary you doubt; drop a story whose link is dead or doesn't match. Never add stories that aren't listed, and don't mention the ones you drop (no notes about dropped or unverifiable stories anywhere in the issue: it goes to the reader as written).`,
    `Sources: on each item's source line list the story's sources given below, up to ${SOURCES_PER_ITEM}, as "**Sources:** [site](url) · [site](url) · date" (one source: "**Source:**"). Order them: the maker's own page first (official post, changelog, paper, repository), then independent reporting, then discussion threads (Hacker News, Reddit); leave out link roundups and newsletters that only collect links. If a story's link is a third-party write-up but its sources include the maker's own page, base the item on the maker's page. If none of a story's sources is the maker's own page (a paper, release, repository or announcement only reported by others), spend a fetch_page check on its best write-up to find the link to the original and list that first; leave it out if you don't find one. Only for a story marked trending, say in "Why it matters" that it's widely covered (e.g. "covered by 4 outlets"), and then list at least two of its sources; don't call other stories widely covered.`,
    `Merge stories about the same product into one item when they're parts of one update (e.g. consecutive releases): one headline, the combined substance, their sources together.`,
    ``,
    `Title: ${title}${range ? " (use it as given)" : ""}`,
    `Items: at most ${p.items.max}, in the order given unless merging duplicates. ${opts.quiet ? "This is the regular issue for a quieter period: fewer items are fine; don't pad." : ""}`.trim(),
    p.closing ? `Closing section: "## ${p.closing}" with 2–4 bullets connecting the items.` : `Closing section: none.`,
    ``,
    `What the digest covers and who it's for:`,
    p.description,
    ...(opts.focus?.trim() ? [``, `For this issue in particular: ${opts.focus.trim()}`] : []),
    ``,
    `The stories:`,
    stories.join("\n\n"),
    ``,
    `Write it in the usual digest format (numbered "## N." items with "Why it matters" and "Source").`,
  ].join("\n");
}

/** The email for an issue that falls due with nothing in the pool. */
export function quietNote(p: DigestProfile, since: string, until: string): { subject: string; markdown: string } {
  const range = formatRange(since, until);
  const subject = p.title.includes("{range}") ? p.title.replace("{range}", range) : `${p.title} (${range})`;
  return { subject, markdown: `# ${subject}\n\nNothing new met the bar for this digest between ${range}. The next issue follows when there's more worth reading.\n` };
}

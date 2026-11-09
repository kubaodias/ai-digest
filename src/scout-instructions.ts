// The requests for continuous scouting (docs/spec/0010-continuous-scouting.md):
// a scout pass (find new candidates, answer JSON) and an issue written from
// the pool (no new search). Kept apart from agent.ts so the class file has no
// long template strings. Pure; covered by test/pool.test.ts.

import type { DigestProfile } from "./profile.ts";
import type { PoolEntry } from "./pool.ts";
import { KNOWN_IN_REQUEST, MAX_PER_ENTITY, MAX_PER_PASS, trending } from "./pool.ts";

/** Tool calls a scout pass may make. */
export const SCOUT_BUDGET = 8;
/** Links an issue's writer may check with fetch_page. */
export const WRITER_CHECKS = 3;
/** Sources listed per item. */
export const SOURCES_PER_ITEM = 3;

const fence = "```";

/** The request for one scout pass. */
export function scoutMessage(p: DigestProfile, opts: { since: string; until: string; known: Pick<PoolEntry, "id" | "headline">[] }): string {
  const known = opts.known.slice(0, KNOWN_IN_REQUEST);
  return [
    `SCOUT PASS. This is not a digest request: don't write a digest and don't call reader_preferences.`,
    ``,
    `Find new stories for the digest described below, published between ${opts.since.slice(0, 16).replace("T", " ")} and ${opts.until.slice(0, 16).replace("T", " ")} UTC.`,
    `Budget: at most ${SCOUT_BUDGET} tool calls in total (web_search and fetch_page together), a few at a time. Count them; when you reach ${SCOUT_BUDGET}, stop and answer with what you have, even if it's little. Report at most ${MAX_PER_PASS} candidates, the most important first. Only stories you found with your tools in this pass; link the specific article, prefer primary sources (the maker's own post, release notes, the paper, the repository). Never invent links, dates or facts.`,
    `Look broadly: news sites and blogs, Hacker News, Reddit and other communities, research, as well as the makers' own announcements. Spend at most 2 tool calls on release notes or changelog pages, and report at most ${MAX_PER_ENTITY} candidates about the same product or company.`,
    `When other outlets cover the same story, list their article URLs (up to 4) in "otherSources": that's how stories everyone is talking about are recognised.`,
    ``,
    `What the digest covers and who it's for:`,
    p.description,
    ``,
    known.length
      ? `Already known (don't report these as candidates; list the ids of any you come across again under "seen", with the URLs of sources covering them that you found; report a better primary source as a candidate with "sameAs" set to its id):\n${known.map((k) => `- [${k.id}] ${k.headline}`).join("\n")}`
      : `Nothing is known yet: this is the first pass.`,
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
  const title = p.title.includes("{range}") ? p.title.replace("{range}", "<the date range the stories cover>") : p.title;
  const stories = entries.map((e, k) =>
    [
      `${k + 1}. ${e.headline}`,
      `   link: ${e.url}${e.published ? ` (published ${e.published})` : ""}`,
      ...(e.sources.length > 1 ? [`   also covered by: ${e.sources.filter((s) => s.url !== e.url).map((s) => s.url).join(", ")}`] : []),
      ...(trending(e) ? [`   trending: covered by ${e.sources.length} sources${e.sightings > 1 ? `, found in ${e.sightings} searches` : ""}`] : []),
      `   summary: ${e.summary}`,
      ...(e.why ? [`   why: ${e.why}`] : []),
    ].join("\n"),
  );
  return [
    `WRITE AN ISSUE FROM THESE STORIES. Don't search the web and don't call reader_preferences: the stories were already found, checked and ranked. Use fetch_page at most ${WRITER_CHECKS} times, only for a story without a primary source or whose summary you doubt; drop a story whose link is dead or doesn't match. Never add stories that aren't listed.`,
    `Sources: on each item's source line list the story's sources given below, up to ${SOURCES_PER_ITEM}, as "**Sources:** [site](url) · [site](url) · date" (one source: "**Source:**"). For a story marked trending, say in "Why it matters" that it's widely covered (e.g. "covered by 4 outlets").`,
    ``,
    `Title: ${title}`,
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
  const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const range = `${fmt(since)} – ${fmt(until)}`;
  const subject = p.title.includes("{range}") ? p.title.replace("{range}", range) : `${p.title} (${range})`;
  return { subject, markdown: `# ${subject}\n\nNothing new met the bar for this digest between ${range}. The next issue follows when there's more worth reading.\n` };
}

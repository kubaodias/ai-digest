// The requests for continuous scouting (docs/spec/0010-continuous-scouting.md):
// a scout pass (find new candidates, answer JSON) and an issue written from
// the pool (no new search). Kept apart from agent.ts so the class file has no
// long template strings. Pure; covered by test/pool.test.ts.

import type { DigestProfile } from "./profile.ts";
import type { PoolEntry } from "./pool.ts";
import { KNOWN_IN_REQUEST, MAX_PER_PASS } from "./pool.ts";

/** Tool calls a scout pass may make. */
export const SCOUT_BUDGET = 8;

const fence = "```";

/** The request for one scout pass. */
export function scoutMessage(p: DigestProfile, opts: { since: string; until: string; known: Pick<PoolEntry, "id" | "headline">[] }): string {
  const known = opts.known.slice(0, KNOWN_IN_REQUEST);
  return [
    `SCOUT PASS. This is not a digest request: don't write a digest and don't call reader_preferences.`,
    ``,
    `Find new stories for the digest described below, published between ${opts.since.slice(0, 16).replace("T", " ")} and ${opts.until.slice(0, 16).replace("T", " ")} UTC.`,
    `Budget: at most ${SCOUT_BUDGET} tool calls (web_search and fetch_page), a few at a time, then answer. Report at most ${MAX_PER_PASS} candidates, the most important first. Only stories you found with your tools in this pass; link the specific article, prefer primary sources (the maker's own post, release notes, the paper, the repository). Never invent links, dates or facts.`,
    ``,
    `What the digest covers and who it's for:`,
    p.description,
    ``,
    known.length
      ? `Already known (skip these unless you found a better primary source or another independent source covering them; then report it with "sameAs" set to its id):\n${known.map((k) => `- [${k.id}] ${k.headline}`).join("\n")}`
      : `Nothing is known yet: this is the first pass.`,
    ``,
    `Answer with JSON only, no prose before or after:`,
    `${fence}json`,
    `{"candidates": [{"headline": "…", "url": "https://…", "source": "example.com", "published": "YYYY-MM-DD", "summary": "one or two sentences", "importance": 1-10, "why": "why it matters for this digest's reader", "otherSources": ["https://…"], "primary": true, "sameAs": null}]}`,
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
      `   summary: ${e.summary}`,
      ...(e.why ? [`   why: ${e.why}`] : []),
    ].join("\n"),
  );
  return [
    `WRITE AN ISSUE FROM THESE STORIES. Don't search the web and don't call reader_preferences: the stories were already found and ranked. Use fetch_page only to confirm a link works and says what the summary claims; drop a story whose link is dead or doesn't match. Never add stories that aren't listed.`,
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

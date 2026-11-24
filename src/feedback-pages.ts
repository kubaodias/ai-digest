// The pages a thumbs click opens: thanks (with reason links), undone, errors.

import { assetUrl, type DigestItemRecord, type DigestRecord, type StoredVote } from "./feedback.ts";
import { DOWN_REASONS, ENTITY_OPTIONS, UP_REASONS, reasonLabel, selectionsOf, type Preferences } from "./preferences.ts";
import { esc, page } from "./pages.ts";

const icon = (base: string, name: "thumb-up.png" | "thumb-down.png", size = 18) => `<img src="${assetUrl(base, name)}" width="${size}" height="${size}" alt="" style="vertical-align:-3px">`;

export interface ThanksContext {
  /** This page's feedback URL (icons are served from it). */
  base: string;
  vote: StoredVote;
  item?: DigestItemRecord;
  digest?: DigestRecord;
  prefs: Preferences;
  /** Reason links by option: "entity:0".."entity:<ENTITY_OPTIONS-1>" (one per entity), "entity" (no entities known), "topic", "known". */
  links: { undo: string; flip: string; view?: string; reasons: Record<string, string> };
}

/** What the selected reasons (or none) do with the vote, one sentence each. */
export function effect(v: StoredVote, entities: string[], tags: string[]): string {
  const more = v.vote === "up";
  const top = tags.join(", ") || "its topics";
  const sels = selectionsOf(v);
  if (!sels.length) {
    return `Without a reason this counts mostly toward ${entities[0] || "this product or company"}, and only a little toward ${top}. Topics need a few votes the same way before they change anything.`;
  }
  const parts = sels.map((sel) => {
    const ent = sel.target ?? entities[0] ?? "this product or company";
    switch (sel.r) {
      case "entity":
        return more ? `Items mainly about ${ent} will rank higher.` : `Items mainly about ${ent} will be skipped.`;
      case "topic":
        return more ? `${top} will rank higher.` : `${top} will rank lower. Major news still gets through.`;
      default:
        return "Noted as too obvious.";
    }
  });
  if (!sels.some((x) => x.r === "topic") && sels.some((x) => x.r === "entity")) parts.push(`Its topics (${top}) aren't affected.`);
  return parts.join(" ");
}

export function thanksPage(c: ThanksContext): Response {
  const up = c.vote.vote === "up";
  const it = c.item;
  const headline = it?.headline ?? c.vote.headline;
  const tags = it?.tags ?? c.vote.tags;
  const entities = it?.entities?.length ? it.entities : (c.vote.entities ?? []);
  const source = it?.source ?? c.vote.source;
  const sels = selectionsOf(c.vote);
  const options: { key: string; label: string; on: boolean }[] = [];
  for (const r of up ? UP_REASONS : DOWN_REASONS) {
    if (r === "entity") {
      entities.slice(0, ENTITY_OPTIONS).forEach((e, k) => {
        if (c.links.reasons[`entity:${k}`]) options.push({ key: `entity:${k}`, label: reasonLabel(c.vote.vote, r, [e], tags), on: sels.some((x) => x.r === "entity" && (x.target ?? entities[0]) === e) });
      });
      if (!entities.length && c.links.reasons.entity) options.push({ key: "entity", label: reasonLabel(c.vote.vote, r, [], tags), on: sels.some((x) => x.r === "entity") });
    } else if (c.links.reasons[r]) {
      options.push({ key: r, label: reasonLabel(c.vote.vote, r, entities, tags), on: sels.some((x) => x.r === r) });
    }
  }
  const chips = options
    .map((o) => `<a class="reason${o.on ? " on" : ""}" data-inplace href="${c.links.reasons[o.key]}" aria-pressed="${o.on}" title="${o.on ? "Selected: click to deselect" : "Click to select"}">${o.on ? "✓ " : ""}${esc(o.label)}</a>`)
    .join("");
  const relevant = (list: { name: string; direction: string; score: number; votes: number }[], names: string[]) =>
    list.filter((p) => names.includes(p.name)).map((p) => `<tr><td>${esc(p.name)}</td><td class="n">${p.direction === "more" ? icon(c.base, "thumb-up.png", 14) : icon(c.base, "thumb-down.png", 14)} ${p.direction} · ${p.votes} vote${p.votes > 1 ? "s" : ""}</td></tr>`);
  const rows = [
    ...relevant(c.prefs.entities, entities),
    ...relevant(c.prefs.topics, tags),
    ...relevant(c.prefs.tentativeTopics, tags).map((r) => r.replace("</td><td", " <span class=\"faint\">(not enough votes yet)</span></td><td")),
  ].join("");
  return page(
    up ? "More like this" : "Less like this",
    `<h1>${it?.url ? `<a href="${esc(it.url)}">${esc(headline)}</a>` : esc(headline)}</h1>
<div class="card">
  <h2>${icon(c.base, up ? "thumb-up.png" : "thumb-down.png", 22)} ${up ? "More like this" : "Less like this"}</h2>
  <p class="muted">Saved. ${sels.length ? "Your reasons are selected below; click one to deselect it." : "Why? Select all that apply:"}</p>
  ${chips ? `<div class="reasons">${chips}</div>` : ""}
  <div class="row"><a data-inplace href="${c.links.flip}">${up ? "Change to less like this" : "Change to more like this"}</a><a data-inplace href="${c.links.undo}">Undo</a>${c.links.view ? `<a href="${c.links.view}">View the digest</a>` : ""}</div>
</div>
<div class="card">
  ${it?.why ? `<p>${esc(it.why)}</p>` : ""}
  ${it?.image ? `<img class="pic" src="${esc(it.image.url)}" alt="${esc(it.image.caption)}"><p class="faint">${esc(it.image.caption)}</p>` : ""}
  <p class="faint">${it?.url ? `<a href="${esc(it.url)}">${esc(source || it.url)}</a>` : esc(source)}</p>
  ${entities.length || tags.length ? `<div class="chips">${[...entities.map((e) => `<span class="chip"><strong>${esc(e)}</strong></span>`), ...tags.map((t) => `<span class="chip">${esc(t)}</span>`)].join("")}</div>` : ""}
</div>
<div class="card">
  <p class="label">What this feeds</p>
  <p class="muted">${esc(effect(c.vote, entities, tags))}</p>
  ${rows ? `<table>${rows}</table>` : ""}
  <p class="faint">${c.prefs.votes} vote${c.prefs.votes === 1 ? "" : "s"} so far. Kept in the agent's vote log and its Agent Memory.</p>
</div>`,
  );
}

export function undonePage(headline: string, view?: string): Response {
  return page(
    "Feedback removed",
    `<div class="card"><h2>Feedback removed</h2><p class="muted">${esc(headline)}</p>${view ? `<div class="row"><a href="${view}">View the digest</a></div>` : ""}</div>`,
  );
}

export function errorPage(status: number, message: string): Response {
  return page("Feedback", `<div class="card"><h2>That link didn't work</h2><p class="muted">${esc(message)}</p></div>`, status);
}

// The talk page (src/talk.ts has the links, tokens and tools): the issue as it
// looked in the email (its own HTML), with a voice dock at the bottom. Each
// story gets 👍/👎 with reasons and a "Discuss" button; while a conversation
// is live, Discuss switches it to that story without reconnecting.

import { esc, type DigestRecord } from "./feedback.ts";
import { DOWN_REASONS, UP_REASONS, reasonLabel } from "./preferences.ts";
import { AGENT_LIB, headerValue, issueBrief } from "./talk.ts";
import { talkGreeting } from "./talk-instructions.ts";
import { ISSUE_END, ISSUE_START } from "./agent.ts";

export interface TalkPageInput {
  token: string;
  assistantId: string;
  record: DigestRecord;
  /** The story the link came from (item number). */
  start?: number;
  /** The issue's email body (HTML, with its inline styles); built from the items when missing. */
  body?: string;
  /** Votes already given on this issue: item number → vote and reasons. */
  votes: Record<number, { vote: string; reasons: { r: string; target?: string }[] }>;
  /** Start the conversation on load (a talk link); false for a thumbs click or view link from the email. */
  autostart?: boolean;
  /** The story just voted on from the email: its reasons are shown open. */
  voted?: number;
}

/** The issue without the email's frame: between the marks renderEmailHtml puts around it. */
export function emailBody(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const from = html.indexOf(ISSUE_START), to = html.indexOf(ISSUE_END);
  if (from >= 0 && to > from) return html.slice(from + ISSUE_START.length, to).replace(/^\n|\n$/g, "");
  // Issues sent before the marks: the email's content cell.
  return html.match(/<td style="padding:28px 28px 8px;[^"]*">\n?([\s\S]*?)\n?<\/td><\/tr>\s*<tr><td style="padding:14px 28px 22px/)?.[1];
}

/** A plain body for an issue whose HTML isn't stored. */
function bodyFromItems(record: DigestRecord): string {
  const items = record.items
    .map((i) => `<h2>${i.n}. ${esc(i.headline)}</h2><p>${esc(i.why)}</p>${i.url ? `<p><a href="${esc(i.url)}">${esc(i.source || i.url)}</a></p>` : ""}`)
    .join("\n");
  return `<h1>${esc(record.subject)}</h1>\n${items}`;
}

/** The reason chips for each vote, as on the feedback page. */
function reasonOptions(entities: string[], tags: string[]) {
  const opts = (vote: "up" | "down", list: readonly string[]) =>
    list.flatMap((r) =>
      r === "entity" && entities.length
        ? entities.slice(0, 3).map((e, x) => ({ r, x, target: e, label: reasonLabel(vote, r as any, [e], tags) }))
        : [{ r, label: reasonLabel(vote, r as any, entities, tags) }],
    );
  return { up: opts("up", UP_REASONS), down: opts("down", DOWN_REASONS) };
}

const ICON = {
  mic: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/></svg>`,
  micOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 4.9 2.3M19 11a7 7 0 0 1-1.4 4.2M5 11a7 7 0 0 0 11.3 5.5M12 18v3M3 3l18 18"/></svg>`,
  end: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 14.5c4.7-4.2 12.3-4.2 17 0l-1.8 2.3a1 1 0 0 1-1.3.2l-2.3-1.5a1 1 0 0 1-.4-1v-1.6a11 11 0 0 0-5.4 0v1.6a1 1 0 0 1-.4 1l-2.3 1.5a1 1 0 0 1-1.3-.2Z"/></svg>`,
  headphones: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/></svg>`,
};

export function talkPage({ token, assistantId, record, start, body, votes, autostart = true, voted }: TalkPageInput): Response {
  const brief = issueBrief(record);
  const greet = (s?: string) => headerValue(talkGreeting(brief.digest, brief.sent, brief.stories.length, s));
  const data = {
    token,
    assistantId,
    lib: AGENT_LIB,
    brief,
    start: start ?? null,
    autostart,
    voted: voted ?? null,
    digest: headerValue(brief.digest, 120),
    greeting: greet(),
    items: record.items.map((i) => ({
      n: i.n,
      headline: i.headline,
      greeting: greet(i.headline),
      reasons: reasonOptions(i.entities ?? [], i.tags ?? []),
    })),
    votes,
    icons: { mic: ICON.mic, micOff: ICON.micOff },
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const content = body ?? bodyFromItems(record);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#f5f5f4"><link rel="icon" href="data:,"><title>${esc(record.subject)}</title>
<style>
:root{--bg:#f5f5f4;--card:#fff;--text:#1f2937;--muted:#6b7280;--faint:#9ca3af;--line:#e5e7eb;--link:#2563eb;
--g:#10b981;--g-strong:#047857;--g-soft:#ecfdf5;--g-line:#a7f3d0;--you:#d97706;--up:#047857;--up-bg:#d1fae5;--down:#c2410c;--down-bg:#ffedd5;--ink:#1f2937;--danger:#dc2626}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:680px;margin:0 auto;padding:16px 12px calc(120px + env(safe-area-inset-bottom))}
#issue{background:var(--card);border-radius:10px;padding:24px 22px 12px}
@media (min-width:600px){.wrap{padding-top:24px}#issue{padding:28px 28px 12px}}
#issue img{max-width:100%;height:auto}
/* A story: the email's section, plus a highlight while it's being discussed. */
.story{position:relative;margin:0 -12px;padding:0 12px 6px;border-radius:10px;transition:background .3s}
.story.active{background:var(--g-soft);box-shadow:0 0 0 1px var(--g),0 0 0 4px rgba(16,185,129,.15)}
.story.active h2{border-top-color:transparent!important}
.acts{display:flex;align-items:center;gap:8px;margin:12px 0 4px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--text);font:600 14px/1 inherit;font-family:inherit;cursor:pointer}
.btn svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.btn.discuss{color:var(--muted);background:transparent;border-color:transparent;padding:0 10px 0 4px;font-weight:500}.btn.discuss:hover{color:var(--text)}
.story.active .btn.discuss{background:var(--g-strong);border-color:var(--g-strong);color:#fff}
.eq{display:none;gap:2px;align-items:flex-end;height:12px}.eq i{width:3px;background:currentColor;border-radius:2px;animation:eq 1s ease-in-out infinite}
.eq i:nth-child(2){animation-delay:-.3s}.eq i:nth-child(3){animation-delay:-.6s}
@keyframes eq{0%,100%{height:3px}50%{height:12px}}
.story.active .btn.discuss .eq{display:inline-flex}.story.active .btn.discuss svg{display:none}
.vote{width:40px;padding:0;justify-content:center}.vote img{width:16px;height:16px;opacity:.7}
.vote.up[aria-pressed=true]{background:var(--up-bg);border-color:var(--up)}.vote.down[aria-pressed=true]{background:var(--down-bg);border-color:var(--down)}
.vote[aria-pressed=true] img{opacity:1}
.spacer{flex:1}
.reasons{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}.reasons[hidden]{display:none}
.chip{min-height:34px;padding:0 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--muted);font:13px/1 inherit;font-family:inherit;cursor:pointer}
.reasons.up .chip[aria-pressed=true]{background:var(--up-bg);border-color:var(--up);color:var(--up);font-weight:600}.reasons.down .chip[aria-pressed=true]{background:var(--down-bg);border-color:var(--down);color:var(--down);font-weight:600}.chip[aria-pressed=true]::before{content:"✓ "}
.saved{font-size:12px;color:var(--muted)}
/* The voice dock. */
.dock{position:fixed;left:0;right:0;bottom:0;padding:0 10px max(10px,env(safe-area-inset-bottom));pointer-events:none}
.dock .in{pointer-events:auto;max-width:680px;margin:0 auto;display:flex;align-items:center;gap:12px;padding:10px 10px 10px 12px;background:rgba(255,255,255,.92);backdrop-filter:blur(14px);border:1px solid var(--line);border-radius:18px;box-shadow:0 8px 30px rgba(0,0,0,.12)}
.viz{position:relative;flex:none;width:48px;height:48px}
.ring{position:absolute;inset:-5px;border-radius:50%;border:2.5px solid var(--you);opacity:0}
.orb{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at var(--x,35%) var(--y,30%),#d1fae5 0,rgba(209,250,229,0) 45%),radial-gradient(circle at var(--x2,70%) var(--y2,75%),#14b8a6 0,rgba(20,184,166,0) 60%),#10b981;box-shadow:0 0 calc(4px + var(--glow,0px)) rgba(16,185,129,.45);transform:scale(var(--s,1))}
.dock[data-s=idle] .orb,.dock[data-s=ended] .orb,.dock[data-s=error] .orb{filter:saturate(.3)}
.dock[data-s=connecting] .orb{animation:breathe 1.6s ease-in-out infinite}
.dock[data-s=muted] .ring{opacity:.5!important;border-style:dashed;border-color:var(--faint);transform:none!important}
@keyframes breathe{50%{transform:scale(.86);opacity:.7}}
.txt{flex:1;min-width:0;line-height:1.3}
.k{font-size:12px;color:var(--muted)}.t{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.round{flex:none;width:48px;height:48px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.round svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.round[aria-pressed=true]{background:var(--text);border-color:var(--text);color:#fff}
.round.end{background:var(--danger);border-color:var(--danger);color:#fff}
.start{flex:none;min-height:44px;padding:0 18px;border-radius:999px;border:0;background:var(--g-strong);color:#fff;font:600 15px/1 inherit;font-family:inherit;cursor:pointer}
[hidden]{display:none!important}
.toast{position:fixed;left:50%;bottom:calc(92px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--text);color:#fff;font-size:14px;padding:8px 14px;border-radius:999px;opacity:0;transition:opacity .25s;pointer-events:none}
.toast.on{opacity:1}
@media (prefers-reduced-motion:reduce){.orb,.eq i,.dock[data-s=connecting] .orb{animation:none!important}}
</style></head><body>
<div class="wrap"><article id="issue">${content}</article></div>
<div class="dock" id="dock" data-s="idle"><div class="in">
<div class="viz" aria-hidden="true"><div class="ring" id="ring"></div><div class="orb" id="orb"></div></div>
<div class="txt"><div class="k" id="dk">Talk about this issue</div><div class="t" id="dt">${esc(brief.digest)} · ${esc(brief.sent)}</div></div>
<button class="start" id="go" type="button">Start</button>
<button class="round" id="mute" type="button" aria-pressed="false" aria-label="Mute" hidden>${ICON.mic}</button>
<button class="round end" id="end" type="button" aria-label="End" hidden>${ICON.end}</button>
</div></div>
<div class="toast" id="toast" role="status"></div>
<audio id="audio" autoplay playsinline></audio>
<script type="application/json" id="talk-data">${json}</script>
<script type="module">
const D = JSON.parse(document.getElementById("talk-data").textContent);
const $ = (id) => document.getElementById(id);
const dock = $("dock"), dk = $("dk"), dt = $("dt"), orb = $("orb"), ring = $("ring"), audio = $("audio");
const go = $("go"), muteBtn = $("mute"), endBtn = $("end");
const byN = new Map(D.items.map((i) => [i.n, i]));
const vibe = (ms) => { try { navigator.vibrate?.(ms); } catch {} };
// Problems starting a conversation are reported to the function's log (no personal data: the error and the browser).
const report = (stage, e) => { try { fetch("/v1/talk/tools/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: D.token, args: { stage, error: String(e?.name ? e.name + ": " + e.message : e?.message ?? e).slice(0, 300), code: e?.code ?? null, fatal: e?.fatal ?? null, ua: navigator.userAgent } }) }); } catch {} };
let toastT; const toast = (m) => { const t = $("toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 2600); };
const api = async (name, args) => {
  const r = await fetch("/v1/talk/tools/" + name, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: D.token, args: args ?? {} }) });
  return r.ok ? r.json() : { error: "the tool failed (" + r.status + ")" };
};

// ── the issue: each "## N." section becomes a story with its own controls ──
const issue = $("issue");
for (const a of issue.querySelectorAll('a[href*="/v1/talk?t="]')) if (/Talk about this issue/.test(a.textContent)) a.closest("p")?.remove();
const sections = new Map();
for (const h of [...issue.querySelectorAll("h2")]) {
  const n = Number(h.textContent.match(/^\\s*(\\d+)\\./)?.[1]);
  const item = byN.get(n); if (!item) continue;
  const sec = document.createElement("section"); sec.className = "story"; sec.id = "story-" + n; sec.dataset.n = n;
  h.before(sec);
  let node = h;
  while (node && !(node !== h && node.nodeName === "H2")) { const next = node.nextSibling; sec.appendChild(node); node = next; }
  // The email's "Useful? 👍 👎 · 🎧 Discuss" row becomes buttons that work in place.
  for (const el of sec.querySelectorAll("div, p")) if (/Useful\\?/.test(el.textContent) && el.querySelector('a[href*="/v1/feedback"]')) el.remove();
  const acts = document.createElement("div"); acts.className = "acts";
  acts.innerHTML = '<button class="btn discuss" type="button">${ICON.headphones.replace(/"/g, '\\"')}<span class="eq"><i></i><i></i><i></i></span><span class="lbl">Discuss</span></button><span class="spacer"></span><span class="saved"></span>'
    + '<button class="btn vote up" type="button" aria-pressed="false" aria-label="More like this"><img src="/v1/assets/thumb-up.png" alt=""></button>'
    + '<button class="btn vote down" type="button" aria-pressed="false" aria-label="Less like this"><img src="/v1/assets/thumb-down.png" alt=""></button>';
  const reasons = document.createElement("div"); reasons.className = "reasons"; reasons.hidden = true;
  sec.append(acts, reasons);
  sections.set(n, { sec, item, acts, reasons });
  render(n, D.votes[n], n === D.voted ? "Saved" : "");
  acts.querySelector(".discuss").addEventListener("click", () => discuss(n));
  acts.querySelector(".up").addEventListener("click", () => vote(n, "up"));
  acts.querySelector(".down").addEventListener("click", () => vote(n, "down"));
}

// ── votes ──
// A story with a vote shows its reason chips, so earlier choices can be seen and changed.
function render(n, v, note, open = true) {
  const s = sections.get(n); if (!s) return;
  D.votes[n] = v ?? undefined;
  s.acts.querySelector(".up").setAttribute("aria-pressed", String(v?.vote === "up"));
  s.acts.querySelector(".down").setAttribute("aria-pressed", String(v?.vote === "down"));
  s.acts.querySelector(".saved").textContent = note ?? "";
  if (!v?.vote) { s.reasons.hidden = true; return; }
  const sel = (o) => (v.reasons ?? []).some((x) => x.r === o.r && (o.r !== "entity" || o.target === undefined || (x.target ?? s.item.reasons[v.vote].find((y) => y.r === "entity")?.target) === o.target));
  s.reasons.innerHTML = ""; s.reasons.className = "reasons " + v.vote;
  for (const o of s.item.reasons[v.vote]) {
    const c = document.createElement("button"); c.type = "button"; c.className = "chip"; c.textContent = o.label; c.setAttribute("aria-pressed", String(sel(o)));
    c.addEventListener("click", () => { vibe(10); c.setAttribute("aria-pressed", String(c.getAttribute("aria-pressed") !== "true")); send(n, { story: n, vote: v.vote, reason: o.r, x: o.x }, false); });
    s.reasons.appendChild(c);
  }
  s.reasons.hidden = !open;
}
// A story's votes go to the server one after another (saving one takes a moment), and only the
// answer to the latest tap updates the screen, so quick taps can't overtake each other.
const queue = new Map(), seq = new Map();
// "saved" holds the last vote the server confirmed: a failed save (an error reply or no reply) goes back to it.
const saved = new Map();
function send(n, args, rerender = true) {
  const mine = (seq.get(n) ?? 0) + 1; seq.set(n, mine);
  if (!saved.has(n)) saved.set(n, D.votes[n]);
  const failed = () => { if (seq.get(n) !== mine) return; toast("Couldn't save that"); render(n, saved.get(n)); };
  const run = (queue.get(n) ?? Promise.resolve()).then(() => api("feedback", args)).then((r) => {
    if (r?.ok) saved.set(n, r.vote ? { vote: r.vote, reasons: r.reasons ?? [] } : undefined);
    if (seq.get(n) !== mine) return;
    if (r?.ok) { if (rerender || !r.vote) render(n, saved.get(n), r.vote ? "Saved" : ""); else { D.votes[n] = saved.get(n); sections.get(n).acts.querySelector(".saved").textContent = "Saved"; } }
    else failed();
  }, failed);
  queue.set(n, run.catch(() => {}));
}
function vote(n, v) {
  vibe(10);
  const undo = D.votes[n]?.vote === v;
  send(n, { story: n, vote: v, undo });
  render(n, undo ? undefined : { vote: v, reasons: [] });
}

// ── which story is being discussed ──
let active = null, touched = 0;
addEventListener("touchstart", () => (touched = Date.now()), { passive: true });
addEventListener("wheel", () => (touched = Date.now()), { passive: true });
function highlight(n, scroll) {
  if (!sections.has(n)) return;
  for (const [k, s] of sections) s.sec.classList.toggle("active", k === n);
  active = n;
  if (live || busy) { dk.textContent = "Discussing"; dt.textContent = byN.get(n).headline; }
  // Never move the page under a finger: only when it hasn't been touched for a while.
  if (scroll && Date.now() - touched > 8000) sections.get(n).sec.scrollIntoView({ behavior: "smooth", block: "start" });
}
function discuss(n) {
  vibe(10);
  if (!live) { start(n); return; }
  highlight(n, false);
  agent.sendConversationMessage('(The listener tapped the story "' + byN.get(n).headline + '" (story ' + n + ') on the page. Switch to it now: stop what you were saying and tell them briefly what happened and why it matters.)');
}

// ── the conversation ──
const tools = {
  get_issue: () => D.brief,
  show_story: ({ story } = {}) => { highlight(Number(story), true); return { ok: true }; },
  read_article: async (a) => { highlight(Number(a?.story), true); return api("read_article", a); },
  search_web: (a) => api("search_web", a),
  record_vote: async (a) => { const r = await api("record_vote", a); if (r?.ok) { const v = r.vote ? { vote: r.vote, reasons: r.reasons ?? [] } : undefined; saved.set(Number(a.story), v); render(Number(a.story), v, "Saved by voice"); } return r; },
};
let agent, gen = 0, closing = Promise.resolve(), call, live = false, busy = false, muted = false, failTimer, wake, agentState = "listening";
const set = (s) => { dock.dataset.s = s; };
function phase(p) {
  live = p === "live";
  go.hidden = p === "live" || p === "connecting";
  muteBtn.hidden = !live;
  endBtn.hidden = !(live || p === "connecting");
  go.textContent = p === "ended" ? "Resume" : "Start";
  if (p === "ended" || p === "idle") { dk.textContent = p === "ended" ? "Conversation ended" : "Talk about this issue"; dt.textContent = D.brief.digest + " · " + D.brief.sent; }
}
let ctx, remoteLevel = () => 0, localLevel = () => 0;
function meter(stream) {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    const a = ctx.createAnalyser(); a.fftSize = 512; ctx.createMediaStreamSource(stream).connect(a);
    const buf = new Uint8Array(a.fftSize);
    return () => { a.getByteTimeDomainData(buf); let s = 0; for (const v of buf) { const x = (v - 128) / 128; s += x * x; } return Math.min(1, Math.sqrt(s / buf.length) * 4); };
  } catch { return () => 0; }
}
let r = 0, y = 0, turn = 0;
(function frame(t) {
  const speaking = live && agentState === "speaking";
  const rl = Math.max(remoteLevel(), speaking ? 0.22 + 0.12 * Math.sin(t / 140) : 0);
  const yl = live && !muted ? localLevel() : 0;
  // Fast attack, slow release, and a noise floor: levels without jitter.
  r += (rl - r) * (rl > r ? 0.35 : 0.08); y += (yl - y) * (yl > y ? 0.35 : 0.08);
  turn = (turn + (live && agentState === "thinking" ? 5 : 0.6)) % 360;
  orb.style.setProperty("--s", live ? String(1 + r * 0.28) : "1");
  orb.style.setProperty("--glow", (r * 22).toFixed(1) + "px");
  const a = (turn * Math.PI) / 180;
  orb.style.setProperty("--x", (50 + 22 * Math.cos(a)).toFixed(1) + "%"); orb.style.setProperty("--y", (50 + 22 * Math.sin(a)).toFixed(1) + "%");
  orb.style.setProperty("--x2", (50 - 20 * Math.cos(a)).toFixed(1) + "%"); orb.style.setProperty("--y2", (50 - 20 * Math.sin(a)).toFixed(1) + "%");
  ring.style.opacity = muted ? "" : y > 0.04 ? String(Math.min(1, y * 2.5)) : "0";
  ring.style.transform = "scale(" + (1 + y * 0.25).toFixed(3) + ")";
  requestAnimationFrame(frame);
})(0);
function play() { audio.play().then(() => ctx?.resume()).catch(() => { set("idle"); go.hidden = false; go.textContent = "Tap to hear"; }); }
function reason(e) {
  const m = String(e?.name ?? "") + " " + String(e?.message ?? e);
  if (/NotAllowed|Permission|denied/i.test(m)) return "Microphone access is blocked: allow it for this site and try again.";
  if (/NotFound|no audio|device/i.test(m)) return "No microphone found.";
  return "Couldn't start the conversation (" + String(e?.message ?? e).slice(0, 80) + ")";
}
function fail(message) { clearTimeout(failTimer); if (!busy && !live) return; toast(message); teardown("idle"); }
async function teardown(p = "ended") {
  clearTimeout(failTimer);
  const was = live; gen++; phase(p); set(p); busy = false;
  // No story is being discussed any more (Resume still starts on the last one).
  for (const x of sections.values()) x.sec.classList.remove("active");
  remoteLevel = localLevel = () => 0;
  // Close this conversation's own agent: a Resume tapped meanwhile waits for it, then makes a new one.
  const a = agent, w = wake; agent = undefined; call = undefined; wake = undefined;
  const done = closing.then(async () => {
    try { await w?.release(); } catch {}
    try { await a?.endConversation(); } catch {}
    try { await a?.disconnect(); } catch {}
  });
  closing = done;
  if (was) toast("Conversation ended");
  await done;
}
async function start(n) {
  if (busy || live) return;
  const g = ++gen; busy = true; setMuted(false); phase("connecting"); set("connecting");
  if (n) highlight(n, true); dk.textContent = "Connecting…";
  if (!n && active === null) dt.textContent = D.brief.digest + " · " + D.brief.sent;
  failTimer = setTimeout(() => { report("timeout", "no live call after 25 s"); fail("Couldn't connect. Try again in a moment."); }, 25000);
  try {
    await closing;
    const { TelnyxAIAgent } = await import(D.lib);
    if (g !== gen) return;
    // Each start has its own agent; events from one that has since been closed are ignored.
    const me = new TelnyxAIAgent({ agentId: D.assistantId, clientTools: tools, clientToolTimeoutMs: 45000 });
    agent = me;
    const mine = (f) => (...x) => { if (g === gen) f(...x); };
    me.on("conversation.agent.state", mine((s) => { if (!s?.state) return; agentState = s.state; if (live && !muted) set(s.state); }));
    me.on("conversation.update", mine((ev) => {
      const c = ev?.call; if (!c) return;
      call = c;
      if (c.remoteStream && audio.srcObject !== c.remoteStream) { audio.srcObject = c.remoteStream; remoteLevel = meter(c.remoteStream); play(); }
      if (c.localStream && localLevel.stream !== c.localStream) { localLevel = meter(c.localStream); localLevel.stream = c.localStream; }
      if (c.state === "active" && !live) {
        clearTimeout(failTimer); busy = false; phase("live"); set("listening");
        dk.textContent = active ? "Discussing" : "Talking about"; dt.textContent = active ? byN.get(active).headline : D.brief.digest + " · " + D.brief.sent;
        navigator.wakeLock?.request("screen").then((w) => { if (g === gen) wake = w; else w.release().catch(() => {}); }).catch(() => {});
      }
      if ((c.state === "hangup" || c.state === "destroy") && live) teardown("ended");
    }));
    // Some errors are warnings the library recovers from: report them, and give up only on fatal ones (or after the timeout).
    me.on("agent.error", mine((e) => { console.warn("agent error", e); report(live ? "live" : "starting", e); if (!live && (e?.fatal || /login|auth|permission|NotAllowed|not supported/i.test(String(e?.message ?? e)))) fail(reason(e)); }));
    // Start only when both the login reply and the client's ready event have arrived: an invite sent in
    // between is dropped when the SDK re-attaches its session (SESSION_NOT_REATTACHED).
    const once = (ev) => new Promise((resolve) => me.once(ev, resolve));
    const ready = Promise.all([once("agent.login.success"), once("agent.connected")]);
    await me.connect();
    await ready;
    if (g !== gen) return;
    const greeting = n ? byN.get(n).greeting : D.greeting;
    await me.startConversation({ customHeaders: [{ name: "X-Greeting", value: greeting }, { name: "X-Digest", value: D.digest }], audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    if (g !== gen) return;
    console.error(e); report("start", e); fail(reason(e));
  }
}
function setMuted(on) {
  muted = on; muteBtn.setAttribute("aria-pressed", String(on)); muteBtn.setAttribute("aria-label", on ? "Unmute" : "Mute");
  muteBtn.innerHTML = on ? D.icons.micOff : D.icons.mic;
}
muteBtn.addEventListener("click", () => { if (!call) return; vibe(10); setMuted(!muted); try { muted ? call.muteAudio() : call.unmuteAudio(); } catch {} set(muted ? "muted" : agentState); });
endBtn.addEventListener("click", () => { vibe([10, 60, 10]); teardown(live ? "ended" : "idle"); });
go.addEventListener("click", () => { if (go.textContent === "Tap to hear") { ctx?.resume(); audio.play().catch(() => {}); go.hidden = true; set(agentState); return; } start(active ?? undefined); });
// From a talk link: go to the story and start talking. From a thumbs click or the view link: show the story, don't start.
if (D.autostart) { if (D.start && sections.has(D.start)) { touched = 0; start(D.start); } else start(); }
else if (D.start && sections.has(D.start)) { sections.get(D.start).sec.scrollIntoView({ block: "start" }); if (D.voted) toast("Thanks, your vote is saved"); }
</script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" } });
}

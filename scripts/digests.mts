// ai-digest <command>
//
//   list                         digests stored on the agent, and the built-in General one
//   push [id…]                   upload digests/<id>.md (all when no ids), validated first
//   pull [id…]                   download definitions into digests/
//   show <id>                    print a stored definition
//   delete <id>                  delete a stored definition (sent issues, votes and memory stay)
//   run <id> [focus…] [--run N] [--from-pool]
//                                start a digest now; [focus] adds one-off guidance for this issue.
//                                A watching digest runs a check, then writes from its pool (--from-pool: from the pool now)
//   watch <id> [--since T] [--until T] [--no-send]
//                                a watching digest's check now; --since/--until replay a past window; --no-send only fills the pool
//   pool <id>                    a watching digest's pool: timing, counts, the last decision, the candidates
//   ask <topic…> [--window 14d] [--items 5-8] [--run N]
//                                a one-off General digest on any topic, emailed to DIGEST_EMAIL_TO
//   status <conversation>        a run's recent steps
//
// Talks to the agent's v1 API with the operator token (AGENT_AUTH_KEY in .env).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProfileError, parseProfile } from "../src/profile.ts";
import { agentApi, loadEnv, root } from "./lib.mjs";

const env = loadEnv();
const dir = join(root, "digests");
const [cmd, ...rest] = process.argv.slice(2);
const has = (name: string) => {
  const i = rest.indexOf(name);
  if (i !== -1) rest.splice(i, 1);
  return i !== -1;
};
const flag = (name: string) => {
  const i = rest.indexOf(name);
  if (i === -1) return undefined;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
};
const localIds = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")) : []);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

async function main() {
  switch (cmd) {
    case "list": {
      const list = await agentApi(env, "GET", "/v1/digests");
      if (!list.length) return console.log("No digests stored yet. Add one to digests/ and run: ai-digest push");
      for (const d of list) {
        if (d.builtIn) {
          console.log(`${d.id.padEnd(22)} ${"General: any topic, on demand (ask)".padEnd(48)} ${String(d.windowDays).padStart(2)}d  ${`${d.items.min}-${d.items.max} items`.padEnd(11)} built in`);
          continue;
        }
        const items = d.items ? `${d.items.min}-${d.items.max} items` : "";
        console.log(`${d.id.padEnd(22)} ${(d.title ?? "(invalid)").padEnd(48)} ${String(d.windowDays ?? "?").padStart(2)}d  ${items.padEnd(11)} ${d.watch ? `checks every ${d.watch.watchHours}h` : ""}`);
      }
      return;
    }
    case "push": {
      const ids = rest.length ? rest : localIds();
      if (!ids.length) fail("Nothing to push: add digests/<id>.md (start from examples/digests/).");
      for (const id of ids) {
        const file = join(dir, `${id}.md`);
        if (!existsSync(file)) fail(`No such file: digests/${id}.md`);
        const md = readFileSync(file, "utf8");
        try {
          parseProfile(id, md);
        } catch (e) {
          fail(e instanceof ProfileError ? `✗ ${e.message}` : String(e));
        }
        const r = await agentApi(env, "PUT", `/v1/digests/${id}`, md, { raw: true });
        console.log(`✓ ${id}${r.changed ? "" : " (unchanged)"}`);
      }
      return;
    }
    case "pull": {
      const ids = rest.length ? rest : (await agentApi(env, "GET", "/v1/digests")).map((d: { id: string }) => d.id);
      mkdirSync(dir, { recursive: true });
      for (const id of ids) {
        const d = await agentApi(env, "GET", `/v1/digests/${id}`);
        writeFileSync(join(dir, `${id}.md`), d.markdown);
        console.log(`✓ digests/${id}.md`);
      }
      return;
    }
    case "show": {
      if (!rest[0]) fail("Usage: ai-digest show <id>");
      process.stdout.write((await agentApi(env, "GET", `/v1/digests/${rest[0]}`)).markdown);
      return;
    }
    case "delete": {
      if (!rest[0]) fail("Usage: ai-digest delete <id>");
      console.log(JSON.stringify(await agentApi(env, "DELETE", `/v1/digests/${rest[0]}`)));
      return;
    }
    case "run": {
      const runName = flag("--run");
      const fromPool = has("--from-pool");
      const [id, ...focus] = rest;
      if (!id) fail("Usage: ai-digest run <id> [focus for this issue] [--run <name>] [--from-pool]");
      const r = await agentApi(env, "POST", `/v1/digests/${id}/runs`, { ...(runName ? { run: runName } : {}), ...(focus.length ? { message: focus.join(" ") } : {}), ...(fromPool ? { check: false } : {}) });
      if (r.ok === false) fail(r.error);
      if (r.mode === "check-then-write") console.log(`Started a check for ${r.digest} (${r.conversation}); an issue is written from the pool when it's done.`);
      else if (r.mode === "from-pool") console.log(`Writing ${r.digest} from its pool now; follow it with: ai-digest pool ${r.digest}`);
      else console.log(`Started ${r.digest} in conversation ${r.conversation}. It takes 3–5 minutes; the email is sent when it's done.`);
      if (r.conversation) console.log(`Follow it: ai-digest status ${r.conversation}`);
      return;
    }
    case "ask": {
      const runName = flag("--run");
      const window = flag("--window");
      const items = flag("--items");
      const topic = rest.join(" ").trim();
      if (!topic) fail('Usage: ai-digest ask "<topic>" [--window 14d] [--items 5-8] [--run <name>]');
      const r = await agentApi(env, "POST", "/v1/runs", { topic, ...(window ? { window } : {}), ...(items ? { items } : {}), ...(runName ? { run: runName } : {}) });
      console.log(`Started a General digest on "${r.topic}" in conversation ${r.conversation}. It takes 3–5 minutes; the email is sent when it's done.`);
      console.log(`Follow it: ai-digest status ${r.conversation}`);
      return;
    }
    case "watch": {
      const since = flag("--since");
      const until = flag("--until");
      const noSend = has("--no-send");
      const id = rest[0];
      if (!id) fail("Usage: ai-digest watch <id> [--since 2026-11-02] [--until 2026-11-04] [--no-send]");
      const r = await agentApi(env, "POST", `/v1/digests/${id}/check`, { ...(since ? { since } : {}), ...(until ? { until } : {}), ...(noSend ? { decide: false } : {}) }).catch((e: Error) => fail(e.message));
      if (r.ok === false) fail(`${r.error}${r.conversation ? ` (${r.conversation})` : ""}`);
      console.log(`Check started in ${r.conversation}, ${r.since.slice(0, 16)} → ${r.until.slice(0, 16)} UTC.${noSend ? " It only fills the pool." : ""}`);
      console.log(`Then: ai-digest pool ${id}`);
      return;
    }
    case "pool": {
      const id = rest[0];
      if (!id) fail("Usage: ai-digest pool <id>");
      const v = await agentApi(env, "GET", `/v1/digests/${id}/pool`);
      const t = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "—");
      if (!v.watch) console.log(`${id} doesn't watch (no "watch:" in its definition).`);
      console.log(`checks ${v.checks} · last ${t(v.lastCheckAt)}${v.checkRunning ? " (one running)" : ""} · next ${t(v.nextCheckAt)} · last issue ${t(v.lastIssueAt)}${v.issueRunning ? " (one being written)" : ""}`);
      console.log(`pool: ${v.counts.strong} strong · ${v.counts.candidates} candidates · ${v.counts.reserved} reserved · ${v.counts.sent} sent · ${v.counts.expired} expired`);
      if (v.lastDecision) console.log(`decision: ${v.lastDecision.action} — ${v.lastDecision.reason}${v.lastDecision.dueBy ? ` (an issue by ${t(v.lastDecision.dueBy)} at the latest)` : ""}`);
      for (const e of v.entries) {
        const mark = { candidate: " ", reserved: "R", sent: "S", expired: "x" }[e.state as string] ?? "?";
        console.log(`${mark} ${e.score.toFixed(1).padStart(4)}  imp ${String(e.importance).padStart(2)}  ${String(e.sources.length).padStart(2)} src  ${String(e.sightings).padStart(2)}×  ${e.headline.slice(0, 90)}${e.dropped ? `  [${e.dropped}]` : ""}`);
      }
      return;
    }
    case "status": {
      if (!rest[0]) fail("Usage: ai-digest status <conversation>");
      const s = await agentApi(env, "GET", `/v1/runs/${rest[0]}`);
      if (!s.runs?.length) return console.log("No runs yet in that conversation.");
      for (const r of s.runs) {
        const took = r.durationMs ? `${Math.floor(r.durationMs / 60000)} m ${Math.round((r.durationMs % 60000) / 1000)} s` : "running";
        const started = r.startedAt ? new Date(r.startedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
        console.log(`${r.status ?? "?"}  ${took}  ${r.toolCalls ?? 0} tool calls  ${r.tokens?.total?.toLocaleString("en") ?? "?"} tokens  started ${started}`);
      }
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));

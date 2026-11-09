// npm run digests -- <command>
//
//   list                         digests stored on the agent, and the built-in General one
//   push [id…]                   upload digests/<id>.md (all when no ids), validated first
//   pull [id…]                   download definitions into digests/
//   show <id>                    print a stored definition
//   delete <id>                  delete a stored definition (sent issues, votes and memory stay)
//   run <id> [focus…] [--run N]  start a digest now; [focus] adds one-off guidance for this issue
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
      if (!list.length) return console.log("No digests stored yet. Add one to digests/ and run: npm run digests -- push");
      for (const d of list) {
        if (d.builtIn) {
          console.log(`${d.id.padEnd(22)} ${"General: any topic, on demand (ask)".padEnd(48)} ${String(d.windowDays).padStart(2)}d  ${`${d.items.min}-${d.items.max} items`.padEnd(11)} built in`);
          continue;
        }
        const items = d.items ? `${d.items.min}-${d.items.max} items` : "";
        console.log(`${d.id.padEnd(22)} ${(d.title ?? "(invalid)").padEnd(48)} ${String(d.windowDays ?? "?").padStart(2)}d  ${items.padEnd(11)} ${d.schedule ?? ""}`);
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
      if (!rest[0]) fail("Usage: npm run digests -- show <id>");
      process.stdout.write((await agentApi(env, "GET", `/v1/digests/${rest[0]}`)).markdown);
      return;
    }
    case "delete": {
      if (!rest[0]) fail("Usage: npm run digests -- delete <id>");
      console.log(JSON.stringify(await agentApi(env, "DELETE", `/v1/digests/${rest[0]}`)));
      return;
    }
    case "run": {
      const runName = flag("--run");
      const [id, ...focus] = rest;
      if (!id) fail("Usage: npm run digests -- run <id> [focus for this issue] [--run <name>]");
      const r = await agentApi(env, "POST", `/v1/digests/${id}/runs`, { ...(runName ? { run: runName } : {}), ...(focus.length ? { message: focus.join(" ") } : {}) });
      console.log(`Started ${r.digest} in conversation ${r.conversation}. It takes 3–5 minutes; the email is sent when it's done.`);
      console.log(`Follow it: npm run digests -- status ${r.conversation}`);
      return;
    }
    case "ask": {
      const runName = flag("--run");
      const window = flag("--window");
      const items = flag("--items");
      const topic = rest.join(" ").trim();
      if (!topic) fail('Usage: npm run digests -- ask "<topic>" [--window 14d] [--items 5-8] [--run <name>]');
      const r = await agentApi(env, "POST", "/v1/runs", { topic, ...(window ? { window } : {}), ...(items ? { items } : {}), ...(runName ? { run: runName } : {}) });
      console.log(`Started a General digest on "${r.topic}" in conversation ${r.conversation}. It takes 3–5 minutes; the email is sent when it's done.`);
      console.log(`Follow it: npm run digests -- status ${r.conversation}`);
      return;
    }
    case "status": {
      if (!rest[0]) fail("Usage: npm run digests -- status <conversation>");
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

#!/usr/bin/env node
// npm run deploy [-- --skip-tests] [-- --dry-run]
//
// 1. checks .env, 2. runs the tests, 3. pushes settings from .env to Telnyx
// secrets (values go over stdin, never on a command line or into a file),
// 4. deploys, 5. on the first deploy, sets PUBLIC_URL from the address the
// deploy printed and deploys again, 6. applies the Agent Memory summary
// instructions (docs/memory-summary-instructions.md).

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnv, readJson, root, run, say } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run");
const env = loadEnv();
const spec = () => readJson("agent.json");
const cliEnv = env.TELNYX_API_KEY ? { TELNYX_API_KEY: env.TELNYX_API_KEY } : {};

// 1. settings
const required = ["DIGEST_EMAIL_FROM", "DIGEST_EMAIL_TO"];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}. Copy .env.example to .env and fill it in (docs/SETUP.md).`);
  process.exit(1);
}

// 2. tests
if (!args.has("--skip-tests")) {
  say("Running tests");
  run("npm", ["test", "--silent"]);
}

// 3. secrets
function setSecret(name, value) {
  if (dry) return console.log(`  (dry run) would set secret ${name}`);
  run("npx", ["--no-install", "telnyx-acp", "add", "secret", name], { input: value, env: cliEnv, quiet: true });
  console.log(`  ✓ ${name}`);
}
say("Syncing secrets from .env");
setSecret("DIGEST_EMAIL_FROM", env.DIGEST_EMAIL_FROM);
setSecret("DIGEST_EMAIL_TO", env.DIGEST_EMAIL_TO);
if (env.DIGEST_MEMORY_PROFILE) setSecret("DIGEST_MEMORY_PROFILE", env.DIGEST_MEMORY_PROFILE);
// The link-signing key: from .env if you keep one there; otherwise generated once and stored only on Telnyx.
// It's never rotated here: a new key would break the thumbs links in emails already sent.
if (env.FEEDBACK_KEY) setSecret("FEEDBACK_KEY", env.FEEDBACK_KEY);
else if (!spec().secrets?.includes("FEEDBACK_KEY")) setSecret("FEEDBACK_KEY", randomBytes(32).toString("hex"));
const publicUrl = env.PUBLIC_URL || spec().deployed?.mountUrl;
if (publicUrl) setSecret("PUBLIC_URL", publicUrl);

// The operator auth key: RPC and state reads on the public URL need the token derived from it (src/auth.ts).
// The CLI finds it in ~/.telnyx-acp/auth-keys.json by the agent's origin (or TELNYX_ACP_AUTH_KEY) and sends the token.
const keysFile = join(process.env.TELNYX_ACP_HOME ?? join(homedir(), ".telnyx-acp"), "auth-keys.json");
const readKeys = () => { try { return JSON.parse(readFileSync(keysFile, "utf8")); } catch { return {}; } };
const origin = (url) => new URL(url).origin;
function saveLocalKey(url, key) {
  if (dry) return;
  mkdirSync(join(keysFile, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(keysFile, JSON.stringify({ ...readKeys(), [origin(url)]: key }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(keysFile, 0o600);
  console.log(`  ✓ auth key saved for ${origin(url)} in ${keysFile}`);
}
const authKey = env.AGENT_AUTH_KEY || (publicUrl && readKeys()[origin(publicUrl)]) || randomBytes(32).toString("hex");
setSecret("AGENT_AUTH_KEY", authKey);
if (publicUrl) saveLocalKey(publicUrl, authKey);

// 4. deploy
function deploy() {
  if (dry) return console.log("  (dry run) would run telnyx-acp deploy");
  run("npx", ["--no-install", "telnyx-acp", "validate"], { env: cliEnv });
  run("npx", ["--no-install", "telnyx-acp", "deploy", "--yes"], { env: cliEnv });
}
say("Deploying");
deploy();

// 5. first deploy: now the address is known
if (!publicUrl && !dry) {
  const url = spec().deployed?.mountUrl;
  if (!url) throw new Error("deploy finished but agent.json has no deployed.mountUrl");
  say(`First deploy: setting PUBLIC_URL to ${url} and deploying again`);
  setSecret("PUBLIC_URL", url);
  saveLocalKey(url, authKey);
  deploy();
}

// 6. memory summary instructions
say("Agent Memory summary instructions");
if (!env.TELNYX_API_KEY) {
  console.log("  skipped: set TELNYX_API_KEY in .env to apply docs/memory-summary-instructions.md");
} else if (dry) {
  console.log("  (dry run) would apply docs/memory-summary-instructions.md");
} else {
  const api = "https://api.telnyx.com/v2/ai/memory/namespaces";
  const headers = { Authorization: `Bearer ${env.TELNYX_API_KEY}`, "Content-Type": "application/json" };
  const ns = await fetch(`${api}/ai-digest`, { headers });
  if (ns.status === 404) {
    const created = await fetch(api, { method: "POST", headers, body: JSON.stringify({ name: "ai-digest" }) });
    if (!created.ok) throw new Error(`creating the ai-digest memory namespace failed: ${created.status} ${await created.text()}`);
    console.log("  ✓ created memory namespace ai-digest");
  }
  const instructions = readFileSync(`${root}docs/memory-summary-instructions.md`, "utf8").replace(/^<!--[\s\S]*?-->\s*/, "").trim();
  const r = await fetch(`${api}/ai-digest/settings`, { method: "PATCH", headers, body: JSON.stringify({ summary: { instructions } }) });
  if (!r.ok) throw new Error(`setting summary instructions failed: ${r.status} ${await r.text()}`);
  console.log("  ✓ summary instructions applied");
}

say(`Done. Try it:\n  npx telnyx-acp invoke ai-digest --conversation first-digest "Weekly digest: the most important AI and software engineering news from the past 7 days."`);

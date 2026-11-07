// Helpers shared by the scripts. No dependencies beyond Node.

import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const root = new URL("..", import.meta.url).pathname;
export const edgeDir = join(root, ".edge");
const stateFile = join(edgeDir, "function.json");
export const API = "https://api.telnyx.com/v2";

/** KEY=value lines from .env (comments and blanks ignored; quotes stripped). Real environment variables win. */
export function loadEnv(file = join(root, ".env")) {
  const out = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  for (const k of Object.keys(out)) if (process.env[k]) out[k] = process.env[k];
  for (const k of ["TELNYX_API_KEY", "AGENT_AUTH_KEY", "PUBLIC_URL"]) if (process.env[k]) out[k] = process.env[k];
  return out;
}

/** Set (or add) KEY=value in .env, keeping everything else as it is. */
export function setEnvValue(key, value, file = join(root, ".env")) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `${key}=${value}`;
  const next = new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
  writeFileSync(file, next, { mode: 0o600 });
}

/** The Telnyx API key: TELNYX_API_KEY in .env, else the one `telnyx-edge auth` stored. */
export function apiKey(env) {
  if (env.TELNYX_API_KEY) return env.TELNYX_API_KEY;
  const cfg = join(homedir(), ".telnyx-edge", "config.toml");
  const m = existsSync(cfg) ? readFileSync(cfg, "utf8").match(/^api_key\s*=\s*"([^"]+)"/m) : null;
  if (m) return m[1];
  throw new Error("No Telnyx API key: set TELNYX_API_KEY in .env (or run `telnyx-edge auth api-key set`).");
}

/** A Telnyx API call; throws with the API's message on failure. */
export async function telnyx(env, method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${apiKey(env)}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** The deployed function: { functionId, functionName, publicUrl }, kept in .edge/function.json (git-ignored). */
export function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}
export function writeState(state) {
  mkdirSync(edgeDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}

/** The operator's bearer token for the v1 API: HMAC-SHA256(key, "telnyx-acp operator"), hex (src/auth.ts). */
export function operatorToken(key) {
  return createHmac("sha256", key).update("telnyx-acp operator").digest("hex");
}

/** The function's public URL: PUBLIC_URL in .env, else what the last deploy recorded. */
export function publicUrl(env) {
  const url = env.PUBLIC_URL || readState().publicUrl;
  if (!url) throw new Error("The agent's URL isn't known yet: run `npm run deploy` first.");
  return url.replace(/\/+$/, "");
}

/** A call to the agent's v1 API with the operator token. */
export async function agentApi(env, method, path, body, { raw = false } = {}) {
  if (!env.AGENT_AUTH_KEY) throw new Error("No AGENT_AUTH_KEY in .env: run `npm run deploy` (it creates one).");
  const r = await fetch(publicUrl(env) + path, {
    method,
    headers: { Authorization: `Bearer ${operatorToken(env.AGENT_AUTH_KEY)}`, ...(raw ? { "Content-Type": "text/markdown" } : body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${data?.message ?? text.slice(0, 200)}`);
  return data;
}

/** Run a command in the project, streaming its output; throws on failure. */
export function run(cmd, args, { cwd = root, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: ["inherit", quiet ? "pipe" : "inherit", "inherit"], encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
  return r.stdout ?? "";
}

export function readJson(file) {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}

export const say = (msg) => console.log(`\n▸ ${msg}`);

// Small helpers shared by the deploy and release scripts. No dependencies.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const root = new URL("..", import.meta.url).pathname;

/** KEY=value lines from .env (comments and blanks ignored; quotes stripped). Real environment variables win. */
export function loadEnv(file = `${root}.env`) {
  const out = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  for (const k of Object.keys(out)) if (process.env[k]) out[k] = process.env[k];
  return out;
}

/** Run a command in the project, streaming its output; throws on failure. `input` goes to stdin (never on the command line). */
export function run(cmd, args, { input, env, quiet } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    input,
    env: { ...process.env, ...env },
    stdio: [input === undefined ? "inherit" : "pipe", quiet ? "pipe" : "inherit", "inherit"],
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
  return r.stdout ?? "";
}

export function readJson(file) {
  return JSON.parse(readFileSync(`${root}${file}`, "utf8"));
}

export const say = (msg) => console.log(`\n▸ ${msg}`);

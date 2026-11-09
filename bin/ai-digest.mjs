#!/usr/bin/env node
// ai-digest <command> — one command for the scripts in scripts/, from any folder.
// Install once with `npm link` in the repo (or run ./bin/ai-digest.mjs directly).
//
//   ai-digest list | push | pull | show | delete | run | watch | pool | ask | status …
//                                  the digests (scripts/digests.mts; same arguments)
//   ai-digest deploy [--skip-tests]  build and ship the function (scripts/deploy.mjs)
//   ai-digest release patch|minor|major [--deploy]
//   ai-digest screenshots          regenerate docs/images (scripts/screenshots.mts)
//   ai-digest test                 the regression tests
//   ai-digest help

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";

// The repo this file lives in, also when it's run through an `npm link` symlink.
const root = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..");
const ts = ["--experimental-strip-types", "--no-warnings"];

/** Each command: the node arguments that run it. Digest commands go to scripts/digests.mts as they are. */
const DIGESTS = ["list", "push", "pull", "show", "delete", "run", "watch", "pool", "ask", "status"];
const SCRIPTS = {
  deploy: ["scripts/deploy.mjs"],
  release: ["scripts/release.mjs"],
  screenshots: [...ts, "scripts/screenshots.mts"],
  test: ["--test", "test/"],
};

const HELP = `ai-digest <command> [arguments]

Digests (stored on your function):
  list                              digests stored on the agent, and the built-in General one
  push [id…]                        upload digests/<id>.md (all when no ids), validated first
  pull [id…]                        download definitions into digests/
  show <id>                         print a stored definition
  delete <id>                       delete a stored definition
  run <id> [focus…] [--from-pool]   an issue now (a watching digest: a check, then an issue from its pool)
  watch <id> [--since T] [--until T] [--no-send]
                                    a watching digest's check now; --since/--until replay a past window
  pool <id>                         a watching digest's pool: candidates, next check, why no issue yet
  ask "<topic>" [--window 14d] [--items 5-8]
                                    a one-off digest on any topic
  status <conversation>             a run's recent steps

Project:
  deploy [--skip-tests]             build and ship the function
  release patch|minor|major [--deploy]
  screenshots                       regenerate the images in docs/
  test                              the regression tests
`;

const [command, ...args] = process.argv.slice(2);
if (!command || command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(HELP);
  process.exit(command ? 0 : 1);
}

const nodeArgs = DIGESTS.includes(command) ? [...ts, "scripts/digests.mts", command, ...args] : SCRIPTS[command] ? [...SCRIPTS[command], ...args] : undefined;
if (!nodeArgs) {
  process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
  process.exit(1);
}
const r = spawnSync(process.execPath, nodeArgs, { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);

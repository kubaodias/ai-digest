#!/usr/bin/env node
// npm run release -- patch|minor|major [--deploy]
//
// Cuts a semver release: requires a clean git tree, passing tests and entries
// under "## [Unreleased]" in CHANGELOG.md; bumps package.json, moves the
// Unreleased entries under the new version with today's date, commits
// "Release vX.Y.Z" and tags vX.Y.Z. It doesn't push. With --deploy it then
// runs npm run deploy.

import { readFileSync, writeFileSync } from "node:fs";
import { root, run, say } from "./lib.mjs";

const argv = process.argv.slice(2);
const level = argv.find((a) => ["patch", "minor", "major"].includes(a)) ?? "patch";

if (run("git", ["status", "--porcelain"], { quiet: true }).trim()) {
  console.error("The working tree has uncommitted changes. Commit or stash them first.");
  process.exit(1);
}

say("Running tests");
run("npm", ["test", "--silent"]);

const pkgPath = `${root}package.json`;
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const [maj, min, pat] = pkg.version.split(/[.-]/).map(Number);
const next = level === "major" ? `${maj + 1}.0.0` : level === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;

const clPath = `${root}CHANGELOG.md`;
const cl = readFileSync(clPath, "utf8");
const m = cl.match(/## \[Unreleased\]\s*\n([\s\S]*?)(?=\n## \[|$)/);
if (!m || !m[1].trim()) {
  console.error("CHANGELOG.md has nothing under ## [Unreleased]. Describe the changes there first.");
  process.exit(1);
}
const today = new Date().toISOString().slice(0, 10);
writeFileSync(clPath, cl.replace(m[0], `## [Unreleased]\n\n## [${next}] - ${today}\n\n${m[1].trim()}\n`));
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
// The version the API reports at /v1/health.
const routerPath = `${root}src/router.ts`;
writeFileSync(routerPath, readFileSync(routerPath, "utf8").replace(/export const VERSION = "[^"]*";/, `export const VERSION = "${next}";`));
run("npm", ["install", "--package-lock-only", "--silent"]);

say(`Committing and tagging v${next}`);
run("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md", "src/router.ts"]);
run("git", ["commit", "-m", `Release v${next}`]);
run("git", ["tag", "-a", `v${next}`, "-m", `v${next}`]);

if (argv.includes("--deploy")) {
  say("Deploying");
  run("npm", ["run", "deploy", "--", "--skip-tests"]);
}
say(`Released v${next}. Push with: git push --follow-tags`);

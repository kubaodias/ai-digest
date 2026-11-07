#!/usr/bin/env node
// Git clean filter for agent.json: drops the "deployed" block that
// `telnyx-acp deploy` writes (function id, public URL, revision history), so a
// deployment's addresses never reach the repository. Your working copy keeps
// them, so deploys still update the same function.
//
// Enabled per clone (see README → Development):
//   git config filter.strip-deployed.clean "node scripts/strip-deployed.mjs"
//   git config filter.strip-deployed.smudge cat

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const text = Buffer.concat(chunks).toString("utf8");
try {
  const spec = JSON.parse(text);
  delete spec.deployed;
  process.stdout.write(JSON.stringify(spec, null, 2) + "\n");
} catch {
  process.stdout.write(text); // not JSON (mid-edit): leave it alone
}

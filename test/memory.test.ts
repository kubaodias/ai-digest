import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_PROFILES, memoryCounts, memorySummaryNow } from "../src/memory.ts";

/** Agent Memory with one profile whose summary is `summary`; records the reads. */
function memory(summary: { text?: string; is_stale?: boolean }) {
  const gets: { path: string; query?: Record<string, string> }[] = [];
  const telnyx = {
    get: async (path: string, opts?: { query?: Record<string, string> }) => {
      gets.push({ path, ...(opts?.query ? { query: opts.query } : {}) });
      return path === MEMORY_PROFILES ? { data: [{ profile_id: "weekly", memory_count: 4 }] } : { data: summary };
    },
  };
  return { telnyx, gets };
}

test("memory: counts per profile; a page's summary read asks for a rebuild only when it's missing or stale", async () => {
  const fresh = memory({ text: "likes Mem0" });
  assert.deepEqual(await memoryCounts(fresh.telnyx), { weekly: 4 });
  assert.equal(await memorySummaryNow(fresh.telnyx, "weekly"), "likes Mem0");
  assert.deepEqual(fresh.gets.slice(1), [{ path: `${MEMORY_PROFILES}/weekly/summary` }]);

  const stale = memory({ text: "old", is_stale: true });
  assert.equal(await memorySummaryNow(stale.telnyx, "weekly"), "old");
  assert.deepEqual(stale.gets, [{ path: `${MEMORY_PROFILES}/weekly/summary` }, { path: `${MEMORY_PROFILES}/weekly/summary`, query: { refresh: "true" } }]);
});

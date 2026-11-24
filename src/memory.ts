// Agent Memory: one sentence per vote in each digest's profile (namespace
// ai-digest, profile = the digest's id, session fb-<issue>-<item>), and the
// profile summaries the research model and the digests app read.

import { memorySentence } from "./preferences.ts";
import type { StoredVote } from "./feedback.ts";
import type { TelnyxClient, TelnyxReader } from "./telnyx.ts";

export const MEMORY_NAMESPACE = "ai-digest";
/** Every profile in the namespace. */
export const MEMORY_PROFILES = `/ai/memory/namespaces/${MEMORY_NAMESPACE}/profiles`;
const memoryBase = (profile: string) => `${MEMORY_PROFILES}/${encodeURIComponent(profile)}`;

/** Write (or rewrite in place) the memory for one vote; returns the memory source id. */
export async function rememberVote(telnyx: TelnyxClient, profile: string, v: StoredVote): Promise<string | undefined> {
  const res = await telnyx.post(`${memoryBase(profile)}/ingest`, {
    query: { session_id: `fb-${v.digest}-${v.item}` },
    body: { messages: [{ role: "user", content: memorySentence(v) }] },
  });
  return res?.data?.source_id ?? res?.source_id;
}

export async function forgetVote(telnyx: TelnyxClient, profile: string, memorySource: string | undefined): Promise<void> {
  if (memorySource) await telnyx.delete(`${memoryBase(profile)}/sources/${encodeURIComponent(memorySource)}`);
}

/** How many memories each profile has. */
export async function memoryCounts(telnyx: TelnyxReader): Promise<Record<string, number>> {
  const r = await telnyx.get(MEMORY_PROFILES);
  return Object.fromEntries((r?.data ?? []).map((p: { profile_id: string; memory_count: number }) => [p.profile_id, p.memory_count]));
}

/**
 * A profile's summary as it is now, for a page: Agent Memory builds a summary only when asked, so a
 * missing or stale one is asked for, for next time, without waiting for it.
 */
export async function memorySummaryNow(telnyx: TelnyxReader, profile: string): Promise<string | null> {
  const url = `${memoryBase(profile)}/summary`;
  const r = await telnyx.get(url);
  if (!r?.data?.text || r?.data?.is_stale) await telnyx.get(url, { query: { refresh: "true" } }).catch(() => undefined);
  return r?.data?.text ?? null;
}

/**
 * A profile's summary, current, for a run: asks for it to be built (`refresh=true`; a plain read of a
 * stale summary returns null and builds nothing) and waits, since building takes up to ~40 s.
 */
export async function memorySummaryWait(telnyx: TelnyxReader, profile: string, waitMs = 60_000): Promise<string | null> {
  const url = `${memoryBase(profile)}/summary`;
  const first = await telnyx.get(url, { query: { refresh: "true" } });
  if (first?.data?.text && !first.data.is_stale) return first.data.text;
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 5_000));
    const r = await telnyx.get(url);
    if (r?.data?.text && !r.data.is_stale) return r.data.text;
  }
  return first?.data?.text ?? null; // a stale summary beats none
}

// What AiDigest keeps in its durable state, beside ManagedAgent's own keys.
// Every conversation is an instance of the one class, and each role uses its
// own keys: a run, a watching digest's pool, the `feedback` actor and the
// `digests` actor. setState merges a patch into the state key by key, and a
// null deletes a key, so records keyed by id are written one entry at a time.
// Renaming a key here loses what deployed actors stored under it.

import type { DigestRecord, StoredVote } from "./feedback.ts";
import type { Decision, PoolEntry, RunLease } from "./pool.ts";
import type { TalkUsage } from "./talk.ts";

/**
 * A setState patch: plain objects merge key by key (records keyed by id too), anything else is replaced,
 * and null deletes the key. (@telnyx/edge-runtime's MergePatch, which its public types don't export.)
 */
export type Patch<T> = {
  [K in keyof T]?: (NonNullable<T[K]> extends readonly unknown[] ? T[K] : NonNullable<T[K]> extends object ? Patch<NonNullable<T[K]>> : T[K]) | null;
};

/** A check's window, kept in the check's own conversation (prepareCheckRun). */
export interface CheckRun {
  digest: string;
  slot: string;
  since: string;
  until: string;
}

/** A check the pool started and is waiting on. runCheck's lease wait refreshes only startedAt. */
export interface RunningCheck {
  slot?: string;
  startedAt: string;
  since?: string;
  until?: string;
  decide?: boolean;
  force?: { focus?: string } | null;
}

/** A pool's bookkeeping: timing, the running check or issue, the last results. */
export interface PoolMeta {
  enabledAt?: string;
  watchHours?: number;
  lastCheckAt?: string;
  lastCheckSlot?: string;
  checkRunning?: RunningCheck;
  lastCheck?: { slot: string; at: string; since?: string; until?: string; added: number; merged: number; resighted: number; dropped: number };
  checks?: number;
  lastDecision?: Decision & { at: string };
  lastIssueAt?: string;
  lastIssue?: { slot: string; at: string; stories: number; quiet?: boolean };
  issueRunning?: { slot: string; startedAt: string; stories: number };
}

/** A digest's definition as stored, with its earlier versions (newest first). */
export interface StoredDefinition {
  id: string;
  markdown: string;
  updatedAt: string;
  history?: { markdown: string; updatedAt: string }[];
}

export interface AiDigestState {
  // ── a run ("<digest>--<run>", "<digest>--check-<slot>", "<digest>--issue-<slot>") ──
  /** A General run's topic and shape (prepareGeneralRun). */
  general?: { topic: string; window: string; items: string };
  checkRun?: CheckRun;
  /** An issue run's slot and the pool stories it was given (prepareIssueRun). */
  issueRun?: { slot: string; ids: string[] };
  /** When this conversation last emailed a digest (ms): a second post-run hook for the same run sends nothing. */
  emailedAt?: number;

  // ── a pool ("<digest>--pool") ──
  poolEntries?: Record<string, PoolEntry>;
  poolMeta?: PoolMeta;

  // ── the `feedback` actor ──
  /** Votes by "<issue>:<item>". */
  votes?: Record<string, StoredVote>;
  /** Sent issues by id. */
  digests?: Record<string, DigestRecord>;
  talkUse?: TalkUsage;

  // ── the `digests` actor ──
  profiles?: Record<string, StoredDefinition>;
  runLease?: RunLease;
  magicRequestedAt?: number;
  /** Used sign-in link nonces → their expiry (s). */
  magicUsed?: Record<string, number>;
}

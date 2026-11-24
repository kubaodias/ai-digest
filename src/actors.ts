// The actors this agent reaches in-process through its AI_DIGEST binding, by
// conversation name: the two service actors, each watching digest's pool, and
// the runs (see agent.ts for the naming). Every name is an instance of AiDigest.

import type { ManagedEnv } from "@telnyx/acp/managed";
import type { AiDigestState, Patch } from "./actor-state.ts";
import type { AiDigest } from "./agent.ts";
import { parseProfile, type DigestProfile } from "./profile.ts";

/** The AI_DIGEST binding: the AiDigest instance for a conversation name, called in-process. */
export interface ActorNamespace {
  idFromName(name: string): AiDigest;
}

/** The service actor that keeps votes and sent issues. */
export const FEEDBACK_CONVERSATION = "feedback";
/** The service actor that stores the digest definitions (and the run lease). */
export const DIGESTS_CONVERSATION = "digests";
/** A digest's pool actor (watching). */
export const poolConversation = (digest: string) => `${digest}--pool`;

/** The actor for a conversation name. */
export const actorNamed = (env: object, name: string): AiDigest => (env as { AI_DIGEST: ActorNamespace }).AI_DIGEST.idFromName(name);
export const feedbackActor = (env: object) => actorNamed(env, FEEDBACK_CONVERSATION);
export const digestsActor = (env: object) => actorNamed(env, DIGESTS_CONVERSATION);
export const poolActor = (env: object, digest: string) => actorNamed(env, poolConversation(digest));

/** A digest's definition, parsed; undefined when it isn't stored (or is invalid). */
export async function loadProfile(env: object, id: string): Promise<DigestProfile | undefined> {
  const stored = await digestsActor(env).getDigest(id).catch(() => undefined);
  if (!stored) return undefined;
  try {
    return parseProfile(id, stored.markdown);
  } catch {
    return undefined;
  }
}

/**
 * What a role (pool-actor.ts, feedback-actor.ts, digests-actor.ts) needs of the actor it runs in:
 * its env and name, its state, and its task scheduler. AiDigest provides it.
 */
export interface ActorContext {
  readonly env: ManagedEnv;
  readonly conversation: string | undefined;
  store(): Promise<AiDigestState>;
  save(patch: Patch<AiDigestState>): Promise<void>;
  /** A task calls the AiDigest method named `method` (the runtime dispatches by name). */
  schedule(delaySeconds: number, method: string, payload?: unknown, opts?: { id?: string; maxRetries?: number }): Promise<string>;
  listSchedules(): Promise<{ id: string; name: string; due: number; everyMs?: number }[]>;
  cancelSchedule(id: string): Promise<boolean>;
}

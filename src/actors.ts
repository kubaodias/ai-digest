// The actors this agent reaches in-process through its AI_DIGEST binding, by
// conversation name: the two service actors and each watching digest's pool.

import type { ManagedEnv } from "@telnyx/acp/managed";
import { FEEDBACK_CONVERSATION } from "./feedback.ts";

/** The service actor that stores the digest definitions. */
export const DIGESTS_CONVERSATION = "digests";
/** A digest's pool actor (watching). */
export const poolConversation = (digest: string) => `${digest}--pool`;

export const feedbackActor = (env: ManagedEnv) => (env as any).AI_DIGEST.idFromName(FEEDBACK_CONVERSATION);
export const digestsActor = (env: ManagedEnv) => (env as any).AI_DIGEST.idFromName(DIGESTS_CONVERSATION);
export const poolActor = (env: ManagedEnv, digest: string) => (env as any).AI_DIGEST.idFromName(poolConversation(digest));

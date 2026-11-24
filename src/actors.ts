// The actors this agent reaches in-process through its AI_DIGEST binding, by
// conversation name: the two service actors, each watching digest's pool, and
// the runs (see agent.ts for the naming). Every name is an instance of AiDigest.

import type { AiDigest } from "./agent.ts";

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

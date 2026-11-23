// Deployment-specific settings. Nothing about a particular account lives in the
// code: each value is a Telnyx secret, set once with `telnyx-acp add secret NAME`
// and bound by name in agent.json. See docs/SETUP.md.

import type { ManagedEnv } from "@telnyx/acp/managed";

export interface DigestConfig {
  /** Sender address, on a domain verified for sending in Telnyx Email (e.g. digest@example.com). */
  emailFrom: string;
  /** Default recipients (a digest can name its own with `to:`). The model never chooses them. */
  emailTo: string[];
  /** This agent's public base URL, as `telnyx-acp deploy` prints it (e.g. https://ai-digest-xxxx.telnyxcompute.com). */
  publicUrl: string;
}

/** Secret names. Kept here so docs, agent.json and code agree. */
export const SECRET = {
  emailFrom: "DIGEST_EMAIL_FROM",
  emailTo: "DIGEST_EMAIL_TO",
  publicUrl: "PUBLIC_URL",
  feedbackKey: "FEEDBACK_KEY",
  authKey: "AGENT_AUTH_KEY",
  adminEmail: "ADMIN_EMAIL",
  /** The voice assistant's id (set by `ai-digest deploy`); talk links are added only when it's set. */
  talkAssistant: "TALK_ASSISTANT_ID",
} as const;

/** The SECRETS binding, on the actor's env and the router's alike. */
export interface SecretStore {
  get(name: string): Promise<string>;
}

export async function secret(env: ManagedEnv | { SECRETS?: SecretStore }, name: string): Promise<string | undefined> {
  const store = (env as { SECRETS?: SecretStore }).SECRETS;
  if (!store) return undefined;
  const v = await store.get(name).catch(() => "");
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Parse "a@example.com, b@example.com" into a list. */
export function parseRecipients(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

/** The config, or a list of what's missing (so the log says exactly which secret to add). */
export async function loadConfig(env: ManagedEnv): Promise<{ config?: DigestConfig; missing: string[] }> {
  const [from, to, url] = await Promise.all([secret(env, SECRET.emailFrom), secret(env, SECRET.emailTo), secret(env, SECRET.publicUrl)]);
  const emailTo = parseRecipients(to);
  const missing = [
    ...(from ? [] : [SECRET.emailFrom]),
    ...(emailTo.length ? [] : [SECRET.emailTo]),
    ...(url ? [] : [SECRET.publicUrl]),
  ];
  if (missing.length) return { missing };
  return { config: { emailFrom: from!, emailTo, publicUrl: url!.replace(/\/+$/, "") }, missing };
}

/** The FEEDBACK_KEY secret that signs the thumbs links; undefined when it isn't bound (then no links are added). */
export async function feedbackKey(env: ManagedEnv): Promise<string | undefined> {
  const secrets = (env as { SECRETS?: SecretStore }).SECRETS;
  return secrets ? ((await secrets.get(SECRET.feedbackKey).catch(() => "")) || undefined) : undefined;
}

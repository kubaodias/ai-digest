// Deployment-specific settings. Nothing about a particular account lives in the
// code: each value is a Telnyx secret, set once with `telnyx-acp add secret NAME`
// and bound by name in agent.json. See docs/SETUP.md.

import type { ManagedEnv } from "@telnyx/acp/managed";

export interface DigestConfig {
  /** Sender address, on a domain verified for sending in Telnyx Email (e.g. digest@example.com). */
  emailFrom: string;
  /** Recipients. The model never chooses them. */
  emailTo: string[];
  /** This agent's public base URL, as `telnyx-acp deploy` prints it (e.g. https://ai-digest-xxxx.telnyxcompute.com). */
  publicUrl: string;
  /** The Agent Memory profile feedback is written to (one reader per deployment). */
  memoryProfile: string;
}

/** Secret names. Kept here so docs, agent.json and code agree. */
export const SECRET = {
  emailFrom: "DIGEST_EMAIL_FROM",
  emailTo: "DIGEST_EMAIL_TO",
  publicUrl: "PUBLIC_URL",
  memoryProfile: "DIGEST_MEMORY_PROFILE",
  feedbackKey: "FEEDBACK_KEY",
} as const;

export const DEFAULT_MEMORY_PROFILE = "reader";

async function secret(env: ManagedEnv, name: string): Promise<string | undefined> {
  const store = (env as any).SECRETS;
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
  const [from, to, url, profile] = await Promise.all([
    secret(env, SECRET.emailFrom),
    secret(env, SECRET.emailTo),
    secret(env, SECRET.publicUrl),
    secret(env, SECRET.memoryProfile),
  ]);
  const emailTo = parseRecipients(to);
  const missing = [
    ...(from ? [] : [SECRET.emailFrom]),
    ...(emailTo.length ? [] : [SECRET.emailTo]),
    ...(url ? [] : [SECRET.publicUrl]),
  ];
  if (missing.length) return { missing };
  return { config: { emailFrom: from!, emailTo, publicUrl: url!.replace(/\/+$/, ""), memoryProfile: profile ?? DEFAULT_MEMORY_PROFILE }, missing };
}

/** The memory profile alone (reading preferences doesn't need the email settings). */
export async function memoryProfile(env: ManagedEnv): Promise<string> {
  return (await secret(env, SECRET.memoryProfile)) ?? DEFAULT_MEMORY_PROFILE;
}

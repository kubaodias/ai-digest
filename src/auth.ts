// Who may use the agent's public URL for RPC (starting runs) and state reads.
//
// The telnyx-acp CLI (`invoke`, `chat`, `eval`, `traces`) sends
// `Authorization: Bearer <token>` with token = HMAC-SHA256(key, "telnyx-acp operator")
// in hex, from the agent's auth key in ~/.telnyx-acp/auth-keys.json or
// TELNYX_ACP_AUTH_KEY. The agent holds the same key as the AGENT_AUTH_KEY
// secret and derives the same token, so the key itself never crosses the wire.
// Feedback links, the digest view and the icons don't go through this: they're
// served before it and carry their own signatures (feedback.ts).

export type Claim = "read" | "rpc";

/** The operator's bearer token for an auth key, exactly as the CLI derives it. */
export async function operatorToken(key: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("telnyx-acp operator")));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare without leaking where the strings differ. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The claims for a caller. With no auth key configured the agent stays open
 * (the managed default), so a deployment without the secret isn't locked out;
 * `ai-digest deploy` always configures one.
 */
export async function claimsFor(token: string | undefined, key: string | undefined): Promise<Claim[]> {
  if (!key) return ["read", "rpc"];
  if (!token) return [];
  return sameSecret(token, await operatorToken(key)) ? ["read", "rpc"] : [];
}

/** The bearer token of a request, if any. */
export function bearerToken(req: Request): string | undefined {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : undefined;
}

/**
 * Whether a request to the managed loop's HTTP front door (state streams and
 * RPC) may go through. The runtime streams state even to callers it grants no
 * claims, so the agent checks the operator token itself before handing over.
 */
export async function mayUseFrontDoor(req: Request, key: string | undefined): Promise<boolean> {
  return (await claimsFor(bearerToken(req), key)).includes("read");
}


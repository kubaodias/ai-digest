// The TELNYX binding as this code uses it: JSON calls to the Telnyx API. Responses
// are read defensively (res?.data ?? res), so they stay untyped here.

export interface TelnyxClient {
  get(path: string, opts?: { query?: Record<string, string> }): Promise<any>;
  post(path: string, opts: { body?: unknown; query?: Record<string, string> }): Promise<any>;
  delete(path: string, opts?: unknown): Promise<any>;
}

/** What only posts (the vision model, tagging, email) needs. */
export type TelnyxPoster = Pick<TelnyxClient, "post">;
/** What only reads (summaries, counts) needs. */
export type TelnyxReader = Pick<TelnyxClient, "get">;

/**
 * The binding on an env (the actor's or the router's), typed. It assumes the binding is there: a caller
 * for which it may be missing checks env.TELNYX first (as delivery.ts does), or a call fails at first use.
 */
export const telnyxOf = (env: { TELNYX?: unknown }): TelnyxClient => env.TELNYX as TelnyxClient;

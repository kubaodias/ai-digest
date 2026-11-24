// The `digests` actor: the digest definitions (with earlier versions), the run
// lease that keeps one check or issue running at a time across digests,
// sign-in link limits, and email queued for right after a request.
// AiDigest delegates to it by name; the router and pool actors call it in-process.

import type { ActorContext } from "./actors.ts";
import { SECRET, secret } from "./config.ts";
import { sendEmail } from "./email.ts";
import { claimLease, releasesLease } from "./pool.ts";
import { parseProfile, type DigestProfile } from "./profile.ts";
import { telnyxOf } from "./telnyx.ts";

/** Versions kept per digest definition. */
const KEEP_VERSIONS = 10;

export class DigestsActor {
  private readonly ctx: ActorContext;

  constructor(ctx: ActorContext) {
    this.ctx = ctx;
  }

  /** Every stored digest: id, title, window, items, watching settings, when it changed. */
  async listDigests() {
    const state = await this.ctx.store();
    return Object.values(state?.profiles ?? {})
      .filter(Boolean)
      .map((d) => {
        let p: DigestProfile | undefined;
        try {
          p = parseProfile(d.id, d.markdown);
        } catch {}
        return { id: d.id, title: p?.title ?? null, windowDays: p?.windowDays ?? null, items: p?.items ?? null, watch: p?.watch ?? null, updatedAt: d.updatedAt, versions: (d.history?.length ?? 0) + 1 };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** One digest's definition (Markdown), or null. */
  async getDigest(id: string) {
    const state = await this.ctx.store();
    const d = state?.profiles?.[id];
    return d ? { id, markdown: d.markdown, updatedAt: d.updatedAt, versions: (d.history?.length ?? 0) + 1 } : null;
  }

  /** Store a digest's definition (validated by the router), keeping the previous versions. */
  async putDigest(id: string, markdown: string) {
    const state = await this.ctx.store();
    const prev = state?.profiles?.[id];
    if (prev && prev.markdown === markdown) return { id, changed: false, versions: (prev.history?.length ?? 0) + 1 };
    const history = prev ? [{ markdown: prev.markdown, updatedAt: prev.updatedAt }, ...(prev.history ?? [])].slice(0, KEEP_VERSIONS - 1) : [];
    await this.ctx.save({ profiles: { [id]: { id, markdown, updatedAt: new Date().toISOString(), history } } });
    console.log(JSON.stringify({ digests: prev ? "updated" : "created", id }));
    return { id, changed: true, versions: history.length + 1 };
  }

  /**
   * Send an email right after the caller's request returns (the page doesn't
   * wait for the email API): stored with an immediate scheduled call. Returns
   * false when it couldn't be scheduled, so the caller sends it itself.
   * Called in-process by the router; not @rpc.
   */
  async queueEmail(mail: { to: string; subject: string; text: string; html: string }) {
    try {
      await this.ctx.schedule(0, "sendQueuedEmail", mail);
      return true;
    } catch (err) {
      console.log(JSON.stringify({ email: "schedule failed", error: err instanceof Error ? err.message : String(err) }));
      return false;
    }
  }

  /** Scheduled by queueEmail. */
  async sendQueuedEmail(mail: { to: string; subject: string; text: string; html: string }) {
    const started = Date.now();
    const from = await secret(this.ctx.env, SECRET.emailFrom);
    try {
      await sendEmail(telnyxOf(this.ctx.env), { from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html });
      console.log(JSON.stringify({ email: "sent", subject: mail.subject, ms: Date.now() - started }));
    } catch (err) {
      console.log(JSON.stringify({ email: "failed", subject: mail.subject, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** The run lease (one check or issue at a time across digests; pool.ts). Called in-process by pool actors. */
  async claimRun(owner: string, from?: string) {
    const state = await this.ctx.store();
    const r = claimLease(state.runLease, owner, Date.now(), from);
    if (r.ok) await this.ctx.save({ runLease: r.lease });
    return r.ok ? { ok: true as const } : r;
  }

  async releaseRun(owner: string) {
    const state = await this.ctx.store();
    if (releasesLease(state?.runLease, owner)) await this.ctx.save({ runLease: null });
    return { released: releasesLease(state?.runLease, owner) };
  }

  /** Sign-in links: at most one a minute. Called in-process by the page. */
  async magicRequested(now: number) {
    const state = await this.ctx.store();
    const last = state?.magicRequestedAt ?? 0;
    if (now - last < 60_000) return { ok: false, retryIn: Math.ceil((60_000 - (now - last)) / 1000) };
    await this.ctx.save({ magicRequestedAt: now });
    return { ok: true };
  }

  /** A sign-in link works once: false when its nonce was used already. Expired nonces are forgotten. */
  async consumeMagic(nonce: string, exp: number) {
    const state = await this.ctx.store();
    const used: Record<string, number> = state?.magicUsed ?? {};
    if (used[nonce]) return false;
    const nowS = Math.floor(Date.now() / 1000);
    const expired = Object.fromEntries(Object.entries(used).filter(([, e]) => e < nowS).map(([n]) => [n, null]));
    await this.ctx.save({ magicUsed: { ...expired, [nonce]: exp } });
    return true;
  }

  /** Delete a digest's definition (its sent issues, votes and memory stay). */
  async deleteDigest(id: string) {
    const state = await this.ctx.store();
    if (!state?.profiles?.[id]) return { id, deleted: false };
    await this.ctx.save({ profiles: { [id]: null } });
    console.log(JSON.stringify({ digests: "deleted", id }));
    return { id, deleted: true };
  }
}

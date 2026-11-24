// POST /v1/issues/<id>/send: email a stored issue again, to the recipients
// given or its digest's own, adding talk links when it has none.

import { DIGESTS_CONVERSATION, FEEDBACK_CONVERSATION } from "./actors.ts";
import { SECRET, parseRecipients, secret } from "./config.ts";
import { sendEmail } from "./email.ts";
import { json } from "./http.ts";
import { GENERAL_ID, parseProfile } from "./profile.ts";
import type { RouterEnv } from "./router.ts";
import { TALK_TTL_S, addTalkLinks, hasTalkLinks, issueTalkLink, rebaseLinks, talkBase, talkLinks } from "./talk.ts";

/** The recipients a request names: every address in every entry ("a@example.com, b@example.com" is two), all valid, at least one. */
export function givenRecipients(to: unknown[]): { ok: true; to: string[] } | { ok: false; message: string } {
  const words = to.flatMap((a) => (typeof a === "string" ? a.split(/[,;\s]+/).filter(Boolean) : [a]));
  const invalid = words.filter((w) => typeof w !== "string" || parseRecipients(w).length !== 1);
  if (invalid.length) return { ok: false, message: `not email addresses: ${invalid.map((a) => JSON.stringify(a)).join(", ")}` };
  if (!words.length) return { ok: false, message: "no addresses in to (leave it out to use the digest's recipients)" };
  return { ok: true, to: words as string[] };
}

/** Email a stored issue again (its stored HTML), adding talk links when it has none. */
export async function resendIssue(env: RouterEnv, id: string, to?: string[]): Promise<Response> {
  const s = (n: string) => secret(env, n);
  const [key, assistantId, from, defaultTo, publicUrl] = await Promise.all([s(SECRET.feedbackKey), s(SECRET.talkAssistant), s(SECRET.emailFrom), s(SECRET.emailTo), s(SECRET.publicUrl)]);
  const feedback = env.AI_DIGEST.idFromName(FEEDBACK_CONVERSATION);
  const record = await feedback.issueRecord(id);
  if (!record?.html) return json(404, { error: "not_found", message: `no stored issue "${id}" (GET /v1/issues lists them)` });
  if (!env.TELNYX || !from || !publicUrl) return json(503, { error: "not_configured", message: "email isn't configured" });
  // Recipients given are used as given: a mistyped one, or none at all, is an error, never a reason to
  // email the default audience. The defaults are only for a request that leaves `to` out.
  let recipients: string[];
  if (to !== undefined) {
    const given = givenRecipients(to);
    if (!given.ok) return json(400, { error: "invalid_recipients", message: given.message });
    recipients = given.to;
  } else {
    // The digest's own recipients, as a scheduled send of it would use; DIGEST_EMAIL_TO when it names none
    // (and for General and pre-digest issues). A lookup that fails, or a digest deleted since, sends nothing:
    // falling back would email an issue to people who never subscribed to it.
    recipients = [];
    if (record.profile && record.profile !== GENERAL_ID) {
      let d: { markdown: string } | null;
      try {
        d = await env.AI_DIGEST.idFromName(DIGESTS_CONVERSATION).getDigest(record.profile);
      } catch (err) {
        console.log(JSON.stringify({ issue: "resend lookup failed", id, digest: record.profile, error: err instanceof Error ? err.message : String(err) }));
        return json(503, { error: "digest_unavailable", message: `couldn't load digest "${record.profile}" to find its recipients; try again, or pass "to"` });
      }
      if (!d) return json(409, { error: "digest_gone", message: `digest "${record.profile}" no longer exists; pass "to" to send this issue` });
      recipients = parseProfile(record.profile, d.markdown).to;
    }
    if (!recipients.length) recipients = parseRecipients(defaultTo);
    if (!recipients.length) return json(400, { error: "no_recipients" });
  }
  let html = rebaseLinks(record.html, publicUrl);
  if (key && assistantId) {
    // New links last TALK_TTL_S from now: keep the issue that long.
    const added = !hasTalkLinks(html);
    if (added) html = addTalkLinks(html, await talkLinks(key, talkBase(publicUrl), id, record.items));
    if (html !== record.html) await feedback.setIssueHtml(id, html, added ? new Date(Date.now() + TALK_TTL_S * 1000).toISOString() : undefined);
  }
  const talk = hasTalkLinks(html);
  const text = `${record.subject}\n\nThis digest is best read as HTML.${talk ? `\n\n🎧 Talk about this issue: ${issueTalkLink(html) ?? ""}` : ""}`;
  const data = await sendEmail(env.TELNYX, { from, to: recipients, subject: record.subject, text, html });
  console.log(JSON.stringify({ issue: "resent", id, recipients: recipients.length, talk, email: data?.id }));
  return json(200, { issue: id, recipients: recipients.length, talkLinks: talk, email: data?.id ?? null, status: data?.status ?? null });
}

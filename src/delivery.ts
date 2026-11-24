// Delivering a finished digest: pictures, thumbs and talk links, the rendered
// email, sending it, and registering the issue with the feedback actor.

import type { ManagedEnv } from "@telnyx/acp/managed";
import { feedbackActor } from "./actors.ts";
import { SECRET, feedbackKey, loadConfig, secret } from "./config.ts";
import { renderEmailHtml, sendEmail } from "./email.ts";
import { addFeedbackLinks, feedbackBase, type DigestRecord } from "./feedback.ts";
import { addImages } from "./images.ts";
import { audienceOf, type DigestProfile } from "./profile.ts";
import { addTalkLinkText, addTalkLinks, talkBase, talkLinks } from "./talk.ts";

/** How sending a digest went: the email's id and status from the API, or why nothing was sent. */
export type Delivery =
  | { ok: true; id?: string; status?: string; imagesAdded: number; feedbackItems: number; digestId: string }
  | { ok: false; error: string };

/** Emailing a finished digest: pictures, thumbs links, render, send, and register the digest with the feedback actor. */
export async function sendDigestEmail(
  env: ManagedEnv,
  { subject, markdown, profileId, profile }: { subject: string; markdown: string; profileId: string; profile?: DigestProfile },
): Promise<Delivery> {
  const started = Date.now();
  const telnyx = env.TELNYX as any;
  if (!telnyx) return { ok: false, error: "no TELNYX binding" };
  const { config, missing } = await loadConfig(env);
  if (!config) return { ok: false, error: `missing secrets: ${missing.join(", ")} (telnyx-acp add secret NAME)` };
  const base = feedbackBase(config.publicUrl);
  const images = profile?.images ?? true;
  const to = profile?.to.length ? profile.to : config.emailTo;
  const log = (e: Record<string, unknown>) => console.log(JSON.stringify(e));
  // Pictures go into the HTML part only; a failure here never blocks the email.
  let htmlMarkdown = markdown;
  let picked: { headline: string; images: number; note?: string }[] = [];
  let pickedImages: { url: string; caption: string }[][] = [];
  if (images) {
    try {
      const r = await addImages(telnyx, markdown, log, audienceOf(profile));
      htmlMarkdown = r.markdown;
      picked = r.report.map((i) => ({ headline: i.headline, images: i.images.length, ...(i.note ? { note: i.note } : {}) }));
      pickedImages = r.report.map((i) => i.images.map((im) => ({ url: im.url, caption: im.caption })));
      log({ images: "done", items: picked.length, withImages: picked.filter((p) => p.images > 0).length, ms: Date.now() - started });
    } catch (err) {
      log({ images: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Grey thumbs links closing each item (HTML part only); skipped when the signing key is missing.
  const digestId = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 6);
  let feedbackItems = 0;
  let record: DigestRecord | undefined;
  try {
    const key = await feedbackKey(env);
    if (key) {
      const r = await addFeedbackLinks(telnyx, key, base, digestId, subject, markdown, htmlMarkdown, pickedImages);
      htmlMarkdown = r.markdown;
      record = { ...r.record, profile: profileId, ...(profile?.topic ? { topic: profile.topic } : {}) };
      feedbackItems = r.record.items.length;
      log({ feedback: "links added", digest: digestId, items: feedbackItems, tags: r.record.items.map((i) => i.tags) });
    } else log({ feedback: "no FEEDBACK_KEY; links skipped" });
  } catch (err) {
    log({ feedback: "links failed", error: err instanceof Error ? err.message : String(err) });
  }
  try {
    let html = renderEmailHtml(htmlMarkdown, subject);
    let text = markdown;
    // "Talk about this issue" and a "Discuss" link per story, once the voice assistant is deployed.
    const key = record && (await secret(env, SECRET.talkAssistant)) ? await feedbackKey(env) : undefined;
    if (key && record) {
      const links = await talkLinks(key, talkBase(config.publicUrl), digestId, record.items);
      html = addTalkLinks(html, links);
      text = addTalkLinkText(text, links.issue);
    }
    const data = await sendEmail(telnyx, { from: config.emailFrom, to, subject, text, html });
    // The feedback actor keeps the digest so a click can show the article and the digest it came from.
    if (record) {
      await feedbackActor(env)
        .registerDigest({ ...record, html })
        .catch((err: unknown) => log({ feedback: "register failed", error: err instanceof Error ? err.message : String(err) }));
    }
    log({ emailApi: "queued", ok: true, digest: profileId, id: data?.id, status: data?.status, ms: Date.now() - started });
    return { ok: true, id: data?.id, status: data?.status, imagesAdded: picked.reduce((n, p) => n + p.images, 0), feedbackItems, digestId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log({ emailApi: "failed", ok: false, error, ms: Date.now() - started });
    return { ok: false, error };
  }
}

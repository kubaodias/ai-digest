// The email: a digest's Markdown rendered as an email-safe HTML document, and
// sending mail through the Telnyx email API.

import { marked } from "marked";
import type { TelnyxPoster } from "./telnyx.ts";

/** The footer logo (the Telnyx mark, 200x200 PNG). */
const LOGO_URL = "https://www.activepieces.com/piece-icon/telnyx";

/** Marks around the issue in the email, so the talk page can take it out without depending on the layout. */
export const ISSUE_START = "<!--ai-digest:issue-->";
export const ISSUE_END = "<!--/ai-digest:issue-->";

/** Markdown → an email-safe HTML document (inline styles; Gmail drops most <style> rules). */
export function renderEmailHtml(markdown: string, subject: string): string {
  const body = (marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string)
    .replace(/<h1>/g, '<h1 style="font-size:24px;line-height:1.3;margin:0 0 20px;color:#111827;">')
    .replace(/<h2>/g, '<h2 style="font-size:18px;line-height:1.35;margin:28px 0 8px;color:#111827;border-top:1px solid #e5e7eb;padding-top:20px;">')
    .replace(/<h3>/g, '<h3 style="font-size:16px;margin:20px 0 6px;color:#111827;">')
    .replace(/<p>/g, '<p style="margin:0 0 10px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 12px;padding-left:22px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 12px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 6px;">')
    .replace(/<a href=/g, '<a style="color:#2563eb;text-decoration:none;" href=')
    .replace(/<code>/g, '<code style="font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#f3f4f6;padding:1px 4px;border-radius:4px;">')
    .replace(/<pre>/g, '<pre style="background:#f3f4f6;padding:12px;border-radius:6px;overflow:auto;">')
    // A picked image and its caption line (from images.ts) become one centered block.
    .replace(/<p[^>]*>\s*<img src="([^"]+)" alt="([^"]*)">(?:<br>)?\s*<em>([^<]*)<\/em>\s*<\/p>/g,
      '<div style="margin:14px 0 16px;text-align:center;"><img width="600" src="$1" alt="$2" style="display:block;width:100%;max-width:600px;height:auto;margin:0 auto;border-radius:8px;border:1px solid #e5e7eb;"><div style="font-size:12px;line-height:1.4;color:#6b7280;margin-top:6px;">$3</div></div>')
    .replace(/<img src=/g, '<img style="display:block;max-width:100%;height:auto;border-radius:8px;" src=')
    .replace(/<blockquote>/g, '<blockquote style="margin:0 0 12px;padding-left:12px;border-left:3px solid #e5e7eb;color:#4b5563;">');
  const title = subject.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f5f5f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#ffffff;border-radius:10px;">
<tr><td style="padding:28px 28px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;">
${ISSUE_START}
${body}
${ISSUE_END}
</td></tr>
<tr><td style="padding:14px 28px 22px;border-top:1px solid #f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:20px;color:#9ca3af;">
<span style="vertical-align:middle;">AI Digest · made with <a href="https://telnyx.com/products/edge-compute" style="color:#9ca3af;text-decoration:underline;">Telnyx Edge Compute</a></span><img src="${LOGO_URL}" width="20" height="20" alt="Telnyx" style="display:inline-block;width:20px;height:20px;border:0;vertical-align:middle;margin-left:6px;">
</td></tr>
</table></td></tr></table>
</body></html>`;
}

/** One email. `from` is the configured sender (DIGEST_EMAIL_FROM). */
export interface Mail {
  from: string | undefined;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

/**
 * Send one email; resolves to the API's record of it (its id and status), throws when the API refuses.
 * The API wants `to` as an array and the bodies as text_body / html_body (unknown fields are silently dropped).
 */
export async function sendEmail(telnyx: TelnyxPoster, mail: Mail): Promise<{ id?: string; status?: string } | undefined> {
  const res: any = await telnyx.post("/emails", { body: { from: mail.from, to: mail.to, subject: mail.subject, text_body: mail.text, html_body: mail.html } });
  return res?.data ?? res;
}

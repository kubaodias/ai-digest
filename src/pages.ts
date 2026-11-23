// The pages this function serves itself (feedback, the digests app): HTML
// escaping and the shared page frame (styles, footer, in-place links).

/** Escape text for HTML content and attribute values. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function page(title: string, body: string, status = 200, opts: { css?: string; headers?: Record<string, string>; wide?: boolean } = {}): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{--bg:#f5f5f4;--card:#fff;--ink:#1f2937;--muted:#6b7280;--faint:#9ca3af;--line:#e5e7eb;--link:#2563eb;--chip:#f3f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--card:#1b1e21;--ink:#e5e7eb;--muted:#a1a7b0;--faint:#7c838d;--line:#2c3036;--link:#7aa7ff;--chip:#262a2f}}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:620px;margin:6vh auto;padding:0 16px}
.card{background:var(--card);border-radius:12px;padding:24px;margin-bottom:14px;border:1px solid var(--line)}
h1{font-size:20px;line-height:1.35;margin:0 0 14px}h1 a{color:var(--ink)}h2{font-size:18px;margin:0 0 6px;display:flex;align-items:center;gap:10px}
p{line-height:1.55;margin:8px 0}.card>:first-child{margin-top:0}.muted{color:var(--muted);font-size:14px}.faint{color:var(--faint);font-size:13px}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.chip{background:var(--chip);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--muted)}
.row{display:flex;flex-wrap:wrap;gap:18px;margin-top:14px;font-size:14px}
img.pic{display:block;width:100%;height:auto;border-radius:8px;border:1px solid var(--line);margin:12px 0 4px;background:#fff}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 0;border-top:1px solid var(--line)}td.n{text-align:right;color:var(--muted);white-space:nowrap;padding-left:12px}
.label{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);margin:0 0 8px}
.reasons{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.reason{border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-size:13px;color:var(--muted)}
.reason.on{border-color:var(--link);color:var(--link)}.reason:hover{text-decoration:none;border-color:var(--faint)}
footer{display:flex;align-items:center;justify-content:center;gap:8px;margin:22px 0 40px;font-size:12px;color:var(--faint)}footer a{color:var(--faint);text-decoration:underline}footer img{width:18px;height:18px}
${opts.wide ? "main{max-width:880px}" : ""}${opts.css ?? ""}
</style></head><body><main>${body}<footer><span>AI Digest · made with <a href="https://telnyx.com/products/edge-compute">Telnyx Edge Compute</a></span><img src="https://www.activepieces.com/piece-icon/telnyx" width="18" height="18" alt="Telnyx"></footer></main>
<script>
// Reason, change and undo links update this page in place and replace its history entry,
// so one Back goes to the email however many times the reader clicked. Without JS they're plain links.
document.addEventListener("click", async (e) => {
  const a = e.target.closest && e.target.closest("a[data-inplace]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  try {
    const r = await fetch(a.href, { credentials: "same-origin" });
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    const next = doc.querySelector("main");
    if (!next) throw new Error("no page");
    document.querySelector("main").replaceWith(next);
    document.title = doc.title;
    history.replaceState(null, "", a.href);
  } catch {
    location.replace(a.href);
  }
});
</script></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...(opts.headers ?? {}) } },
  );
}

// Responses the API builds: JSON bodies and the thumbs icons.

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2) + "\n", { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
export const png = (b64: string) =>
  new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=2592000" } });

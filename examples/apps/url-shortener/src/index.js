// url-shortener: a tiny URL shortener served by one Cloudflare Worker.
//
//   POST /shorten  {"url": "https://..."}  -> {"code": "...", "short": "/s/code"}
//   GET  /s/:code                          -> redirect to the original URL
//
// THE PLANTED BUG (observable on the live response): the redirect for a known
// code is returned with status 200 and a Location header, instead of a real
// redirect status (302). A browser following the short link therefore does NOT
// navigate to the target; it renders an empty 200 response. The fix returns 302
// so the short link redirects as intended.
//
// Observable before/after: `curl -sS -D - <url>/s/<code>` shows `HTTP/1.1 200`
// before the fix and `HTTP/1.1 302` with a working `location:` after.

const STORE = new Map();

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter((p) => p !== "");

    if (request.method === "POST" && parts[0] === "shorten" && parts.length === 1) {
      let body = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const target = typeof body.url === "string" ? body.url : "";
      if (target === "") {
        return json({ error: "url is required" }, 400);
      }
      const code = (STORE.size + 1).toString(36);
      STORE.set(code, target);
      return json({ code, short: `/s/${code}` }, 201);
    }

    if (request.method === "GET" && parts[0] === "s" && parts.length === 2) {
      const target = STORE.get(parts[1]);
      if (!target) {
        return json({ error: "unknown code" }, 404);
      }
      // THE PLANTED BUG: a 200 with a Location header is NOT a redirect. The fix
      // returns 302 so the short link actually redirects.
      return new Response(null, { status: 200, headers: { location: target } });
    }

    return json({ error: "not found" }, 404);
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

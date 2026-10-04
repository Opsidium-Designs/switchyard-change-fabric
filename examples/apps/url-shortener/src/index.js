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

    if (request.method === "GET" && parts.length === 0) {
      return html(PAGE);
    }

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

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// A self-contained browser UI (no build step, no external assets) that drives
// the app's own JSON API. It makes the planted bug visible: the JSON routes
// alone render blank in a browser, but this page lets you shorten a URL and
// click the short link, where a 200+Location (instead of 302) lands you on a
// blank page rather than redirecting.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>url-shortener</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  form { display: flex; gap: 0.5rem; margin: 1rem 0; }
  input[type=url] { flex: 1; padding: 0.5rem; }
  button { padding: 0.5rem 1rem; cursor: pointer; }
  #result { margin-top: 1rem; }
  .note { background: #fff6d6; border: 1px solid #e0c200; border-radius: 6px; padding: 0.75rem 1rem; margin-top: 1rem; }
  code { background: #f0f0f0; padding: 0 0.25rem; border-radius: 3px; }
  a.short { font-weight: 600; }
</style>
</head>
<body>
<h1>url-shortener</h1>
<p>Paste a URL, shorten it, then click the generated short link.</p>
<form id="shorten-form">
  <input type="url" id="url" placeholder="https://example.com" required>
  <button type="submit">Shorten</button>
</form>
<div id="result"></div>
<div class="note">
  Expected: clicking the short link redirects you to the original URL.
  Actual: the link should redirect but lands on a blank page. That is the bug.
  The server answers <code>GET /s/&lt;code&gt;</code> with status
  <code>200</code> plus a <code>Location</code> header, which a browser does not
  treat as a redirect. A real redirect uses status <code>302</code>.
</div>
<script>
  const form = document.getElementById("shorten-form");
  const result = document.getElementById("result");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = document.getElementById("url").value;
    result.textContent = "Shortening...";
    try {
      const response = await fetch("/shorten", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      if (!response.ok) {
        result.textContent = "Error: " + (data.error || response.status);
        return;
      }
      const href = data.short;
      result.innerHTML =
        "Short link (click it): " +
        '<a class="short" href="' + href + '">' + href + "</a>" +
        '<p>It should take you to <code>' + escapeHtml(url) +
        "</code>, but with the current bug it lands on a blank page.</p>";
    } catch (err) {
      result.textContent = "Request failed: " + err;
    }
  });

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
</script>
</body>
</html>`;

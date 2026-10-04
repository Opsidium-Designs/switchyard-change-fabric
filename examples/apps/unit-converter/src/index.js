// unit-converter: a one-page unit converter served by one Cloudflare Worker.
//
//   GET /                      an HTML page describing the converter
//   GET /convert?c=100         convert Celsius to Fahrenheit, as JSON
//
// THE PLANTED BUG (observable on the live response): the Celsius-to-Fahrenheit
// conversion uses the wrong formula (it forgets the +32 offset), so every
// result is off by 32 degrees. `GET /convert?c=100` returns 180 instead of the
// correct 212. The fix restores the +32 so 100C -> 212F.
//
// Observable before/after: `curl <url>/convert?c=100` returns {"fahrenheit":180}
// before the fix and {"fahrenheit":212} after; the page states the expected 212.

const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>unit-converter</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto;">
    <h1>unit-converter</h1>
    <p>Convert Celsius to Fahrenheit at <code>/convert?c=100</code>.</p>
    <p>100&deg;C should be <strong>212&deg;F</strong>.</p>
  </body>
</html>
`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(PAGE, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (request.method === "GET" && url.pathname === "/convert") {
      const c = Number(url.searchParams.get("c") ?? "0");
      if (!Number.isFinite(c)) {
        return json({ error: "c must be a number" }, 400);
      }
      // THE PLANTED BUG: the +32 offset is missing. The fix is `c * 9 / 5 + 32`.
      const fahrenheit = (c * 9) / 5;
      return json({ celsius: c, fahrenheit });
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

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
    <p>This page calls the app's own <code>/convert</code> API and shows the live result.</p>
    <p>
      <label>Celsius: <input id="c" type="number" value="100" step="any" /></label>
      <button id="go" type="button">Convert</button>
    </p>
    <p id="result" aria-live="polite">Loading...</p>
    <p id="note"></p>
    <script>
      const cInput = document.getElementById("c");
      const result = document.getElementById("result");
      const note = document.getElementById("note");
      const go = document.getElementById("go");

      async function convert() {
        const c = cInput.value;
        result.textContent = "Converting...";
        note.textContent = "";
        try {
          const res = await fetch("/convert?c=" + encodeURIComponent(c));
          const data = await res.json();
          if (!res.ok || typeof data.fahrenheit !== "number") {
            result.textContent = "Error: " + (data.error || res.status);
            return;
          }
          const actual = data.fahrenheit;
          const expected = Number(c) * 9 / 5 + 32;
          result.textContent = data.celsius + "C = " + actual + "F";
          if (actual !== expected) {
            note.innerHTML =
              "<strong>Bug visible:</strong> the API returned " + actual +
              "F, but " + data.celsius + "C should be " + expected + "F.";
            note.style.color = "#b00020";
          } else {
            note.innerHTML =
              "<strong>Correct:</strong> " + data.celsius + "C = " +
              expected + "F.";
            note.style.color = "#1b5e20";
          }
        } catch (err) {
          result.textContent = "Request failed: " + err;
        }
      }

      go.addEventListener("click", convert);
      cInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") convert();
      });
      convert();
    </script>
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

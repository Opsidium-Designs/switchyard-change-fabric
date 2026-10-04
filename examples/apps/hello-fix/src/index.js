// hello-fix: the smallest real web app the Change Fabric can morph and deploy.
//
// A single-file Cloudflare Worker that serves one self-contained HTML page.
// It carries ONE deliberate, observable bug so a before/after is obvious on the
// live URL:
//
//   THE BUG: the response is sent with `Content-Type: text/plain`, so a browser
//   renders the raw HTML markup as text instead of a styled page, and a client
//   reading the header sees the wrong media type.
//
//   THE FIX: send `Content-Type: text/html; charset=utf-8` so the same markup
//   renders as the intended page.
//
// The planted (buggy) line is marked below. Flip CONTENT_TYPE to the html value
// to apply the fix; everything else stays the same, so the diff is a single
// line and the live result is visibly different.

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>hello-fix</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 40rem; color: #16233a; }
      .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; background: #0b7; color: #fff; font-size: 0.8rem; }
      code { background: #eef; padding: 0.1rem 0.3rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>hello-fix <span class="badge">fixed</span></h1>
    <p>This page is served by a single Cloudflare Worker.</p>
    <p>
      It is rendered as a styled HTML page, which means the response arrived with
      <code>Content-Type: text/html</code>. The planted bug sent
      <code>text/plain</code>, so this markup showed as raw text instead.
    </p>
  </body>
</html>
`;

// FIXED: serve the page as HTML so browsers render it.
// The planted bug set this to "text/plain; charset=utf-8".
const CONTENT_TYPE = "text/html; charset=utf-8";

export default {
  async fetch() {
    return new Response(PAGE, {
      status: 200,
      headers: { "content-type": CONTENT_TYPE },
    });
  },
};

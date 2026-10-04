# hello-fix

The smallest real web app this project can morph and deploy to a live Cloudflare
URL. It is a single-file Cloudflare Worker that serves one self-contained HTML
page, and it carries exactly one deliberate, observable bug so a before/after is
obvious on the live URL.

## The planted bug and its fix

- **Bug:** the Worker returns the HTML page with `Content-Type: text/plain`, so a
  browser renders the raw markup as text instead of a styled page, and any client
  reading the response header sees the wrong media type.
- **Fix:** return `Content-Type: text/html; charset=utf-8` so the same markup
  renders as the intended page.

The change is a single line in `src/index.js` (the `CONTENT_TYPE` constant). The
live result is visibly different: raw text before, a styled page after, and the
response header flips from `text/plain` to `text/html`.

## Files

| File | Purpose |
|------|---------|
| `src/index.js` | The Worker: serves the HTML page with the fixed `Content-Type`. |
| `wrangler.jsonc` | Worker name and `workers.dev` deploy settings. |
| `package.json` | Standalone scripts: `dev`, `deploy`, `delete`. |

## Deploy to a live URL

From the repository root:

```bash
make deploy-app APP=hello-fix     # deploys and prints the live workers.dev URL
make delete-app APP=hello-fix     # tears it down so it stops billing
```

See [`../../../docs/LIVE-DEPLOY.md`](../../../docs/LIVE-DEPLOY.md) for the exact
repeatable steps, how authentication is sourced from a gitignored `.env`, and the
teardown command.

This app is intentionally **standalone** (its own `package.json`, not part of the
repository workspaces), so deploying it does not affect the offline demo or the
root `make check`.

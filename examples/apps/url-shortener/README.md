# url-shortener example app

A tiny URL shortener served by one Cloudflare Worker:

- `POST /shorten {"url": "https://..."}` returns a short code
- `GET /s/:code` redirects to the original URL

## Planted bug

The redirect for a known code is returned with status `200` and a `Location`
header, which is NOT a real redirect, so a browser following the short link
renders an empty `200` instead of navigating. The fix returns `302`.

## Observable before/after

```bash
code=$(curl -sS -X POST <url>/shorten -d '{"url":"https://example.com"}' | sed -nE 's/.*"code":"([^"]+)".*/\1/p')
curl -sS -D - -o /dev/null <url>/s/$code | grep -iE 'HTTP|location'
# before: HTTP/1.1 200 ...  location: https://example.com   (does not redirect)
# after:  HTTP/1.1 302 ...  location: https://example.com   (redirects)
```

## Deploy and tear down

```bash
make deploy-app APP=url-shortener
make delete-app APP=url-shortener
```

See [docs/LIVE-DEPLOY.md](../../../docs/LIVE-DEPLOY.md).

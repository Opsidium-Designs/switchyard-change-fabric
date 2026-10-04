# unit-converter example app

A one-page Celsius-to-Fahrenheit converter served by one Cloudflare Worker:

- `GET /` an HTML page describing the converter
- `GET /convert?c=100` convert Celsius to Fahrenheit as JSON

## Planted bug

The conversion forgets the `+32` offset (`c * 9 / 5` instead of `c * 9 / 5 + 32`),
so every result is 32 degrees too low. `GET /convert?c=100` returns `180` instead
of the correct `212`.

## Observable before/after

```bash
curl -sS "<url>/convert?c=100"
# before: {"celsius":100,"fahrenheit":180}
# after:  {"celsius":100,"fahrenheit":212}
```

## Deploy and tear down

```bash
make deploy-app APP=unit-converter
make delete-app APP=unit-converter
```

See [docs/LIVE-DEPLOY.md](../../../docs/LIVE-DEPLOY.md).

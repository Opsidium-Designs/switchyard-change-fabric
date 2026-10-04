# todo-api example app

A tiny JSON todo API served by one Cloudflare Worker:

- `GET /todos` list todos
- `POST /todos` create from `{"title": "..."}`
- `GET /todos/:id` read one

## Planted bug (dynamic-branching example)

`POST /todos` performs no input validation: a body with no title still creates a
todo, so the list fills with empty-title items. The same missing-validation
pattern is planted in the sibling handlers under `src/routes` (each marked with a
`FABRIC-FOLLOWUP` comment), so fixing the create route reveals the identical fix
is needed across the other handlers. That is the dynamic-branching story: fixing
one thing reveals more work, and the fabric's graph grows mid-run to cover it.

## Observable before/after

```bash
# before the fix: creates an empty-title todo
curl -sS -X POST <url>/todos -d '{}'    # -> 201 {"id":"1","title":"","done":false}
# after the fix:
curl -sS -X POST <url>/todos -d '{}'    # -> 400 {"error":"title is required"}
```

## Deploy and tear down

```bash
make deploy-app APP=todo-api
make delete-app APP=todo-api
```

See [docs/LIVE-DEPLOY.md](../../../docs/LIVE-DEPLOY.md).

# demo-project

A tiny, standalone TypeScript service used as the **Change target** for the
example Change at
[`../changes/audit-logging.change.yaml`](../changes/audit-logging.change.yaml).

It is deliberately small and easy to read, with clear module
boundaries, a dependency-light design, and a fast [Vitest](https://vitest.dev)
suite so the Change Fabric's deterministic verification (build + tests +
path-scope checks) runs quickly and reproducibly.

## Module boundaries (aligned to the example Change WorkUnits)

| Module | Path | Example WorkUnit |
|--------|------|------------------|
| Audit event types + validation | `src/audit/events.ts` | shared by `api` **and** `tests` (the deterministic path collision) |
| Audit event persistence | `src/audit/store.ts` | `model` |
| Audit read API (framework-free) | `src/api/audit/handler.ts` | `api` (depends on `model`) |
| Service wiring + entry point | `src/index.ts` | (n/a) |
| Tests | `tests/audit/*.test.ts` | `tests` |

The `api -> model` dependency and the `src/audit/events.ts` collision between the
`api` and `tests` WorkUnits are what make this a useful coordination demo: see the
example Change spec for details.

## Acceptance contract (the goal's gate)

The goal ([`../goals/audit-logging.goal.txt`](../goals/audit-logging.goal.txt))
is organization-level audit logging with a read API. Today the read API only has
the unscoped `GET /audit/events` (an optional `orgId` filter) and
`GET /audit/events/:id`, which returns any organization's event. The goal adds an
organization-scoped read surface on the same framework-free `api.handle`:

| Route | Behavior |
|-------|----------|
| `GET /orgs/:orgId/audit/events` | `200 { events, count }` with only that organization's events, newest first; optional `actor` and `action` filters (an invalid `action` is `400 { error }`); a query `orgId` cannot widen the scope; an organization with no activity gets `{ events: [], count: 0 }` |
| `GET /orgs/:orgId/audit/events/:id` | `200` with the event when it belongs to `orgId`; `404` when it belongs to another organization or does not exist |

An empty organization id (`/orgs//audit/events`) is a `400` or `404`, and the
original routes keep working. The acceptance suite under `gate/` checks this
contract through the public surface only (`createService()`, `store.record`,
`api.handle`), so any implementation that honors it passes. On the baseline the
org-scoped routes do not exist, so the gate fails.

## Commands

```bash
npm install
npm run lint       # eslint (flat config)
npm run build      # tsc --build -> dist/
npm test           # vitest run (the developer suite under tests/)
npm run typecheck  # tsc --noEmit
npm run gate       # typecheck + the developer suite + the acceptance suite under gate/
```

The gate is deterministic and offline, but it needs this package's dev
dependencies installed (`npm install`): it runs `tsc` and `vitest`.

This package is intentionally **standalone** (its own `package.json`) so CI can
install, lint, build, and test it without the repo-root workspace.

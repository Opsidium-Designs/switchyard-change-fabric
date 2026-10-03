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
| Audit event types + validation | `src/audit/events.ts` | shared by `api` **and** `tests` — the deterministic path collision |
| Audit event persistence | `src/audit/store.ts` | `model` |
| Audit read API (framework-free) | `src/api/audit/handler.ts` | `api` (depends on `model`) |
| Service wiring + entry point | `src/index.ts` | — |
| Tests | `tests/audit/*.test.ts` | `tests` |

The `api -> model` dependency and the `src/audit/events.ts` collision between the
`api` and `tests` WorkUnits are what make this a useful coordination demo: see the
example Change spec for details.

## Commands

```bash
npm install
npm run lint     # eslint (flat config)
npm run build    # tsc --build -> dist/
npm test         # vitest run
```

This package is intentionally **standalone** (its own `package.json`) so CI can
install, lint, build, and test it without the repo-root workspace.

# calc-project

A tiny, standalone TypeScript math utilities library used as a second **Change
target** for the Switchyard Change Fabric decomposer, driven by the goal in
[`../goals/add-input-validation.goal.txt`](../goals/add-input-validation.goal.txt).

It exists to prove the decomposer is goal-agnostic. Its structure is
deliberately different from the audit-logging demo-project: several small,
independent modules of exported functions with no cross-module dependencies. A
goal that acts on "every exported function" therefore decomposes into a wide,
flat work graph (one WorkUnit per module, no dependency edges), a different shape
from the audit example's layered graph.

## Modules

| Module | Path | Exported functions |
|--------|------|--------------------|
| Statistics | `src/statistics.ts` | `mean`, `variance` |
| Geometry | `src/geometry.ts` | `rectangleArea`, `circleArea`, `triangleArea` |
| Finance | `src/finance.ts` | `compoundInterest`, `percentOf` |
| Temperature | `src/temperature.ts` | `celsiusToFahrenheit`, `fahrenheitToCelsius` |
| Entry point | `src/index.ts` | re-exports the above |

## Commands

```bash
npm install
npm run lint     # eslint (flat config)
npm run build    # tsc --build -> dist/
npm test         # vitest run
```

This package is intentionally **standalone** (its own `package.json`) so it can
be installed, linted, and built without the repo-root workspace.

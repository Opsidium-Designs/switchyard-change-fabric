/**
 * The template gallery descriptors.
 *
 * A template is a one-click live run the console can launch. Each declares the
 * display metadata the gallery renders (name, one-line description, an agent
 * count hint, and whether it escalates) and the launch spec the dev launcher
 * maps to a CLI invocation (the change source, the target project, and the
 * run flags). The launcher never trusts a browser-supplied path: it only ever
 * launches one of these fixed, repo-relative templates by id.
 *
 * This module is intentionally free of React and Node so both the browser UI
 * and the Node-side dev launcher import the same single source of truth.
 */

/** How a template sources its Change. */
export type TemplateSource =
  | {
      /** A hand-authored Change spec, by repo-relative path. */
      readonly kind: "change";
      readonly changeFile: string;
    }
  | {
      /** A goal decomposed against a project, by repo-relative paths. */
      readonly kind: "goal";
      readonly goalFile: string;
    };

/** One selectable template in the gallery. */
export interface Template {
  /** A stable id the launcher resolves (never a browser-supplied path). */
  readonly id: string;
  /** The display name on the card. */
  readonly name: string;
  /** A one-line description of what the run shows. */
  readonly description: string;
  /**
   * A clear, human-readable statement of WHAT THIS DOES: the small app or change
   * the run operates on, in plain language. Shown once, on the gallery card.
   */
  readonly whatItDoes: string;
  /**
   * A clear, human-readable statement of WHAT PROBLEM THIS RUN SOLVES: the
   * planted bug or missing feature the fabric fixes, and the observable
   * before/after. Shown once, on the gallery card.
   */
  readonly problemItSolves: string;
  /** A human-readable hint at how many agents the run recruits. */
  readonly agentCountHint: string;
  /**
   * Whether this template hits the evidence-unsettleable fork and PAUSES for a
   * human answer in the console. An escalating template waits on a real pending
   * escalation the human resolves in the UI; a non-escalating one runs to
   * completion with no human step.
   */
  readonly escalates: boolean;
  /** Where the Change comes from. */
  readonly source: TemplateSource;
  /** The repo-relative target project directory. */
  readonly projectDir: string;
  /**
   * For a real-app template, the app directory name under examples/apps. When
   * set, a human can Deploy the app (broken) to a stable workers.dev URL before
   * the run; a verified run then redeploys the fix to that same URL in place (it
   * never deploys fresh), and a per-run teardown deletes it.
   * Absent for the non-app intro template (which promotes to local Git only).
   */
  readonly app?: string;
  /**
   * For a DYNAMIC-BRANCHING template, the literal marker that drives discovery:
   * fixing one thing reveals the same work in sibling files that carry this
   * marker, so the WorkGraph grows mid-run as those follow-up units are
   * discovered and recruited. The mechanism is goal-agnostic (the marker is a
   * generic repo fact passed to the discovering executor, not a per-template
   * script). Absent for a template whose graph does not grow.
   */
  readonly discoverMarker?: string;
  /**
   * The repo-relative goal file a BOARD run posts, for a template whose run-live
   * source is a Change spec (run-board takes a goal, not a spec). A goal-sourced
   * template uses its own goal file and needs none.
   */
  readonly boardGoalFile?: string;
  /**
   * Board-run options for a template larger than the default launch: a higher
   * dial ceiling, a suggested dial, and the run-board budget flags it needs
   * (`--max-inflight`, `--max-turns`, `--timeout-ms`). Absent means the defaults.
   */
  readonly boardOptions?: BoardRunOptions;
}

/** The run-board options a template may carry (see Template.boardOptions). */
export interface BoardRunOptions {
  /** The highest dial max the launcher accepts for a board run (default DEFAULT_DIAL_LIMIT). */
  readonly dialLimit?: number;
  /** The dial the template is meant to run at (shown on its card; one click sets it). */
  readonly suggestedDial?: { readonly min: number; readonly max: number };
  /** `--max-inflight`: the most model calls in flight at once. */
  readonly maxInflight?: number;
  /** `--max-turns`: the run's total turn budget. */
  readonly maxTurns?: number;
  /** `--timeout-ms`: the agent-phase time limit. */
  readonly timeoutMs?: number;
}

/** The dial ceiling for a launch with no template-specific limit (the console sliders' default range). */
export const DEFAULT_DIAL_LIMIT = 8;

/**
 * The shipped templates. ONE is the simple intro (the audit-logging change);
 * the others are REAL small web apps the fabric fixes.
 *
 *   - audit-logging: the simple intro. A layered 3-agent change where two units
 *     declare the same shared file, so it ESCALATES and pauses for a human.
 *   - service-api: a multi-resource JSON API served by one Worker, one module
 *     per resource over two frozen shared contracts (requireAuth, json/problem).
 *     Every resource skips validation and auth; the fabric recruits one agent per
 *     resource. A verified fix redeploys IN PLACE only when the app was manually
 *     Deployed first; otherwise it promotes to Git with no live URL.
 *   - storefront: a multi-domain TypeScript store (catalog, orders, billing)
 *     whose gaps give each board path a reason to happen: a repeated change
 *     across handlers, a billing domain with several sub-changes, a shared money
 *     contract that must change, and one existing test pinning the old tax
 *     rounding (a human contract decision). run-live has no contract route, so
 *     there the pinned test is restored and the gate stays failing, honestly.
 *   - cityhall: the largest app, 32 modules across 8 city departments, shaped
 *     for about 30 agents on the board. Its board options carry the dial and
 *     budget flags the Makefile's run-board-cityhall target uses.
 */
export const TEMPLATES: readonly Template[] = [
  {
    id: "audit-logging",
    name: "Audit logging (intro)",
    description: "Three agents add audit logging; two share a file, so the run pauses for you.",
    whatItDoes:
      "Adds audit logging to a small TypeScript project with three agents (model, api, tests).",
    problemItSolves:
      "api and tests both declare src/audit/events.ts. The lease plan keeps it single-writer (one unit owns it, the other yields it at integration), but who should own a shared file is a call evidence cannot settle, so the run escalates and waits for your answer. The unit you choose owns the path: its version is the one integrated and shipped (an answer that names neither unit falls back to the first-declared owner, and the evidence records why). The project's gate (npm run gate) passes only once each organization's audit log is readable at /orgs/:orgId/audit/events without exposing another organization's events.",
    agentCountHint: "about 3 agents",
    escalates: true,
    source: { kind: "change", changeFile: "examples/changes/audit-logging.change.yaml" },
    projectDir: "examples/demo-project",
    boardGoalFile: "examples/goals/audit-logging.goal.txt",
  },
  {
    id: "service-api",
    name: "Fix a multi-resource API (many agents)",
    description: "A JSON API that accepts unauthenticated and invalid requests; one agent per resource fixes it.",
    whatItDoes:
      "service-api: one Cloudflare Worker serving users, orders, products, auth, search, and notifications, each its own module over frozen requireAuth and json/problem contracts.",
    problemItSolves:
      "No resource validates input or calls requireAuth. Before: an unauthenticated POST returns 201. After: it returns 401, and an invalid body returns 400. If you Deployed the app first, the verified fix redeploys to the same URL. Its home page is a tester that runs all 18 checks: about 6 of 18 pass before the fix, 18 of 18 after.",
    agentCountHint: "about 6 agents, one per resource",
    escalates: false,
    source: { kind: "goal", goalFile: "examples/goals/service-api-validation-auth.goal.txt" },
    projectDir: "examples/apps/service-api",
    app: "service-api",
  },
  {
    id: "storefront",
    name: "Make a storefront correct and safe (board)",
    description: "A TypeScript store with money, tax, refund, and auth bugs across three domains; best run with agents on the board.",
    whatItDoes:
      "storefront: one Cloudflare Worker in TypeScript with a catalog (products, categories, search), orders (cart, checkout, history), and billing (invoices, payments, tax, refunds) over shared money, http, and auth contracts, with a lockfile, so the run installs dependencies before its gate.",
    problemItSolves:
      "Money is floating-point dollars, so a $19.99 price reads back as 1998 cents and tax is truncated; refunds and payments are uncapped; writes and customer data need no token; inputs and page sizes are unchecked. The gate (typecheck, the existing tests, and an acceptance suite) passes only when all of it is fixed. The fix repeats one change across many handlers, splits billing into several sub-changes, changes the shared money contract, and contradicts one existing test that pins the old tax rounding: changing that test is a contract change you decide (on the board). Its home page is a tester: about 1 of 16 checks correct before the fix, 16 of 16 after.",
    agentCountHint: "about 4 to 8 agents",
    escalates: false,
    source: { kind: "goal", goalFile: "examples/goals/storefront-correct-and-safe.goal.txt" },
    projectDir: "examples/apps/storefront",
    app: "storefront",
  },
  {
    id: "cityhall",
    name: "Make city hall services correct (board, about 30 agents)",
    description: "A city-services API with 32 modules across 8 departments, each with its own planted bugs; built for agents on the board.",
    whatItDoes:
      "cityhall: one Cloudflare Worker in TypeScript with 32 modules across 8 city departments (utilities, parking, housing, licensing, parks, records, transit, permits) over shared money, time, validation, auth, and http contracts, with a lockfile, so the run installs dependencies before its gate.",
    problemItSolves:
      "Every module carries its own planted bugs: fees and shares off by a cent, business-day deadlines counted wrong (the start date counted, city holidays ignored), writes that need no token or staff role, other residents' records visible, and list endpoints that accept any page size. Two existing developer tests pin the old behavior, so changing them is a contract change you decide (on the board). The gate (typecheck, the developer tests, and a 237-test acceptance suite) passes only when all of it is fixed: 106 of 237 acceptance tests pass before the fix, 237 of 237 after. Its home page is a tester: about 1 of 46 checks correct before the fix, 46 of 46 after.",
    agentCountHint: "about 8 to 30 agents",
    escalates: false,
    source: { kind: "goal", goalFile: "examples/goals/cityhall-services-correct.goal.txt" },
    projectDir: "examples/apps/cityhall",
    app: "cityhall",
    // The Makefile's run-board-cityhall defaults (CH_MIN, CH_MAX, CH_INFLIGHT,
    // CH_TURNS, CH_TIMEOUT_MS): a ~36-item plan asks for ~1300 turns, and the
    // first 30-agent run needed close to the 30-minute default limit.
    boardOptions: {
      dialLimit: 30,
      suggestedDial: { min: 8, max: 30 },
      maxInflight: 8,
      maxTurns: 1400,
      timeoutMs: 4_500_000,
    },
  },
];

/** Look up a template by id. */
export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

/**
 * Whether a template can run with agents on the board (`run-board`). The board
 * run takes a goal (it has no Change-spec input), so a template can when it is
 * goal-sourced or names a `boardGoalFile`; the project and gate are the same.
 */
export function boardCapable(template: Template): boolean {
  return boardGoalFileOf(template) !== undefined;
}

/** The goal file a board run of this template posts, or undefined when it has none. */
export function boardGoalFileOf(template: Template): string | undefined {
  return template.source.kind === "goal" ? template.source.goalFile : template.boardGoalFile;
}

/** The highest dial max a launch of this template in this mode accepts. */
export function dialLimitOf(template: Template, mode: LaunchMode): number {
  return mode === "board" ? (template.boardOptions?.dialLimit ?? DEFAULT_DIAL_LIMIT) : DEFAULT_DIAL_LIMIT;
}

/** The apps the templates name: the only apps the launcher deploys or removes. */
export function templateApps(templates: readonly Template[] = TEMPLATES): string[] {
  return [...new Set(templates.flatMap((t) => (t.app ? [t.app] : [])))];
}

/** How a launch runs: the existing run-live driver, or agents on the board. */
export type LaunchMode = "live" | "board";

/**
 * Who answers a board run's contract decisions: the human in the console
 * (escalations wait durably), or an automatic policy passed to the CLI as
 * `--decide-contracts accept|reject`.
 */
export type ContractPolicy = "console" | "accept" | "reject";

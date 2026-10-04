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
   * the run operates on, in plain language. Shown on the gallery card and in the
   * run header so a watcher knows what they are looking at before and during the
   * run.
   */
  readonly whatItDoes: string;
  /**
   * A clear, human-readable statement of WHAT PROBLEM THIS RUN SOLVES: the
   * planted bug or missing feature the fabric fixes, and the observable
   * before/after. Shown on the card and in the run header.
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
   * set, the end of a successful run can deploy this app to a live workers.dev
   * URL as a clickable proof the fix works, and a per-run teardown deletes it.
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
}

/**
 * The shipped templates. ONE is the simple intro (the audit-logging change);
 * the rest are REAL small web apps the fabric fixes, each deploying to a live
 * `workers.dev` URL as end-of-run proof. Two of the app templates are the
 * DYNAMIC-BRANCHING ones: fixing one thing reveals more work (sibling files
 * carrying the same marker), so the graph grows mid-run.
 *
 *   - audit-logging: the simple intro. A layered 3-agent change that hits the
 *     shared events module, so it ESCALATES and pauses for a human decision.
 *   - todo-api: a JSON todo API with a missing-validation bug across sibling
 *     route handlers. DYNAMIC-BRANCHING: fixing the create route reveals the
 *     same fix is needed across the other handlers, and the graph grows.
 *   - metrics-dashboard: a metrics endpoint with a raw-average bug across
 *     sibling metric handlers. DYNAMIC-BRANCHING: fixing one metric reveals the
 *     same fix across the others, and the graph grows.
 *   - url-shortener: a URL shortener whose short link returns 200 instead of a
 *     302 redirect. A single focused fix (no branching).
 *   - unit-converter: a converter page whose Celsius-to-Fahrenheit formula is
 *     missing the +32 offset. A single focused fix (no branching).
 */
export const TEMPLATES: readonly Template[] = [
  {
    id: "audit-logging",
    name: "Audit logging (intro)",
    description:
      "The simple intro: three agents add audit logging; two contend for a shared module, so the run pauses for your decision.",
    whatItDoes:
      "Adds organization-level audit logging to a small TypeScript project across three coordinated agents (model, api, tests).",
    problemItSolves:
      "The api and tests agents both need to write the shared src/audit/events.ts module. Mechanical evidence cannot decide which agent owns the single write lease, so the run pauses and asks you to choose the owner, then proceeds.",
    agentCountHint: "about 3 agents",
    escalates: true,
    source: { kind: "change", changeFile: "examples/changes/audit-logging.change.yaml" },
    projectDir: "examples/demo-project",
  },
  {
    id: "todo-api",
    name: "Fix a todo API (branching)",
    description:
      "A JSON todo API that accepts todos with no title. Fixing one route reveals the same fix across sibling handlers, so the graph grows.",
    whatItDoes:
      "Operates on todo-api: a tiny JSON todo API served by one Cloudflare Worker (list, create, read). The fix is deployed to a live workers.dev URL as end-of-run proof.",
    problemItSolves:
      "POST /todos performs no input validation, so a body with no title still creates an empty-title todo. Fixing the create route reveals the identical missing-validation fix is needed across the sibling route handlers, so the fabric DISCOVERS those as new work and the graph grows mid-run. Before: POST {} returns 201 with an empty title; after: it returns 400.",
    agentCountHint: "grows from 1 to several agents",
    escalates: false,
    source: { kind: "goal", goalFile: "examples/goals/todo-api-validation.goal.txt" },
    projectDir: "examples/apps/todo-api",
    app: "todo-api",
    discoverMarker: "FABRIC-FOLLOWUP",
  },
  {
    id: "metrics-dashboard",
    name: "Fix a metrics endpoint (branching)",
    description:
      "A metrics endpoint whose averages are unrounded and break on an empty series. Fixing one metric reveals the same fix across the others.",
    whatItDoes:
      "Operates on metrics-dashboard: a tiny metrics endpoint served by one Cloudflare Worker (latency, throughput, errors). The fix is deployed to a live workers.dev URL as end-of-run proof.",
    problemItSolves:
      "Each metric's average has no empty-series guard and no rounding, so an empty series yields null (NaN) and a populated one yields a long float tail. Fixing one metric reveals the identical fix is needed across the sibling metric handlers, so the fabric DISCOVERS those as new work and the graph grows mid-run. Before: GET /metrics/errors returns null; after: 0.",
    agentCountHint: "grows from 1 to several agents",
    escalates: false,
    source: { kind: "goal", goalFile: "examples/goals/metrics-dashboard-average.goal.txt" },
    projectDir: "examples/apps/metrics-dashboard",
    app: "metrics-dashboard",
    discoverMarker: "FABRIC-FOLLOWUP",
  },
  {
    id: "url-shortener",
    name: "Fix a URL shortener",
    description:
      "A URL shortener whose short links return 200 instead of a 302 redirect, so they do not navigate. A single focused fix.",
    whatItDoes:
      "Operates on url-shortener: a tiny URL shortener served by one Cloudflare Worker (shorten, redirect). The fix is deployed to a live workers.dev URL as end-of-run proof.",
    problemItSolves:
      "GET /s/:code returns a 200 with a Location header, which is not a real redirect, so a browser following the short link renders an empty page instead of navigating. The fix returns 302. Before: HTTP 200 (no redirect); after: HTTP 302 to the target.",
    agentCountHint: "about 1 agent",
    escalates: false,
    source: { kind: "goal", goalFile: "examples/goals/url-shortener-redirect.goal.txt" },
    projectDir: "examples/apps/url-shortener",
    app: "url-shortener",
  },
  {
    id: "unit-converter",
    name: "Fix a unit converter",
    description:
      "A converter page whose Celsius-to-Fahrenheit formula is off by 32 degrees. A single focused fix.",
    whatItDoes:
      "Operates on unit-converter: a one-page Celsius-to-Fahrenheit converter served by one Cloudflare Worker. The fix is deployed to a live workers.dev URL as end-of-run proof.",
    problemItSolves:
      "The conversion forgets the +32 offset, so every result is 32 degrees too low. GET /convert?c=100 returns 180 instead of 212. The fix restores the +32. Before: fahrenheit 180; after: 212.",
    agentCountHint: "about 1 agent",
    escalates: false,
    source: { kind: "goal", goalFile: "examples/goals/unit-converter-formula.goal.txt" },
    projectDir: "examples/apps/unit-converter",
    app: "unit-converter",
  },
];

/** Look up a template by id. */
export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

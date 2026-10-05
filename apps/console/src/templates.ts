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
 * the other is a REAL small web app the fabric fixes, deploying to a live
 * `workers.dev` URL as end-of-run proof.
 *
 *   - audit-logging: the simple intro. A layered 3-agent change that hits the
 *     shared events module, so it ESCALATES and pauses for a human decision.
 *   - service-api: a multi-resource JSON API served by one Worker, deliberately
 *     modular (each resource owned by its own file) over two frozen shared
 *     contracts (requireAuth, json/problem). Every resource skips input
 *     validation and the auth check, so unauthenticated and invalid requests
 *     wrongly succeed. The fix is per-resource and independent but shares the
 *     frozen contracts, so the fabric recruits one agent per resource and they
 *     each fix their own module against the same interface. The fix is deployed
 *     to a live workers.dev URL as end-of-run proof.
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
    id: "service-api",
    name: "Fix a multi-resource API (many agents)",
    description:
      "A JSON API whose every resource accepts unauthenticated and invalid requests. One agent per resource fixes its own module against two shared contracts.",
    whatItDoes:
      "Operates on service-api: a multi-resource JSON API served by one Cloudflare Worker (users, orders, products, auth, search, notifications). Each resource is its own module; two frozen shared contracts (requireAuth and json/problem) sit at the seams. The fix is deployed to a live workers.dev URL as end-of-run proof.",
    problemItSolves:
      "Every resource skips input validation and does not call the shared requireAuth, so unauthenticated and invalid requests wrongly succeed. The fix is independent per resource (each module validates its inputs and calls requireAuth) but shares the frozen auth and response contracts, so the fabric recruits one agent per resource and each fixes its own module against the same interface. Before: an unauthenticated POST returns 201; after: it returns 401, and an invalid body returns 400.",
    agentCountHint: "about 6 agents, one per resource",
    escalates: false,
    source: { kind: "goal", goalFile: "examples/goals/service-api-validation-auth.goal.txt" },
    projectDir: "examples/apps/service-api",
    app: "service-api",
  },
];

/** Look up a template by id. */
export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

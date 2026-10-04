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
}

/**
 * The three shipped templates:
 *   - Audit logging: ~3 agents, hits the src/audit/events.ts collision, so it
 *     ESCALATES and pauses for a human answer in the console.
 *   - Validation fan-out: ~5 agents over the calc project, AUTONOMOUS (no
 *     collision, no human step).
 *   - Large: 13 agents over the wide large project, AUTONOMOUS, to show scale.
 */
export const TEMPLATES: readonly Template[] = [
  {
    id: "audit-logging",
    name: "Audit logging",
    description:
      "Three agents add organization-level audit logging. Two contend for the shared events module, so the run pauses for your decision.",
    agentCountHint: "about 3 agents",
    escalates: true,
    source: { kind: "change", changeFile: "examples/changes/audit-logging.change.yaml" },
    projectDir: "examples/demo-project",
  },
  {
    id: "validation-fanout",
    name: "Validation fan-out",
    description:
      "Agents fan out to add input validation to every exported function of a small math library. No contention, so it runs to completion on its own.",
    agentCountHint: "about 5 agents",
    escalates: false,
    source: { kind: "goal", goalFile: "examples/goals/add-input-validation.goal.txt" },
    projectDir: "examples/calc-project",
  },
  {
    id: "large",
    name: "Large (scale)",
    description:
      "The same validation goal against a wide library decomposes into more than ten agents at once, showing the fabric coordinating a run at scale.",
    agentCountHint: "13 agents",
    escalates: false,
    source: { kind: "goal", goalFile: "examples/goals/large-validation.goal.txt" },
    projectDir: "examples/large-project",
  },
];

/** Look up a template by id. */
export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

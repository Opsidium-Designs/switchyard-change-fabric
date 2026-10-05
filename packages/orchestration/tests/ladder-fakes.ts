/**
 * T11: deterministic, offline test fakes for the bounded CHANGE-LEVEL
 * model-escalation ladder, so the ladder and the per-app gate stay offline and
 * reproducible under `make check`. There is no network, no real inference, and
 * no real child_process here: the executor writes a real marker file into the
 * worktree and the gate CommandRunner reads those real files to decide pass or
 * fail, so the verification is genuinely mechanical (the model never grades its
 * own output) while remaining fully deterministic.
 *
 *   - ModelAwareExecutor extends the existing scoped-noop pattern: it writes a
 *     per-unit marker recording the model id this attempt ran. The base model id
 *     and the escalation model id are different, so an attempt's edit encodes
 *     which model produced it.
 *   - MarkerGateRunner is the injected CommandRunner the verifier/ladder run as
 *     the CHANGE-LEVEL per-app gate. It scans every `*.fix` marker in the
 *     worktree (the integration worktree the ladder builds overlays every unit's
 *     edit) and PASSES only when EVERY present marker records the configured
 *     passing model; otherwise it FAILS and names the offending marker files
 *     (e.g. `src/fix.fix`) in its stderr, so the ladder's implicated-unit
 *     attribution can map the failing file back to the unit that owns it. That
 *     makes the base round fail the gate and the escalation round pass it, with
 *     no real test run.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type {
  ExecutionResult,
  ExecutorContext,
  ExecutorProvider,
} from "@switchyard-change/model-adapters";
import type { CommandOutcome, CommandRunner } from "@switchyard-change/verification";

/** The repo-relative marker file the fake executor writes for a unit. */
export function markerPathFor(unitId: string): string {
  return `src/${unitId}.fix`;
}

/** Options for the model-id-aware fake executor. */
export interface ModelAwareExecutorOptions {
  /** The base model id recorded when a call runs with no per-attempt model. */
  readonly baseModel: string;
}

/**
 * A deterministic executor that records WHICH model id each attempt ran by
 * writing it into a per-unit marker file. It honors slice A's per-attempt model
 * id: when `context.model` is set (the ladder's escalation retry), it records
 * that id; otherwise it records the configured base model. The edit is a real
 * file in the unit's declared scope, so path-scope verification passes and the
 * gate reads a real artifact.
 */
export class ModelAwareExecutor implements ExecutorProvider {
  readonly name = "model-aware-fake";
  constructor(private readonly options: ModelAwareExecutorOptions) {}

  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const model = (context.model ?? "").trim() || this.options.baseModel;
    const rel = markerPathFor(context.workUnitId);
    const abs = join(context.worktreeDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `model: ${model}\n`, "utf8");
    return {
      status: "changed",
      changedPaths: [rel],
      logs: [`model-aware fake wrote ${rel} for model ${model}`],
      cost: { usd: 0, inputTokens: 0, outputTokens: 0, model },
      commitMessage: `WorkUnit ${context.workUnitId}: edit by ${model}`,
    };
  }
}

/** Options for the marker-reading gate CommandRunner fake. */
export interface MarkerGateRunnerOptions {
  /** The model id whose edit the gate PASSES; any other recorded model FAILS. */
  readonly passingModel: string;
  /**
   * Unit ids whose marker the gate ALWAYS passes regardless of the recorded
   * model, so a multi-unit change can have one already-correct unit and one that
   * fails round 1. Used to prove the ladder's implicated-unit attribution picks
   * only the failing unit, not all of them.
   */
  readonly alwaysPassingUnits?: readonly string[];
}

/**
 * A deterministic CommandRunner the verifier/ladder run as the CHANGE-LEVEL
 * per-app gate. It never shells out: it scans every `*.fix` marker under `src/`
 * in the worktree (the ladder's integration worktree overlays every unit's edit,
 * so all markers are present) and returns exit 0 only when EVERY present marker
 * records the configured passing model, exit 1 otherwise (including when no
 * marker is present, so an absent edit cannot auto-pass). On a failure it names
 * the offending marker file paths in stderr, so the ladder's implicated-unit
 * attribution can map a failing file back to the unit whose declared paths cover
 * it. This is mechanical and offline, and it grades real artifacts, so the
 * escalation model never grades its own output.
 */
export class MarkerGateRunner implements CommandRunner {
  readonly calls: { argv: readonly string[]; cwd: string }[] = [];
  constructor(private readonly options: MarkerGateRunnerOptions) {}

  async run(argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    this.calls.push({ argv, cwd });
    // Scan every marker the integration worktree carries (one per gated unit).
    const srcDir = join(cwd, "src");
    let entries: string[] = [];
    try {
      entries = (await readdir(srcDir)).filter((name) => name.endsWith(".fix"));
    } catch {
      entries = [];
    }
    if (entries.length === 0) {
      return { code: 1, stdout: "", stderr: "gate failed: no edit markers found under src/" };
    }
    const failing: string[] = [];
    const alwaysPass = new Set(this.options.alwaysPassingUnits ?? []);
    for (const name of entries) {
      const unitId = name.replace(/\.fix$/, "");
      const abs = join(srcDir, name);
      if (alwaysPass.has(unitId)) {
        continue; // this unit's edit is already correct; the gate passes it
      }
      let content = "";
      try {
        content = await readFile(abs, "utf8");
      } catch {
        failing.push(relative(cwd, abs));
        continue;
      }
      const match = content.match(/^model:\s*(.+)\s*$/m);
      const recorded = (match?.[1] ?? "").trim();
      if (recorded !== this.options.passingModel) {
        // Name the offending file (repo-relative) so attribution can map it to a
        // unit. node:test prints such paths in a real gate failure.
        failing.push(relative(cwd, abs));
      }
    }
    if (failing.length === 0) {
      return { code: 0, stdout: `gate passed for ${entries.length} marker(s)`, stderr: "" };
    }
    return {
      code: 1,
      stdout: "",
      stderr: `gate failed: these files do not fix the planted bug:\n${failing
        .map((f) => `  FAIL ${f}`)
        .join("\n")}`,
    };
  }
}

/**
 * The CHANGE-LEVEL gate argv. The gate is per-app (it verifies the whole app),
 * so the SAME command applies to every unit; the MarkerGateRunner scans all
 * markers rather than reading one unit's path. Kept as a function taking a unit
 * id to match the `appGateCommandFor` resolver shape run-live expects.
 */
export function gateCommandFor(_unitId: string): readonly string[] {
  return ["npm", "run", "gate"];
}

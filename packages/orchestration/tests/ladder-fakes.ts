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
  /**
   * Optional artificial delay (ms) each execute awaits before writing its
   * marker. A non-zero delay lets a bounded-concurrency re-fan overlap in-flight
   * calls so a test can observe the peak concurrency the cap allows (a strictly
   * sequential loop would peak at 1 regardless of the delay).
   */
  readonly delayMs?: number;
}

/**
 * A deterministic executor that records WHICH model id each attempt ran by
 * writing it into a per-unit marker file. It honors slice A's per-attempt model
 * id: when `context.model` is set (the ladder's escalation retry), it records
 * that id; otherwise it records the configured base model. The edit is a real
 * file in the unit's declared scope, so path-scope verification passes and the
 * gate reads a real artifact.
 *
 * It also tracks concurrency deterministically: `inFlight` is the number of
 * escalation execute calls currently running and `maxInFlight` is the peak
 * observed. A bounded-concurrency re-fan drives `maxInFlight` up to its cap
 * (never past it), while a strictly sequential loop keeps it at 1, so a test can
 * assert the re-fan parallelism from these counters without any real time
 * dependence. Only ESCALATION calls (those carrying a per-attempt
 * `context.model`) count toward the peak, so the kickoff wave's own fan-out
 * never pollutes the re-fan measurement.
 */
export class ModelAwareExecutor implements ExecutorProvider {
  readonly name = "model-aware-fake";
  /** The number of escalation (model-set) execute calls currently in flight. */
  inFlight = 0;
  /** The peak number of concurrently in-flight escalation execute calls. */
  maxInFlight = 0;
  constructor(private readonly options: ModelAwareExecutorOptions) {}

  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    // Only an escalation retry carries a per-attempt model id; the kickoff wave
    // runs with no model. Count re-fan concurrency only, so the kickoff wave's
    // own fan-out does not inflate the observed peak.
    const isEscalation = (context.model ?? "").trim() !== "";
    if (isEscalation) {
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    }
    try {
      const delay = this.options.delayMs ?? 0;
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
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
    } finally {
      if (isEscalation) {
        this.inFlight -= 1;
      }
    }
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

/**
 * The single shared file two colliding units both write in the lease-divergence
 * test. Both units declare this exact path, so write-lease coordination grants
 * one owner and makes the other yield it at integration time.
 */
export const SHARED_FIX_PATH = "src/shared.fix";

/** The content the gate treats as the real fix for the planted bug. */
export const FIXED_CONTENT = "fixed\n";
/** The content the gate treats as a non-fix (the bug is still present). */
export const BROKEN_CONTENT = "broken\n";

/**
 * A deterministic executor for the lease-divergence test. Both units write the
 * SAME shared file, but with different content keyed by unit id: the configured
 * `fixingUnit` writes the real fix (FIXED_CONTENT) and every other unit writes a
 * non-fix (BROKEN_CONTENT). This is what sets up the honest divergence: a naive
 * overlay that applies both edits (last writer wins) lands the fix, while the
 * lease-coordinated integrated tree strips the fixing unit's contested path (it
 * yields to the owner) and ships only the owner's non-fix.
 *
 * It never calls a model and does no network: it writes a real file into the
 * unit's declared scope, so path-scope verification passes and the gate reads a
 * real artifact. There is no escalation axis here (the whole point is that
 * composition, not model strength, decides the outcome), so it ignores the
 * per-attempt model id.
 */
export class SharedPathExecutor implements ExecutorProvider {
  readonly name = "shared-path-fake";
  /**
   * The unit whose edit is the real fix. Pass `"*"` to make EVERY unit write the
   * fix (used by the control case, where the shipped tree is fixed regardless of
   * which unit the lease owner is).
   */
  constructor(private readonly fixingUnit: string) {}

  async execute(context: ExecutorContext): Promise<ExecutionResult> {
    const fixes = this.fixingUnit === "*" || context.workUnitId === this.fixingUnit;
    const content = fixes ? FIXED_CONTENT : BROKEN_CONTENT;
    const abs = join(context.worktreeDir, SHARED_FIX_PATH);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return {
      status: "changed",
      changedPaths: [SHARED_FIX_PATH],
      logs: [`shared-path fake wrote ${SHARED_FIX_PATH} for ${context.workUnitId}`],
      cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
      commitMessage: `WorkUnit ${context.workUnitId}: edit ${SHARED_FIX_PATH}`,
    };
  }
}

/**
 * A content-reading CommandRunner used as the CHANGE-LEVEL per-app gate for the
 * lease-divergence test. It reads the single shared file in the worktree and
 * PASSES only when it holds FIXED_CONTENT; a missing file or BROKEN_CONTENT
 * FAILS and names the shared path in stderr so attribution can map it. It is
 * mechanical and offline (it reads the real file the executor wrote), so the
 * model never grades its own output. Because the ladder's advisory overlay
 * worktree and the authoritative integrated tree can hold DIFFERENT content for
 * this one file, the very same gate yields pass on the overlay and fail on the
 * promoted tree, which is the divergence the honesty fix must catch.
 */
export class SharedPathGateRunner implements CommandRunner {
  readonly calls: { argv: readonly string[]; cwd: string }[] = [];

  async run(argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    this.calls.push({ argv, cwd });
    const abs = join(cwd, SHARED_FIX_PATH);
    let content = "";
    try {
      content = await readFile(abs, "utf8");
    } catch {
      return {
        code: 1,
        stdout: "",
        stderr: `gate failed: ${SHARED_FIX_PATH} is missing; the planted bug is not fixed`,
      };
    }
    if (content === FIXED_CONTENT) {
      return { code: 0, stdout: `gate passed: ${SHARED_FIX_PATH} fixes the planted bug`, stderr: "" };
    }
    return {
      code: 1,
      stdout: "",
      stderr: `gate failed: ${SHARED_FIX_PATH} does not fix the planted bug`,
    };
  }
}

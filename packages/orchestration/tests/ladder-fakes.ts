/**
 * T11: deterministic, offline test fakes for the bounded model-escalation
 * ladder, so the ladder and the per-app gate stay offline and reproducible under
 * `make check`. There is no network, no real inference, and no real
 * child_process here: the executor writes a real marker file into the worktree
 * and the gate CommandRunner reads that real file to decide pass or fail, so the
 * verification is genuinely mechanical (the model never grades its own output)
 * while remaining fully deterministic.
 *
 *   - ModelAwareExecutor extends the existing scoped-noop pattern: it writes a
 *     per-unit marker recording the model id this attempt ran. The base model id
 *     and the escalation model id are different, so an attempt's edit encodes
 *     which model produced it.
 *   - MarkerGateRunner is the injected CommandRunner the verifier/ladder run as
 *     the per-app gate. It reads the marker and PASSES only when the recorded
 *     model is the configured passing model (the escalation model in the
 *     seeded-failure path), and FAILS otherwise. That makes the base attempt
 *     fail the gate and the escalation attempt pass it, with no real test run.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
}

/**
 * A deterministic CommandRunner the verifier/ladder run as the per-app gate. It
 * never shells out: it reads the per-unit marker file the fake executor wrote in
 * the worktree and returns exit 0 only when the recorded model is the configured
 * passing model, exit 1 otherwise (including when the marker is missing, so an
 * absent edit cannot auto-pass). This is mechanical and offline, and it grades a
 * real artifact, so the escalation model never grades its own output.
 *
 * The gate command argv names the unit (its last token is the marker path), so
 * the runner reads the right unit's marker in whichever worktree it runs in.
 */
export class MarkerGateRunner implements CommandRunner {
  readonly calls: { argv: readonly string[]; cwd: string }[] = [];
  constructor(private readonly options: MarkerGateRunnerOptions) {}

  async run(argv: readonly string[], cwd: string): Promise<CommandOutcome> {
    this.calls.push({ argv, cwd });
    // The gate argv carries the marker path to read as its last token, so the
    // same runner serves every unit by reading that unit's marker in the cwd.
    const rel = argv[argv.length - 1] ?? "";
    const abs = join(cwd, rel);
    let content = "";
    try {
      content = await readFile(abs, "utf8");
    } catch {
      return { code: 1, stdout: "", stderr: `no edit marker found at ${rel}` };
    }
    const match = content.match(/^model:\s*(.+)\s*$/m);
    const recorded = (match?.[1] ?? "").trim();
    if (recorded === this.options.passingModel) {
      return { code: 0, stdout: `gate passed for model ${recorded}`, stderr: "" };
    }
    return {
      code: 1,
      stdout: "",
      stderr: `gate failed: edit by ${recorded || "(none)"} does not fix the planted bug`,
    };
  }
}

/** The gate argv for a unit: carries the unit's marker path as the last token. */
export function gateCommandFor(unitId: string): readonly string[] {
  return ["node", "--test", markerPathFor(unitId)];
}

#!/usr/bin/env node
/**
 * `switchyard-change` CLI.
 *
 * The CLI is the thin front end to the fabric. It reuses the orchestration
 * package to drive a Change end to end (orchestration, runners, verification,
 * integration, conflict coordination, local Git promotion, and cleanup) with
 * the deterministic noop executor and the honest local fallback, so every
 * command runs offline with no Cloudflare account.
 *
 * Commands:
 *   doctor                 check local prerequisites and print a readiness report
 *   init  <project>        describe how a project maps to Change coordination
 *   run   <change.yaml>    run a Change end to end and print a readable summary
 *   status <change.yaml>   print the declared WorkGraph and schedule for a Change
 *   promote <change.yaml>  run a Change and promote the result into local Git
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  boardRunExitCode,
  finishWorkRoot,
  KEEP_WORK_ROOT_FLAG,
  formatDependencyInstall,
  offlineFixtureGateLabel,
  OFFLINE_TOOL_AUTHOR_LABEL,
  regionToolAuthor,
  selectToolFiller,
  initialEnvironmentCredentialKeys,
  loadDotEnvFile,
  runtimeCredentialNames,
  runtimeEnv,
  setRuntimeCredentials,
  changeToSpecYaml,
  cleanupLive,
  formatAttributionTally,
  clearAppDeployment,
  createPlanningChange,
  decideLivePlanner,
  decomposeGoal,
  failPlanningChange,
  describeChange,
  formatChangePlan,
  formatDecomposition,
  formatDoctorReport,
  formatRecruitmentSummary,
  formatRunSummary,
  buildAppGateWiring,
  plannerFallbackBanner,
  ALLOW_HEURISTIC_PLANNER_FLAG,
  projectHasGateScript,
  readAppDeployment,
  recordAppDeployment,
  boardSeedFromChange,
  formatBoardRunSummary,
  formatBoardTranscript,
  runBoard,
  runBoardOffline,
  runChange,
  runDoctor,
  selectAgentTurn,
  runFullLive,
  runRecruitment,
  runRecruitmentLive,
  selectExecutor,
  selectJev,
  selectPlanner,
  stableAppWorkerName,
  type Change,
  type ConcurrencyDial,
  type DeployApp,
  type Escalation,
  type PlannerInjection,
  type RePlanTransport,
  type TeardownApp,
  redactSecrets,
  ChildProcessCommandRunner,
  runJevSmoke,
  runToolSmoke,
  formatToolSmokeBuild,
} from "@switchyard-change/orchestration";
import { DiscoveringExecutor } from "@switchyard-change/model-adapters";

const CLI_NAME = "switchyard-change";
const VERSION = "0.0.0";

/** The repository root, resolved from this CLI file (apps/cli/src/index.ts). */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..");
}

interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  run(args: string[]): Promise<number>;
}

/**
 * Resolve the project (Change target) directory for a run. The example Change
 * targets examples/demo-project relative to the repository, so a run defaults to
 * the demo-project beside the examples/ tree the spec lives in. Callers may
 * override with --project <dir>.
 */
function resolveProjectDir(specPath: string, args: string[]): string {
  const explicit = optionValue(args, "--project");
  if (explicit) {
    return resolve(explicit);
  }
  // examples/changes/<spec>.yaml -> examples/demo-project
  const examplesDir = dirname(dirname(resolve(specPath)));
  return resolve(examplesDir, "demo-project");
}

const commands: Command[] = [
  {
    name: "jev-smoke",
    summary: "Live check: ask the decision model the contract-triage question and one noul, one choice, and one score question and print pass/fail (needs EXECUTOR=ai-gateway and credentials).",
    usage: `${CLI_NAME} jev-smoke`,
    async run() {
      const jev = selectJev();
      if (!jev.live || !jev.ask) {
        console.error(`jev-smoke: the decision model is not configured (${jev.description})`);
        return 1;
      }
      console.log(`jev-smoke: ${jev.description}`);
      const results = await runJevSmoke(jev.ask);
      for (const r of results) {
        console.log(redactSecrets(`  ${r.ok ? "PASS" : "FAIL"} ${r.type}: ${r.detail}`));
      }
      return results.every((r) => r.ok) ? 0 : 1;
    },
  },
  {
    name: "tool-smoke",
    summary: "Live check: build one agent tool (default: the service-api codemod) with the live region filler and run its own gate, N times, printing pass/fail (needs EXECUTOR=ai-gateway and credentials; no board, no Worker, no Cloudflare resource).",
    usage: `${CLI_NAME} tool-smoke [--attempts N] [--rebuilds N] [--project <dir> --inputs <glob,...>] [--goal-file <file>] [--kind codemod|scanner|check] [--capability <name>]`,
    async run(args) {
      const tools = selectToolFiller();
      if (!tools.live || !tools.filler) {
        console.error(`tool-smoke: no live tool author (${tools.description})`);
        return 1;
      }
      const explicitProject = optionValue(args, "--project");
      const projectDir = explicitProject ? resolve(explicitProject) : resolve(repoRoot(), "examples", "apps", "service-api");
      const inputsRaw = optionValue(args, "--inputs") ?? (explicitProject ? undefined : "src/resources/*.js");
      if (inputsRaw === undefined) {
        console.error("tool-smoke: --inputs is required with --project (the tool's declared scope, comma separated)");
        return 2;
      }
      const inputs = inputsRaw.split(",").map((s) => s.trim()).filter((s) => s !== "");
      const goalFile = optionValue(args, "--goal-file") ?? (explicitProject ? undefined : resolve(repoRoot(), "examples", "goals", "service-api-validation-auth.goal.txt"));
      const goal = goalFile ? (await readFile(goalFile, "utf8")).trim() : optionValue(args, "--goal");
      if (!goal) {
        console.error("tool-smoke: --goal-file or --goal is required with --project");
        return 2;
      }
      const kindRaw = optionValue(args, "--kind") ?? "codemod";
      if (!["codemod", "scanner", "check"].includes(kindRaw)) {
        console.error(`tool-smoke: --kind must be codemod, scanner, or check (got ${kindRaw})`);
        return 2;
      }
      const kind = kindRaw as "codemod" | "scanner" | "check";
      const capability = optionValue(args, "--capability") ?? (kind === "codemod" ? "codemod-unit" : `${kind === "scanner" ? "scan" : "check"}-unit`);
      const attempts = Number(optionValue(args, "--attempts") ?? "1");
      const rebuilds = Number(optionValue(args, "--rebuilds") ?? "0");
      if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20 || !Number.isInteger(rebuilds) || rebuilds < 0 || rebuilds > 5) {
        console.error("tool-smoke: --attempts must be 1..20 and --rebuilds 0..5");
        return 2;
      }
      console.log(`tool-smoke: ${tools.description}`);
      console.log(`  ${kind} ${capability} over ${projectDir} (inputs ${inputs.join(", ")}), ${attempts} attempt(s), ${rebuilds} rebuild(s) each`);
      const results = await runToolSmoke({
        filler: tools.filler,
        projectDir,
        goal,
        capability,
        kind,
        inputs,
        attempts,
        rebuilds,
        onBuild: (attempt, build, result) => console.log(redactSecrets(formatToolSmokeBuild(attempt, build, result))),
      });
      const passed = results.filter((r) => r.passed).length;
      const firstBuild = results.filter((r) => r.builds[0]?.passed).length;
      console.log(`tool-smoke: ${passed}/${results.length} attempt(s) passed their own gate (${firstBuild}/${results.length} on the first build)`);
      return passed === results.length ? 0 : 1;
    },
  },
  {
    name: "env-check",
    summary: "Confirm no credential is in this process's environment (names only); .env is read into memory instead.",
    usage: `${CLI_NAME} env-check`,
    async run() {
      // Handled in main before anything else runs (it needs the startup environment).
      return 0;
    },
  },
  {
    name: "doctor",
    summary: "Check local prerequisites and print a readiness report.",
    usage: `${CLI_NAME} doctor`,
    async run() {
      const report = await runDoctor();
      console.log(formatDoctorReport(report));
      // Doctor never fails the process on a missing optional; a missing required
      // tool is a non-zero exit so scripts can gate on it.
      return report.ready ? 0 : 1;
    },
  },
  {
    name: "init",
    summary: "Describe how a project maps to Change coordination.",
    usage: `${CLI_NAME} init <path-to-project>`,
    async run(args) {
      const target = args[0] ?? ".";
      console.log(`Project at ${resolve(target)} is ready to be a Change target.`);
      console.log(
        "Define a Change spec (see examples/changes/audit-logging.change.yaml), then run:",
      );
      console.log(`  ${CLI_NAME} run <change.yaml>`);
      return 0;
    },
  },
  {
    name: "run",
    summary: "Run a Change end to end and print a readable summary.",
    usage: `${CLI_NAME} run <change.yaml> [--project <dir>] [--keep-work-root]`,
    async run(args) {
      const specPath = args[0];
      if (!specPath) {
        console.error(`Usage: ${CLI_NAME} run <change.yaml> [--project <dir>]`);
        return 1;
      }
      const specYaml = await readFile(resolve(specPath), "utf8");
      const projectDir = resolveProjectDir(specPath, args);

      const result = await runChange({
        specYaml,
        projectDir,
        onEvent: (event) => {
          switch (event.kind) {
            case "change-created":
              console.log(`Created Change ${event.change.id}: ${event.change.objective}`);
              break;
            case "tool-built":
              console.log(
                `Agent built a tool: ${event.tool.label} (${event.tool.capability}) in ` +
                  `${event.tool.workspace.workspaceName}, consumed by ` +
                  `${event.tool.consumptions.filter((c) => c.changed).length} downstream unit(s)`,
              );
              break;
            case "wave-start":
              console.log(`Running WorkUnits: ${event.units.join(", ")}`);
              break;
            case "unit-done":
              console.log(
                `  done ${event.report.unitId} (${event.report.changedPaths.length} file(s))`,
              );
              break;
            case "verifying":
              console.log("Verifying and integrating...");
              break;
            case "promoting":
              console.log(`Promoting to local Git branch ${event.branch}...`);
              break;
            case "cleaned-up":
              console.log(`Cleaned up ${event.archived.length} workspace(s).`);
              break;
          }
        },
      });

      console.log("");
      console.log(formatRunSummary(result));
      // An offline run's scratch work root is removed unless asked to keep it.
      console.log(await finishWorkRoot({ workRoot: result.workRoot, keepAll: hasFlag(args, KEEP_WORK_ROOT_FLAG) }));
      return result.promotion.committed ? 0 : 1;
    },
  },
  {
    name: "status",
    summary: "Print the declared WorkGraph and schedule for a Change.",
    usage: `${CLI_NAME} status <change.yaml>`,
    async run(args) {
      const specPath = args[0];
      if (!specPath) {
        console.error(`Usage: ${CLI_NAME} status <change.yaml>`);
        return 1;
      }
      const specYaml = await readFile(resolve(specPath), "utf8");
      const { change, waves } = describeChange(specYaml);
      console.log(formatChangePlan(change, waves));
      return 0;
    },
  },
  {
    name: "decompose",
    summary: "Decompose a goal against a project into a WorkGraph (plan + schedule).",
    usage: `${CLI_NAME} decompose "<goal>" --project <dir>  |  ${CLI_NAME} decompose --goal-file <file> --project <dir>`,
    async run(args) {
      const goal = await resolveGoal(args);
      if (goal === undefined) {
        console.error(
          `Usage: ${CLI_NAME} decompose "<goal text>" --project <dir>\n` +
            `   or: ${CLI_NAME} decompose --goal-file <goal.txt> --project <dir>`,
        );
        return 1;
      }
      const projectDir = requireProjectDir(args);
      if (!projectDir) {
        console.error("A target project is required: pass --project <dir>.");
        return 1;
      }
      const plannerForDecompose = plannerInjectionFromEnv();
      const result = await decomposeGoal({
        goal,
        projectDir,
        ...(plannerForDecompose ? { planner: plannerForDecompose } : {}),
      });
      console.log(formatDecomposition(result));
      return 0;
    },
  },
  {
    name: "run-goal",
    summary: "Decompose a goal and run the resulting Change end to end offline.",
    usage: `${CLI_NAME} run-goal "<goal>" --project <dir> [--keep-work-root]  |  ${CLI_NAME} run-goal --goal-file <file> --project <dir> [--keep-work-root]`,
    async run(args) {
      const goal = await resolveGoal(args);
      if (goal === undefined) {
        console.error(
          `Usage: ${CLI_NAME} run-goal "<goal text>" --project <dir>\n` +
            `   or: ${CLI_NAME} run-goal --goal-file <goal.txt> --project <dir>`,
        );
        return 1;
      }
      const projectDir = requireProjectDir(args);
      if (!projectDir) {
        console.error("A target project is required: pass --project <dir>.");
        return 1;
      }
      const plannerForRunGoal = plannerInjectionFromEnv();
      const decomposition = await decomposeGoal({
        goal,
        projectDir,
        ...(plannerForRunGoal ? { planner: plannerForRunGoal } : {}),
      });
      console.log(formatDecomposition(decomposition));
      console.log("");
      console.log("Running the decomposed WorkGraph to completion offline...");
      console.log("");
      const result = await runChange({
        specYaml: changeToSpecYaml(decomposition.change),
        projectDir,
        // run-goal is the agent-for-agent tool-capability path: opt in so a goal
        // whose work repeats one mechanical transform across many files builds
        // the shared codemod (the structural detector still decides if one is
        // warranted). The plain `run` command stays off, so an ordinary change
        // emits no tool node.
        enableToolBuild: true,
      });
      console.log(formatRunSummary(result));
      console.log(await finishWorkRoot({ workRoot: result.workRoot, keepAll: hasFlag(args, KEEP_WORK_ROOT_FLAG) }));
      return result.promotion.committed ? 0 : 1;
    },
  },
  {
    name: "recruit",
    summary: "Recruit agents against a goal under a min/max dial, driven by push events (offline).",
    usage: `${CLI_NAME} recruit "<goal>" --project <dir> [--min N] [--max N]`,
    async run(args) {
      const change = await resolveChange(args);
      if (!change) {
        console.error(
          `Usage: ${CLI_NAME} recruit "<goal text>" --project <dir> [--min N] [--max N]\n` +
            `   or: ${CLI_NAME} recruit --change <change.yaml> [--min N] [--max N]`,
        );
        return 1;
      }
      const dial = dialFromArgs(args);
      console.log(
        `Recruiting for ${change.id} under dial min ${dial.minConcurrency}, max ${dial.maxConcurrency} (offline substrate)...`,
      );
      console.log("");
      const result = await runRecruitment({ change, dial });
      console.log(formatRecruitmentSummary(result));
      return result.completed.length === change.work.length ? 0 : 1;
    },
  },
  {
    name: "recruit-live",
    summary: "Recruit agents into real Cloudflare Artifact repos via a running Worker (wrangler dev).",
    usage: `${CLI_NAME} recruit-live "<goal>" --project <dir> --worker <url> [--min N] [--max N] [${ALLOW_HEURISTIC_PLANNER_FLAG}]`,
    async run(args) {
      // A live run: the LLM is the planner (fail without one unless opted in).
      if (!enforceLivePlanner(args)) {
        return 1;
      }
      const change = await resolveChange(args, { live: true });
      if (!change) {
        console.error(
          `Usage: ${CLI_NAME} recruit-live "<goal text>" --project <dir> --worker <url> [--min N] [--max N]\n` +
            `   or: ${CLI_NAME} recruit-live --change <change.yaml> --worker <url> [--min N] [--max N]`,
        );
        return 1;
      }
      const workerUrl = optionValue(args, "--worker") ?? "http://127.0.0.1:8787";
      const dial = dialFromArgs(args);
      // Give each live run a unique Change id so the real Artifact repo names it
      // provisions never collide with a prior run's just-deleted repos. Artifacts
      // repo deletion is eventually consistent, so recreating an identical repo
      // name immediately after a cleanup can be rejected; a fresh id per run side
      // steps that rough edge without weakening the per-unit isolation.
      const runId = Date.now().toString(36);
      const liveChange: Change = { ...change, id: `${change.id}-${runId}` };
      console.log(
        `Recruiting for ${liveChange.id} under dial min ${dial.minConcurrency}, max ${dial.maxConcurrency} ` +
          `against live Worker ${workerUrl}...`,
      );
      console.log("");
      const result = await runRecruitmentLive({
        change: liveChange,
        dial,
        workerUrl,
        specYaml: changeToSpecYaml(liveChange),
      });
      console.log(`Change ${result.changeId} on ${result.workerUrl}`);
      console.log(`  wave trigger: ${result.waveTrigger}`);
      console.log(`  peak concurrency: ${result.peakConcurrency}`);
      console.log(`  distinct real repos held: ${result.workspaces.length}`);
      console.log(`  any live (non-fallback) repo: ${result.anyLive ? "yes" : "no"}`);
      console.log(`  completed: ${result.completed.join(", ") || "(none)"}`);
      console.log("  waves:");
      for (const [i, wave] of result.waves.entries()) {
        console.log(
          `    ${i + 1} [${wave.trigger}]: ${wave.agents
            .map((a) => `${a.unitId}@${a.workspaceName}`)
            .join(", ")} (${wave.agents.length} at once)`,
        );
      }
      console.log(`  cleaned up repos: ${result.cleanedUp.join(", ") || "(none)"}`);
      return result.completed.length === change.work.length ? 0 : 1;
    },
  },
  {
    name: "run-live",
    summary:
      "Full live run: decompose -> recruit real agents (Workers AI) -> escalate -> verify -> integrate -> promote -> cleanup.",
    usage: `${CLI_NAME} run-live "<goal>" --project <dir> --worker <url> [--min N] [--max N] [--owner <unitId>] [--id <changeId>] [--watch] [--await-escalation] [--gate|--no-gate] [--max-model-retries N] [--keep-work-root] [${ALLOW_HEURISTIC_PLANNER_FLAG}]`,
    async run(args) {
      const projectDir = requireProjectDir(args);
      const workerUrl = optionValue(args, "--worker") ?? "http://127.0.0.1:8787";
      const dial = dialFromArgs(args);

      // Cheap preconditions run BEFORE the planning placeholder is created, so a
      // misconfigured run exits without leaving an orphaned "planning" Change on
      // the Worker.
      if (!projectDir) {
        console.error("A target project is required: pass --project <dir>.");
        return 1;
      }
      // Select the executor from the environment (.env). ai-gateway / workers-ai
      // are the live inference paths; noop is the deterministic stub. The
      // credential is read inside selectExecutor and never printed here.
      let selected;
      try {
        selected = selectExecutor();
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      // On a live goal-driven run the LLM is the planner (see enforceLivePlanner).
      if (!enforceLivePlanner(args)) {
        return 1;
      }

      // Watch mode: leave the real Artifact repos and the Change state in place
      // after the run so a human can watch the finished graph morph in the
      // console, and use a STABLE, predictable Change id (not a per-run Date.now
      // id) so the console can auto-load it without the human hand-typing it.
      // A normal (non-watch) run keeps the unique per-run id and cleans up.
      const watch = hasFlag(args, "--watch") || hasFlag(args, "--no-cleanup");
      const explicitId = optionValue(args, "--id");
      const runId = Date.now().toString(36);

      // CREATE THE CHANGE FIRST (kill the 30s of 404s): when the final Change id
      // is known CHEAPLY (without running the slow LLM planner) and a project is
      // set, create a "planning" PLACEHOLDER Change on the Worker BEFORE
      // decomposing, so the console attaches and sees the Change (status
      // "planning") within one poll instead of 404ing for the whole planner
      // latency. runFullLive later ATTACHES the decomposed plan to that same id,
      // flipping the status to "running".
      //
      // The id is cheaply known for an explicit --id (the console launcher always
      // passes one) and for a --change file (its id is parsed, no planner). For a
      // bare goal with no --id the base id is a slug of the goal the planner path
      // computes, so there is nothing cheap to pre-create against; that case
      // falls back to runFullLive creating the Change the normal way (the console
      // simply attaches a little later), with no change in behavior. The
      // placeholder create is best-effort: a failure never fails the run.
      const changeFileForHeader = optionValue(args, "--change");
      let plannedId: string | undefined;
      let planningHeader: {
        id: string;
        objective: string;
        baseline: string;
        budgetUsd: number;
        assurance: string;
      } | undefined;
      if (explicitId) {
        plannedId = explicitId;
      } else if (changeFileForHeader) {
        try {
          const headerYaml = await readFile(resolve(changeFileForHeader), "utf8");
          const headerChange = describeChange(headerYaml).change;
          const baseId = headerChange.id;
          plannedId = watch ? baseId : `${baseId}-${runId}`;
          planningHeader = {
            id: plannedId,
            objective: headerChange.objective,
            baseline: headerChange.baseline,
            budgetUsd: headerChange.budgetUsd,
            assurance: headerChange.assurance,
          };
        } catch {
          // Could not cheaply read the change file header: skip the pre-create.
        }
      }
      // For an explicit --id with a goal (the console launcher's shape), the
      // objective is the goal text and the baseline defaults to HEAD, both known
      // without the planner, so a placeholder can still be created up front.
      if (explicitId && !planningHeader) {
        const goalForHeader = await resolveGoal(args).catch(() => undefined);
        planningHeader = {
          id: explicitId,
          objective: goalForHeader ?? explicitId,
          baseline: "HEAD",
          budgetUsd: 0,
          assurance: "standard",
        };
      }
      if (planningHeader && projectDir) {
        // Fire the placeholder create BEFORE the planner runs. Best-effort: the
        // console attaches at once when it lands, and runFullLive still creates
        // the Change the normal way if it did not.
        await createPlanningChange({ workerUrl, header: planningHeader }).catch(() => false);
      }

      // Resolve (plan) the Change. If planning throws or yields nothing after the
      // placeholder was created, mark the placeholder failed (best-effort) so it
      // does not sit in "planning" forever, then exit.
      const placeholderId = planningHeader ? planningHeader.id : undefined;
      let change: Change | undefined;
      try {
        change = await resolveChange(args, { live: true });
      } catch (error) {
        if (placeholderId) {
          await failPlanningChange({
            workerUrl,
            changeId: placeholderId,
            reason: `planning failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        throw error;
      }
      if (!change) {
        if (placeholderId) {
          await failPlanningChange({
            workerUrl,
            changeId: placeholderId,
            reason: "no Change could be resolved (no goal or --change supplied)",
          });
        }
        console.error(
          `Usage: ${CLI_NAME} run-live "<goal text>" --project <dir> --worker <url> [--min N] [--max N] [--owner <unitId>]\n` +
            `   or: ${CLI_NAME} run-live --change <change.yaml> --project <dir> --worker <url> [--min N] [--max N]`,
        );
        return 1;
      }

      // Normal runs give each live run a unique Change id so real Artifact repo
      // names never collide with a prior run's just-deleted repos (deletion is
      // eventually consistent). Watch mode uses the STABLE id so the console
      // auto-loads it; it is the caller's job to run cleanup-live between watch
      // runs (the command tears the repos down and frees the stable name).
      //
      // An explicit --id overrides both strategies: the browser console
      // launcher generates a FRESH UNIQUE id per launch and passes it here so it
      // can follow exactly that run (no stable id, no collisions). An explicit
      // id is used verbatim. When a planning placeholder was pre-created above,
      // reuse exactly that id so runFullLive ATTACHES the plan to the placeholder
      // the console already attached to rather than creating a second Change.
      const liveChange: Change = plannedId
        ? { ...change, id: plannedId }
        : explicitId
          ? { ...change, id: explicitId }
          : watch
            ? change
            : { ...change, id: `${change.id}-${runId}` };

      // Whether to BLOCK on a human answering the escalation in the browser
      // rather than auto-answering it. The console launcher sets this so the
      // escalating template genuinely pauses on the real pending fork until the
      // human clicks an answer in the UI (which resolves the durable record on
      // the Worker); the beat then proceeds with that human decision. Without
      // this flag the run is non-interactive and auto-answers (reproducible CLI
      // and offline behavior is unchanged).
      const awaitEscalation = hasFlag(args, "--await-escalation");

      // The human escalation resolver for the non-interactive (CLI) path. A real
      // human chooses the lease owner for a contested path; --owner / --decision
      // supplies that non-interactively so the run is reproducible, defaulting to
      // the deterministic lease owner. When --await-escalation is set the browser
      // supplies the decision instead, so no CLI resolver is passed.
      const explicitDecision = optionValue(args, "--owner") ?? optionValue(args, "--decision");
      const resolveEscalation = async (escalation: Escalation): Promise<string> => {
        const decision =
          explicitDecision ?? escalation.options[0] ?? "proceed";
        console.log(`  human decision for ${escalation.id}: ${decision}`);
        return decision;
      };

      console.log(
        `Full live run for ${liveChange.id} under dial min ${dial.minConcurrency}, max ${dial.maxConcurrency} ` +
          `against Worker ${workerUrl}`,
      );
      console.log(`  executor: ${selected.description}`);
      console.log("");

      // Dynamic branching: when a discovery marker is supplied, wrap the chosen
      // executor so a completing unit reports follow-up work it finds carrying
      // that marker in the target repo, which the engine appends to the live
      // WorkGraph (the graph grows mid-run). The marker is a generic repo fact,
      // not a per-template script, so discovery stays goal-agnostic. The project
      // the fix targets is scanned for the marker; it defaults to --project.
      const discoverMarker = optionValue(args, "--discover-marker");
      const discoverProject = optionValue(args, "--discover-project") ?? projectDir;
      const executor = discoverMarker
        ? new DiscoveringExecutor(selected.executor, {
            marker: discoverMarker,
            projectDir: resolve(discoverProject),
          })
        : selected.executor;

      // Redeploy-in-place proof: when a real app is supplied, the run NEVER
      // deploys fresh. Deploy is a manual human step (the `deploy-app` command /
      // the console Deploy button) taken BEFORE the fix. On a verified fix, when
      // a prior manual deploy exists for this app (its per-app marker holds the
      // live URL), the run REDEPLOYS the fixed code to the app's STABLE worker
      // name, updating that existing deployment in place at the SAME URL. When no
      // manual deploy happened, the run deploys nothing and still promotes to
      // Git. Offline/in tests the redeployer and the already-deployed lookup are
      // injected, so make check never touches the network. The app name is the
      // examples/apps/<app> directory basename, so the stable name is derived
      // from the app, not the per-run id.
      const deployAppDir = optionValue(args, "--deploy-app");
      const deployAppBase = deployAppDir
        ? deployAppDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? ""
        : "";
      const deployAppName =
        optionValue(args, "--deploy-app-name") ??
        (deployAppBase ? stableAppWorkerName(deployAppBase) : undefined);
      const deployApp: DeployApp | undefined = deployAppDir
        ? async ({ appDir }) => ({ url: await wranglerDeploy(appDir) })
        : undefined;
      const teardownApp: TeardownApp | undefined = deployAppDir
        ? async ({ appDir }) => {
            await wranglerDelete(appDir);
          }
        : undefined;
      // The run only redeploys IN PLACE when a manual deploy already recorded a
      // live URL for this app (keyed by the app basename, the stable identity).
      const appAlreadyDeployed = deployAppBase
        ? async () => (await readAppDeployment(repoRoot(), deployAppBase))?.url
        : undefined;

      // The per-app verification gate + bounded model-escalation ladder. A real
      // app (its package.json declares a `gate` script) runs the mechanical gate
      // on every unit and drives the ladder; a non-app project (no `gate` script,
      // for example the intro change target) keeps today's behavior and is never
      // forced through a gate it does not have. --gate / --no-gate overrides the
      // auto-enable, and --max-model-retries bounds the ladder (default 1). The
      // escalation/base model ids are only meaningful on the live Workers AI
      // executor, so they are passed only then. The real child-process command
      // runner is used, which runs `npm run gate` in each unit's cloned worktree
      // (a seeded copy of the app project, where package.json + gate/ live).
      const gateFlag = gateFlagFromArgs(args);
      // The retry budget: an explicit --max-model-retries flag or
      // WORKERS_AI_MAX_MODEL_RETRIES wins; otherwise fall back to the budget the
      // selected executor carries (the ai-gateway path reads
      // AI_GATEWAY_MAX_MODEL_RETRIES in selectExecutor), then to the built-in
      // default. This lets AI_GATEWAY_MAX_MODEL_RETRIES take effect without the
      // CLI having to re-read it.
      const maxModelRetries = maxModelRetriesFromArgs(args, selected.maxModelRetries);
      const gateWiring = buildAppGateWiring({
        projectHasGate: await projectHasGateScript(projectDir),
        ...(gateFlag !== undefined ? { gateFlag } : {}),
        executorLive: selected.live,
        escalationModel: selected.escalationModel,
        escalationModels: selected.escalationModels,
        baseModel: selected.baseModel,
        maxModelRetries,
      });
      if (gateWiring.enabled) {
        const gateCommand = gateWiring.appGateCommandFor?.("") ?? [];
        console.log(
          `  per-app gate: ON (${gateCommand.join(" ")}), max model retries ${maxModelRetries}` +
            (selected.live && selected.escalationModel
              ? `, escalation model ${selected.escalationModel}`
              : ""),
        );
      } else if (gateWiring.requireAppGate) {
        console.error(
          "  per-app gate: DISABLED by --no-gate, but this project declares a gate. The gate is " +
            "required, so this run CANNOT pass verification and will not promote or redeploy.",
        );
      } else {
        console.log("  per-app gate: OFF (no gate script for this project)");
      }

      const result = await runFullLive({
        change: liveChange,
        dial,
        workerUrl,
        specYaml: changeToSpecYaml(liveChange),
        projectDir,
        executor,
        // Spread the gate wiring: when enabled, this threads the per-app gate
        // command, the command runner, and the model-escalation dials into the
        // run so the gate and the bounded ladder actually run; when disabled it
        // is empty, so a non-app project runs unchanged.
        ...(gateWiring.appGateCommandFor ? { appGateCommandFor: gateWiring.appGateCommandFor } : {}),
        ...(gateWiring.requireAppGate ? { requireAppGate: true } : {}),
        ...(gateWiring.verifyCommandRunner
          ? { verifyCommandRunner: gateWiring.verifyCommandRunner }
          : {}),
        ...(gateWiring.escalationModel ? { escalationModel: gateWiring.escalationModel } : {}),
        ...(gateWiring.escalationModels && gateWiring.escalationModels.length > 0
          ? { escalationModels: gateWiring.escalationModels }
          : {}),
        ...(gateWiring.baseModel ? { baseModel: gateWiring.baseModel } : {}),
        ...(gateWiring.maxModelRetries !== undefined
          ? { maxModelRetries: gateWiring.maxModelRetries }
          : {}),
        // The Jev typed-decision layer for the attribution and fix-confidence
        // junctures, selected from the same gateway env. When live, inject the
        // typed caller + threshold so the ladder asks which module a failure
        // implicates and the post-gate step records a fix-confidence advisory.
        // When not live (offline), Jev is absent, so no decision juncture runs.
        ...(() => {
          const jev = selectJev();
          return jev.live && jev.ask ? { jev: jev.ask, jevThreshold: jev.threshold } : {};
        })(),
        // The opt-in re-plan transport. When the schema-constrained planner is
        // live, the ladder re-plans WHICH units to re-fan on a verify-fail
        // instead of re-fanning the string-parse implicated set; offline it is
        // absent, so the deterministic attribution + fallback path is unchanged.
        ...(() => {
          const rePlan = rePlanFromEnv();
          return rePlan ? { rePlan } : {};
        })(),
        ...(deployAppDir ? { deployAppDir: resolve(deployAppDir) } : {}),
        ...(deployAppName ? { deployAppName } : {}),
        ...(deployApp ? { deployApp } : {}),
        ...(teardownApp ? { teardownApp } : {}),
        ...(appAlreadyDeployed ? { appAlreadyDeployed } : {}),
        // Block on the browser answer when --await-escalation is set; otherwise
        // auto-answer non-interactively through the CLI resolver.
        ...(awaitEscalation
          ? { awaitExternalResolution: true }
          : { resolveEscalation }),
        skipCleanup: watch,
        onEvent: (event) => {
          switch (event.kind) {
            case "change-created":
              console.log(`Created Change ${event.changeId} on the live Worker`);
              break;
            case "tool-built":
              console.log(
                `Agent built a tool in its own repo: ${event.tool.label} ` +
                  `(${event.tool.capability}) in ${event.tool.workspace.workspaceName} ` +
                  `[${event.tool.workspace.backend}], cloned and run by ` +
                  `${event.tool.consumptions.filter((c) => c.changed).length} downstream unit(s)`,
              );
              break;
            case "wave":
              console.log(
                `Wave [${event.wave.trigger}]: ${event.wave.agents
                  .map((a) => `${a.unitId}@${a.workspaceName}`)
                  .join(", ")} (${event.wave.concurrency} at once)`,
              );
              break;
            case "escalation-raised":
              console.log(`Escalation raised (waiting on a human): ${event.escalation.question}`);
              break;
            case "escalation-resolved":
              console.log(`Escalation resolved: ${event.escalation.decision}`);
              break;
            case "attribution-resolved":
              console.log(
                `Jev attribution of round ${event.round} picked ${event.choice}: ${event.outcome} at round ${event.passedRound} ` +
                  `(changed: ${event.fixed.join(", ") || "none"}; parse ${event.parseOutcome}` +
                  `${event.disagreement ? `; pick differed from parse: ${event.disagreement}` : ""}) (advisory, not an accuracy measure)`,
              );
              break;
            case "verifying":
              console.log("Verifying and integrating (mechanical ground truth)...");
              break;
            case "integration-verdict":
              console.log(
                event.gated === false
                  ? `Integration verdict: unverified (no gate configured: nothing checked) (${event.integratedUnits.length} unit(s) integrated)`
                  : `Integration verdict (authoritative gate): ${event.verdict} (${event.integratedUnits.length} unit(s) integrated)`,
              );
              break;
            case "promoting":
              console.log(`Promoting to local Git branch ${event.branch}...`);
              break;
            case "promotion-skipped":
              console.log(`Promotion skipped: ${event.reason}`);
              break;
            case "discovered":
              console.log(
                `Discovered ${event.added.length} follow-up unit(s) from ${event.unitId}: ` +
                  `${event.added.join(", ")} (the graph grew)`,
              );
              break;
            case "redeployed":
              console.log(
                `Redeployed the fixed app ${event.app} in place to the same live URL: ${event.url}`,
              );
              break;
            case "deploy-skipped":
              console.log(`Deploy skipped: ${event.reason}`);
              break;
            case "cleaned-up":
              console.log(`Cleaned up ${event.archived.length} real Artifact repo(s).`);
              break;
          }
        },
      });

      console.log("");
      console.log(`Change ${result.changeId} on ${result.workerUrl}`);
      console.log(`  wave trigger: ${result.waveTrigger}`);
      console.log(`  peak concurrency: ${result.peakConcurrency}`);
      console.log(`  distinct real repos held: ${result.workspaces.length}`);
      console.log(`  any live (non-fallback) repo: ${result.anyLive ? "yes" : "no"}`);
      console.log(`  real repo names: ${result.workspaces.join(", ") || "(none)"}`);
      console.log(`  completed: ${result.completed.join(", ") || "(none)"}`);
      if (result.escalation.raised) {
        console.log(
          `  escalation: raised ${result.escalation.raised.id} (waited: ${result.escalation.waited ? "yes" : "no"}), ` +
            `resolved -> ${result.escalation.resolved?.decision ?? "(none)"}`,
        );
      } else {
        console.log("  escalation: none raised (no contested shared path)");
      }
      if (result.tool) {
        console.log(
          `  tool: ${result.tool.label} (${result.tool.capability}) in its own repo ` +
            `${result.tool.workspace.workspaceName}, run by ` +
            `${result.tool.consumptions.filter((c) => c.changed).length} downstream unit(s)`,
        );
      }
      // A "verified" verdict with no final check checked nothing: label it.
      const ungated = result.evidence.integration.verdict === "verified" && result.evidence.integration.finalCheck.skipped;
      console.log(`  verification: ${ungated ? "unverified (no gate configured: nothing checked)" : result.evidence.integration.verdict}`);
      if (result.dependencyInstall) {
        console.log(`  dependency install (before the final gate): ${formatDependencyInstall(result.dependencyInstall)}`);
      }
      if (result.attribution) {
        // Advisory accuracy of the decision model's failure attribution, scored
        // against what changed before the next passing ladder round.
        console.log(`  ${formatAttributionTally(result.attribution)}`);
      }
      if (result.promotion.committed) {
        console.log(
          `  ${ungated ? "promoted unverified (no gate)" : "promoted"}: ${result.promotion.branch} (${result.promotion.commit.slice(0, 10)}) in ${result.sourceRepoDir}`,
        );
      } else if (result.promotion.refusedReason) {
        console.log(`  promoted: REFUSED (${result.promotion.refusedReason})`);
      } else {
        console.log("  promoted: nothing to promote (no changes)");
      }
      console.log(`  cleaned up repos: ${result.cleanedUp.join(", ") || "(none)"}`);
      if (result.deployment) {
        console.log(
          `  live proof URL (redeployed in place): ${result.deployment.url} (app ${result.deployment.app})`,
        );
      }
      if (watch) {
        console.log("");
        console.log("Watch mode: the real Artifact repos and Change state are LEFT in place.");
        console.log(`  this run's Change id: ${result.changeId}`);
        console.log(`  (the console is normally driven by its own template gallery; this`);
        console.log(`   command is the manual CLI path to a watchable run.)`);
        console.log(`  when done watching, tear the real repos down with:`);
        console.log(`    make clean-live   (or: ${CLI_NAME} cleanup-live --change-id ${result.changeId} --worker ${result.workerUrl})`);
      }
      // A live run keeps its promoted repo (printed above, used to verify the
      // run) and removes the rest of its scratch work root.
      console.log(
        await finishWorkRoot({ workRoot: result.workRoot, keepAll: hasFlag(args, KEEP_WORK_ROOT_FLAG), keep: [result.sourceRepoDir] }),
      );
      return result.promotion.committed && result.completed.length === change.work.length ? 0 : 1;
    },
  },
  {
    name: "run-board",
    summary:
      "Board run: agents form around a goal (the lead proposes items, workers claim, contest, push) -> integrate -> verify -> promote.",
    usage:
      `${CLI_NAME} run-board "<goal>" --project <dir> [--offline [--fixture-gate]] [--worker <url>] [--min N] [--max N] [--id <changeId>] ` +
      `[--item-turns N] [--max-turns N] [--fix-attempts N] [--timeout-ms N] [--quiet-ms N] [--token-ttl S] [--decide-contracts accept|reject] [--gate-timeout-ms N] [--integrator local|cloud] [--lockstep] [--gate|--no-gate] [--watch] [--keep-work-root] [${ALLOW_HEURISTIC_PLANNER_FLAG}]`,
    async run(args) {
      const projectDir = requireProjectDir(args);
      const goal = await resolveGoal(args);
      if (!projectDir || goal === undefined || goal === "") {
        console.error(
          `Usage: ${CLI_NAME} run-board "<goal text>" --project <dir> [--offline] [--worker <url>]\n` +
            `   or: ${CLI_NAME} run-board --goal-file <goal.txt> --project <dir> [--offline] [--worker <url>]`,
        );
        return 1;
      }
      const dial = dialFromArgs(args);
      const intFlag = (flag: string): number | undefined => {
        const raw = optionValue(args, flag);
        if (raw === undefined) {
          return undefined;
        }
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`${flag} must be a positive integer`);
        }
        return value;
      };
      const budgets = {
        ...(intFlag("--item-turns") !== undefined ? { maxTurnsPerItem: intFlag("--item-turns")! } : {}),
        ...(intFlag("--max-turns") !== undefined ? { maxRunTurns: intFlag("--max-turns")! } : {}),
        ...(intFlag("--timeout-ms") !== undefined ? { timeoutMs: intFlag("--timeout-ms")! } : {}),
        ...(intFlag("--fix-attempts") !== undefined ? { maxFixAttemptsPerItem: intFlag("--fix-attempts")! } : {}),
        ...(intFlag("--quiet-ms") !== undefined ? { quiescenceMs: intFlag("--quiet-ms")! } : {}),
      };
      const gateTimeoutRaw = optionValue(args, "--gate-timeout-ms");
      const gateTimeoutMs = gateTimeoutRaw === undefined ? undefined : Number(gateTimeoutRaw);
      if (gateTimeoutMs !== undefined && (!Number.isInteger(gateTimeoutMs) || gateTimeoutMs < 1000)) {
        console.error("Error: --gate-timeout-ms must be an integer of at least 1000");
        return 1;
      }
      // Who integrates: this process (local, the default), or the Worker's
      // integration Workflow with the gate in a Cloudflare Container (cloud).
      const integratorFlag = optionValue(args, "--integrator") ?? "local";
      if (integratorFlag !== "local" && integratorFlag !== "cloud") {
        console.error("Error: --integrator must be local or cloud");
        return 1;
      }
      if (integratorFlag === "cloud" && hasFlag(args, "--offline")) {
        console.error("Error: --integrator cloud needs a live Worker; the offline board run integrates locally");
        return 1;
      }
      const gateWiring = buildAppGateWiring({
        projectHasGate: await projectHasGateScript(projectDir),
        ...(gateTimeoutMs !== undefined ? { commandRunner: new ChildProcessCommandRunner({ timeoutMs: gateTimeoutMs }) } : {}),
        ...(gateFlagFromArgs(args) !== undefined ? { gateFlag: gateFlagFromArgs(args)! } : {}),
        executorLive: false,
        escalationModel: "",
        escalationModels: [],
        baseModel: "",
        maxModelRetries: 0,
      });
      const appGateCommand = gateWiring.enabled ? gateWiring.appGateCommandFor?.("") : undefined;
      // A contract change to the original tests is a HUMAN decision. The
      // operator gives it non-interactively with --decide-contracts (the
      // run-board counterpart of run-live's --owner); without it each decision
      // waits durably for the console or the escalation resolve route.
      const decideFlag = optionValue(args, "--decide-contracts");
      if (decideFlag !== undefined && decideFlag !== "accept" && decideFlag !== "reject") {
        console.error("Error: --decide-contracts must be accept or reject");
        return 1;
      }
      const contractOptions =
        decideFlag !== undefined
          ? {
              resolveContract: async (request: { readonly contract: string; readonly path?: string; readonly recommendation?: string }) => {
                // The advisory triage is shown; the operator's flag is the decision.
                console.log(
                  `  contract ${request.contract}${request.path ? ` on ${request.path}` : ""}: advisory triage: ` +
                    `${request.recommendation ?? "no recommendation (no decision model configured)"}`,
                );
                console.log(`  human decision (--decide-contracts): ${decideFlag} contract ${request.contract}${request.path ? ` on ${request.path}` : ""}`);
                return decideFlag as "accept" | "reject";
              },
            }
          : {};
      const gateOptions = {
        ...(appGateCommand && appGateCommand.length > 0 ? { appGateCommand } : {}),
        ...(gateWiring.requireAppGate ? { requireAppGate: true } : {}),
        ...(gateWiring.verifyCommandRunner ? { verifyCommandRunner: gateWiring.verifyCommandRunner } : {}),
      };
      const gateLine = appGateCommand
        ? `per-app gate ON (${appGateCommand.join(" ")})`
        : gateWiring.requireAppGate
          ? "per-app gate REQUIRED but disabled by --no-gate: the verdict cannot pass"
          : "per-app gate OFF (no gate script for this project)";

      if (hasFlag(args, "--offline")) {
        // The offline board run: no network, no credentials. The heuristic
        // decomposition is the lead's planner and a deterministic, goal-agnostic
        // policy takes every agent turn. Labelled as such, never a live run.
        // --fixture-gate wires the generic offline gate FIXTURE so the run shows
        // the fix loop. OFFLINE ONLY it replaces a project's declared gate (the
        // noop executor can never satisfy a real gate), and says so everywhere;
        // a live run always uses the project's declared gate.
        const fixtureGate = hasFlag(args, "--fixture-gate");
        const declaredGate = fixtureGate && (appGateCommand || gateWiring.requireAppGate) ? (appGateCommand ?? ["npm", "run", "gate"]) : undefined;
        console.log("Offline board run (no network, deterministic)");
        console.log("  planner: heuristic decomposition (offline stub)");
        console.log("  agent turns: generic deterministic policy (offline stand-in for the turn model)");
        console.log("  executor: scoped deterministic noop; workspaces: local fallback repos");
        console.log(`  agent-built tools: ${OFFLINE_TOOL_AUTHOR_LABEL}; tool gates and tool runs isolated like gate commands`);
        console.log(
          `  dial: min ${dial.minConcurrency}, max ${dial.maxConcurrency}; ` +
            (declaredGate
              ? `gate: ${offlineFixtureGateLabel(declaredGate)} (the fixture fails the first revision, naming a file it changed; passes once that file is fixed)`
              : fixtureGate
                ? "gate: the generic offline gate FIXTURE (fails the first revision, naming a file it changed; passes once that file is fixed), not a project gate"
                : gateLine),
        );
        console.log("");
        const result = await runBoardOffline({
          goal,
          projectDir,
          ...(optionValue(args, "--id") ? { changeId: optionValue(args, "--id")! } : {}),
          dial,
          // No explicit --max: the dial's max scales with the plan size.
          ...(optionValue(args, "--max") === undefined ? { scaleDial: true } : {}),
          budgets,
          // The fixture replaces the declared gate entirely (offline only).
          ...(fixtureGate ? {} : gateOptions),
          ...contractOptions,
          ...(fixtureGate ? { fixtureGate: true } : {}),
          ...(declaredGate ? { replacesDeclaredGate: declaredGate } : {}),
        });
        console.log("Board transcript:");
        console.log(redactSecrets(formatBoardTranscript(result.log)));
        console.log("");
        console.log(redactSecrets(formatBoardRunSummary(result)));
        // The offline demo's scratch work root is removed unless asked to keep it.
        console.log(await finishWorkRoot({ workRoot: result.scratchRoot ?? result.workRoot, keepAll: hasFlag(args, KEEP_WORK_ROOT_FLAG) }));
        // Non-zero unless a gate ran and passed and every item completed.
        return boardRunExitCode(result);
      }

      // A live board run: the turn model, the planner, and the executor all run
      // through the AI Gateway. Without a live turn model the run refuses; the
      // offline policy is never a silent live substitute.
      if (hasFlag(args, "--fixture-gate")) {
        console.error("Error: --fixture-gate is offline only; a live board run always uses the project's declared gate");
        return 1;
      }
      const turn = selectAgentTurn();
      if (!turn.live || !turn.transport) {
        console.error(
          `Error: a live board run needs a live turn model, but none is available (${turn.description}). ` +
            "Set EXECUTOR=ai-gateway with CLOUDFLARE_AI_GATEWAY_URL and CLOUDFLARE_AI_GATEWAY_TOKEN, or pass --offline.",
        );
        return 1;
      }
      let selected;
      try {
        selected = selectExecutor();
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      if (!enforceLivePlanner(args)) {
        return 1;
      }
      const planner = plannerInjectionFromEnv();
      const workerUrl = optionValue(args, "--worker") ?? "http://127.0.0.1:8787";
      const changeId = optionValue(args, "--id") ?? `change-board-${Date.now().toString(36)}`;
      const deployAppDir = optionValue(args, "--deploy-app");
      const deployAppBase = deployAppDir ? (deployAppDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "") : "";
      const deployAppName =
        optionValue(args, "--deploy-app-name") ?? (deployAppBase ? stableAppWorkerName(deployAppBase) : undefined);
      const ttlRaw = optionValue(args, "--token-ttl");
      console.log(`Board run for ${changeId} under dial min ${dial.minConcurrency}, max ${dial.maxConcurrency} against Worker ${workerUrl}`);
      console.log(`  agent turns: ${turn.description}`);
      console.log(`  executor: ${selected.description}`);
      console.log(`  ${gateLine}`);
      console.log(
        integratorFlag === "cloud"
          ? "  integrator: cloud (the Worker's integration Workflow gates each revision in a Cloudflare Container; promotion stays local)"
          : "  integrator: local (this process integrates and gates each revision)",
      );
      console.log("");
      const result = await runBoard({
        ...(integratorFlag === "cloud" ? { integrator: "cloud" as const, ...(gateTimeoutMs !== undefined ? { cloudGateTimeoutMs: gateTimeoutMs } : {}) } : {}),
        goal,
        projectDir,
        changeId,
        workerUrl,
        dial,
        // No explicit --max: the dial's max scales with the plan size.
        ...(optionValue(args, "--max") === undefined ? { scaleDial: true } : {}),
        transport: turn.transport,
        executor: selected.executor,
        ...(selected.escalationModels.length > 0 ? { escalationModels: selected.escalationModels } : {}),
        // Tool skeletons are filled region by region on the strongest model (anchored on the runtime's markers).
        ...(() => {
          const tools = selectToolFiller();
          return tools.live && tools.filler ? { toolAuthor: regionToolAuthor(tools.filler), toolAuthorLabel: tools.description } : {};
        })(),
        ...contractOptions,
        ...(() => {
          // The typed-decision layer, when live, only narrows failure
          // attribution (advisory); it never decides a verdict.
          const jev = selectJev();
          return jev.live && jev.ask ? { jev: jev.ask, jevThreshold: jev.threshold } : {};
        })(),
        seed: async (text) => {
          const decomposition = await decomposeGoal({ goal: text, projectDir, ...(planner ? { planner } : {}) });
          if (decomposition.change.plan?.source === "heuristic-fallback") {
            console.error(plannerFallbackBanner());
          }
          return boardSeedFromChange(decomposition.change);
        },
        schedule: hasFlag(args, "--lockstep") ? "lockstep" : "concurrent",
        budgets,
        ...(ttlRaw !== undefined ? { workspaceTtlSeconds: Number(ttlRaw) } : {}),
        ...gateOptions,
        ...(hasFlag(args, "--watch") ? { skipCleanup: true } : {}),
        ...(deployAppDir ? { deployAppDir: resolve(deployAppDir) } : {}),
        ...(deployAppName ? { deployAppName } : {}),
        ...(deployAppDir ? { deployApp: (async ({ appDir }) => ({ url: await wranglerDeploy(appDir) })) as DeployApp } : {}),
        ...(deployAppBase
          ? { appAlreadyDeployed: async () => (await readAppDeployment(repoRoot(), deployAppBase))?.url }
          : {}),
        onEvent: (event) => {
          switch (event.kind) {
            case "change-created":
              console.log(`Change ${event.changeId} created.`);
              break;
            case "budgets":
              console.log(
                `  budgets: ${event.maxFixAttempts} fix attempt(s) per item (${event.fixAttemptsScaled ? `scaled with ${event.items} planned item(s)` : "explicit"}), dial max ${event.dialMax} (${event.dialScaled ? `scaled with ${event.items} planned item(s)` : "explicit"}), ${event.maxRunTurns} run turn(s) (${event.runTurnsScaled ? `scaled with ${event.items} planned item(s)` : "explicit"})`,
              );
              break;
            case "goal-posted":
              console.log(`  goal posted; immutable acceptance gate (never changed): ${(event.immutable ?? []).join(", ") || "none"}`);
              console.log(`  contract-changeable developer tests and configs (a human decides): ${event.protected.filter((p) => !(event.immutable ?? []).includes(p)).join(", ") || "none"}`);
              console.log(`  baseline gate inventory: ${event.testInventory}`);
              break;
            case "contract-awaiting-human":
              console.log(
                `  contract ${event.contract}${event.path ? ` on ${event.path}` : ""} waits for a human decision: resolve escalation ${event.escalationId} in the console or POST /changes/${changeId}/escalations/${event.escalationId}/resolve {"decision":"accept"|"reject"}`,
              );
              if (event.recommendation !== undefined) {
                console.log(redactSecrets(`    advisory triage: ${event.recommendation}`));
              }
              break;
            case "contract-decision":
              console.log(`  contract ${event.contract}${event.path ? ` on ${event.path}` : ""}: ${event.decision} (human)`);
              break;
            case "seeded":
              console.log(`  lead seeded ${event.items} item(s) (planner: ${event.source}${event.model ? `, ${event.model}` : ""})`);
              break;
            case "agent-joined":
              console.log(`  ${event.agent} joined (${event.role})${event.workspace ? ` with repo ${event.workspace} (${event.backend})` : ""}`);
              break;
            case "turn": {
              const r = event.record;
              const what = r.action.type === "wait" ? `wait (${r.action.reason})` : r.action.type;
              console.log(redactSecrets(`  [${r.agent}] turn ${r.turn}: ${what} -> ${r.outcome}${r.code ? ` ${r.code}: ${r.error ?? ""}` : ""}`));
              break;
            }
            case "agent-stopped":
              console.log(`  ${event.agent} stopped: ${event.stop.detail}`);
              break;
            case "agents-done":
              console.log(`Agent phase ended: ${event.reason}${event.detail ? ` (${event.detail})` : ""}.`);
              break;
            case "integrated": {
              const r = event.revision;
              console.log(
                `  integrated revision ${r.n}: gate ${r.gate}, merged ${r.merged.length} push(es)` +
                  (r.implicated ? `; implicated (${r.implicated.source}) ${r.implicated.items.join(", ")}` : "") +
                  (r.fixRequested && r.fixRequested.length > 0 ? `; fix requested from the owners of ${r.fixRequested.join(", ")}` : ""),
              );
              if (r.failure) {
                console.log(redactSecrets(`    failure: ${r.failure}`));
              }
              break;
            }
            case "integration-not-recorded":
              console.log(`  integration recorded no revision: ${event.reason}`);
              break;
            case "promotion-skipped":
              console.log(`  promotion skipped: ${event.reason}`);
              break;
            case "redeployed":
              console.log(`  redeployed in place: ${event.url}`);
              break;
            case "deploy-skipped":
              console.log(`  deploy skipped: ${event.reason}`);
              break;
            default:
              break;
          }
        },
      });
      console.log("");
      console.log("Board transcript:");
      console.log(redactSecrets(formatBoardTranscript(result.log)));
      console.log("");
      console.log(redactSecrets(formatBoardRunSummary(result)));
      // A live run keeps its promoted repo and removes the rest of its work root.
      console.log(
        await finishWorkRoot({
          workRoot: result.workRoot,
          keepAll: hasFlag(args, KEEP_WORK_ROOT_FLAG),
          ...(result.sourceRepoDir ? { keep: [result.sourceRepoDir] } : {}),
        }),
      );
      // Non-zero unless a gate ran and passed, every item completed, and it was promoted.
      return boardRunExitCode(result, { requirePromotion: true });
    },
  },
  {
    name: "deploy-app",
    summary: "Manually deploy an example app to its STABLE live URL (before a fix).",
    usage: `${CLI_NAME} deploy-app --app <name> [--worker <url>]`,
    async run(args) {
      // The MANUAL deploy: deploy examples/apps/<app> in its CURRENT (possibly
      // broken) state to its STABLE worker name, so a human sees the break at a
      // real URL BEFORE launching a fix. It records a per-app marker holding the
      // live URL, which a later verified run reads to redeploy IN PLACE to the
      // same URL. This never auto-runs a fix; it is purely the deploy hop.
      const app = optionValue(args, "--app") ?? optionValue(args, "--deploy-app");
      if (!app) {
        console.error(`Usage: ${CLI_NAME} deploy-app --app <name> [--worker <url>]`);
        return 1;
      }
      const appDir = resolve(repoRoot(), "examples/apps", app);
      try {
        const url = await wranglerDeploy(appDir);
        const marker = await recordAppDeployment(repoRoot(), app, url);
        console.log(`Deployed ${app} to its stable worker ${marker.workerName}`);
        console.log(`  live URL: ${url}`);
        console.log(`  (this is the CURRENT state; launch a fix to redeploy in place to the same URL)`);
        return 0;
      } catch (error) {
        console.error(`Deploy failed: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    },
  },
  {
    name: "cleanup-live",
    summary: "Tear down the real Artifact repos a watch-mode run left in place.",
    usage: `${CLI_NAME} cleanup-live --change-id <id> [--app <name>] [--worker <url>]`,
    async run(args) {
      const changeId = optionValue(args, "--change-id") ?? optionValue(args, "--change");
      if (!changeId) {
        console.error(`Usage: ${CLI_NAME} cleanup-live --change-id <id> [--app <name>] [--worker <url>]`);
        return 1;
      }
      const workerUrl = optionValue(args, "--worker") ?? "http://127.0.0.1:8787";
      // The app to tear down may be passed explicitly (the console knows the
      // active template's app even when the run never redeployed), falling back
      // to whatever the run recorded on state. Deployment is per-app and keyed by
      // the stable worker name, so teardown deletes that stable worker in
      // examples/apps/<app>, and the per-app marker is cleared.
      const app = optionValue(args, "--app");
      const teardownApp: TeardownApp = async ({ appDir }) => {
        await wranglerDelete(resolve(repoRoot(), "examples/apps", appDir));
      };
      const result = await cleanupLive({
        changeId,
        workerUrl,
        teardownApp,
        onAppTornDown: async (tornApp) => clearAppDeployment(repoRoot(), tornApp),
        ...(app ? { app } : {}),
      });
      console.log(`Cleaning up Change ${result.changeId} on ${result.workerUrl}`);
      console.log(`  recorded repos: ${result.workspaces.join(", ") || "(none)"}`);
      console.log(`  archived repos: ${result.archived.join(", ") || "(none)"}`);
      if (result.appTornDown) {
        console.log(`  torn down app: ${result.appTornDown} (stable worker ${stableAppWorkerName(result.appTornDown)})`);
      }
      // A clean teardown archived every recorded repo.
      return result.archived.length === result.workspaces.length ? 0 : 1;
    },
  },
  {
    name: "promote",
    summary: "Run a Change and promote the verified result into local Git.",
    usage: `${CLI_NAME} promote <change.yaml> [--project <dir>] [--keep-work-root]`,
    async run(args) {
      const specPath = args[0];
      if (!specPath) {
        console.error(`Usage: ${CLI_NAME} promote <change.yaml> [--project <dir>]`);
        return 1;
      }
      const specYaml = await readFile(resolve(specPath), "utf8");
      const projectDir = resolveProjectDir(specPath, args);
      const result = await runChange({ specYaml, projectDir });
      console.log(formatRunSummary(result));
      // The promoted repo is the point of this command: keep it, drop the rest.
      console.log(await finishWorkRoot({ workRoot: result.workRoot, keepAll: hasFlag(args, KEEP_WORK_ROOT_FLAG), keep: [result.sourceRepoDir] }));
      if (!result.promotion.committed) {
        console.error("Nothing was promoted (the Change produced no changes).");
        return 1;
      }
      console.log("");
      console.log(
        `Promoted ${result.changeId} to ${result.promotion.branch} ` +
          `(${result.promotion.commit.slice(0, 10)}) in ${result.sourceRepoDir}`,
      );
      return 0;
    },
  },
];

const commandMap = new Map(commands.map((c) => [c.name, c]));

function printHelp(): void {
  console.log(`${CLI_NAME} v${VERSION}: agent-native change coordination (spike)\n`);
  console.log(`Usage: ${CLI_NAME} <command> [options]\n`);
  console.log("Commands:");
  const width = Math.max(...commands.map((c) => c.name.length));
  for (const c of commands) {
    console.log(`  ${c.name.padEnd(width)}  ${c.summary}`);
  }
  console.log("\nGlobal options:");
  console.log("  -h, --help       Show this help");
  console.log("  -v, --version    Show the CLI version");
}

/** Read the value following a flag like --project, or undefined. */
function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) {
    return undefined;
  }
  return args[index + 1];
}

/** True when a boolean flag like --watch is present in the args. */
function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Resolve the --gate / --no-gate toggle for the per-app gate. Returns true when
 * --gate forces it on, false when --no-gate forces it off, and undefined when
 * neither is given, so the caller applies the default (gate on when the project
 * has a `gate` script). --no-gate wins if both are somehow present, so an
 * explicit opt-out is never overridden.
 */
function gateFlagFromArgs(args: readonly string[]): boolean | undefined {
  if (hasFlag(args, "--no-gate")) {
    return false;
  }
  if (hasFlag(args, "--gate")) {
    return true;
  }
  return undefined;
}

/**
 * Parse the bounded max model-escalation retries from --max-model-retries,
 * defaulting to one (the base attempt, then one escalation retry). A missing,
 * non-finite, or negative value falls back to the default; the value is floored
 * to a whole number of retries.
 */
function maxModelRetriesFromArgs(args: readonly string[], executorDefault?: number): number {
  // The flag wins; otherwise read WORKERS_AI_MAX_MODEL_RETRIES from the env, then
  // fall back to the budget the selected executor carries (e.g. the ai-gateway
  // path's AI_GATEWAY_MAX_MODEL_RETRIES), and finally to 3 bounded rounds.
  // Workers AI is slow on the larger escalation model, so more rounds trade
  // latency for a better chance the fix lands.
  const fallback =
    executorDefault !== undefined && Number.isFinite(executorDefault) && executorDefault >= 0
      ? Math.floor(executorDefault)
      : 3;
  const raw = optionValue(args, "--max-model-retries") ?? runtimeEnv().WORKERS_AI_MAX_MODEL_RETRIES;
  if (raw === undefined) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.floor(n);
}

/**
 * Resolve the goal text for a goal-driven command. Accepts either an inline goal
 * as the first positional argument, or a --goal-file pointing at a text file.
 * Returns undefined when no goal was provided.
 */
async function resolveGoal(args: readonly string[]): Promise<string | undefined> {
  const file = optionValue(args, "--goal-file");
  if (file) {
    return (await readFile(resolve(file), "utf8")).trim();
  }
  const positional = args.find((arg) => !arg.startsWith("--") && !isOptionValue(args, arg));
  if (positional && positional.trim() !== "") {
    return positional.trim();
  }
  return undefined;
}

/** Resolve the required --project directory, or undefined when absent. */
function requireProjectDir(args: readonly string[]): string | undefined {
  const explicit = optionValue(args, "--project");
  return explicit ? resolve(explicit) : undefined;
}

/**
 * Build the opt-in schema-constrained planner injection from the environment.
 * Returns the injection ONLY when a live inference planner is configured
 * (EXECUTOR=ai-gateway with gateway credentials); otherwise returns undefined so
 * decomposeGoal keeps the deterministic heuristic decomposition. The gateway
 * credential is read inside selectPlanner and never printed here. A caller that
 * passed undefined to decomposeGoal is on the offline path, so `make check` and
 * the demo stay deterministic and offline.
 */
function plannerInjectionFromEnv(): PlannerInjection | undefined {
  const selected = selectPlanner();
  if (!selected.live || !selected.plan) {
    return undefined;
  }
  // The Jev typed-decision layer for the plan-review juncture, selected from the
  // same gateway env. When Jev is live, inject its typed caller + threshold so
  // the planner pass asks "does this plan cover the goal?" and escalates on a
  // low-confidence answer. When not live (offline/no gateway), Jev is absent, so
  // the plan-review juncture is skipped and the plan path is unchanged.
  const jev = selectJev();
  return {
    plan: selected.plan,
    baseModel: selected.baseModel,
    ...(selected.escalationModels.length > 0
      ? { escalationModels: selected.escalationModels }
      : {}),
    ...(jev.live && jev.ask ? { jev: jev.ask, jevThreshold: jev.threshold } : {}),
    // Surface WHY each ladder model failed on a live run, so a fall-back to the
    // heuristic reports the specific cause (a transport error or a validatePlan
    // rejection) rather than being silent. The message carries no credential.
    onDiagnostic: (diagnostic) => {
      console.error(
        `planner: model ${diagnostic.model} ${diagnostic.kind}: ${diagnostic.reason}`,
      );
    },
  };
}

/**
 * The live-planner rule shared by every LIVE goal-driven command (run-live,
 * recruit-live): on a live run the LLM is the planner, so without a live gateway
 * planner the command FAILS (returns false after printing the error) unless the
 * operator explicitly passed --allow-heuristic-planner, in which case a loud
 * banner says the heuristic is in use. A hand-authored --change is not
 * decomposed, so it needs no planner. Offline commands never call this.
 */
function enforceLivePlanner(args: readonly string[]): boolean {
  if (optionValue(args, "--change")) {
    return true;
  }
  const decision = decideLivePlanner({
    planner: selectPlanner(),
    allowHeuristic: hasFlag(args, ALLOW_HEURISTIC_PLANNER_FLAG),
  });
  if (decision.kind === "refused") {
    console.error(`Error: ${decision.error}`);
    return false;
  }
  if (decision.kind === "heuristic-allowed") {
    console.error(decision.banner);
  }
  return true;
}

/**
 * Build the opt-in re-plan transport for the change-level ladder from the same
 * gateway env the planner uses. When the schema-constrained planner is live, the
 * returned transport asks it, on a verify-fail, to decide WHICH of the candidate
 * (gated) units should re-run given the failing gate evidence (and the Jev
 * attribution choice when one was recorded), and maps the planner's chosen unit
 * ids back to the subset that intersects the candidates. The ladder re-fans only
 * that subset; an empty or non-intersecting reply makes the ladder fall back to
 * its string-parse + Jev-attribution implicated set. When the planner is not
 * live (offline, no gateway) this returns undefined, so the ladder keeps the
 * deterministic attribution + re-fan-all path and make check stays offline.
 */
function rePlanFromEnv(): RePlanTransport | undefined {
  const selected = selectPlanner();
  if (!selected.live || !selected.plan) {
    return undefined;
  }
  const plan = selected.plan;
  const baseModel = selected.baseModel;
  return async (input) => {
    const candidate = new Set(input.candidateUnitIds);
    const messages = [
      {
        role: "system" as const,
        content: [
          "You revise a failing software change's retry plan.",
          "You are given the failing gate output and the candidate unit ids that could re-run.",
          "Decide WHICH of those candidate units should re-run to fix the failure.",
          "Hard rules you must obey:",
          "- Every unit id you return MUST be one of the candidate unit ids. Never invent an id.",
          "- Return only the units the failing output implicates; drop units the failure does not touch.",
          "- Return the plan object the schema describes; put the units to re-run under units (one per id, with that id and a short objective).",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: [
          `Candidate unit ids: ${input.candidateUnitIds.join(", ")}`,
          input.attributionChoice !== undefined
            ? `A decision model attributed the failure to: ${input.attributionChoice}`
            : "",
          `Retry round: ${input.round}`,
          "",
          "Failing gate output:",
          input.evidence.slice(0, 2000),
        ]
          .filter((line) => line !== "")
          .join("\n"),
      },
    ];
    const proposed = await plan({ model: baseModel, messages });
    // Map the planner's chosen unit ids back to the candidates. A unit id that
    // is not a candidate is dropped (the planner may only re-run gated units).
    const chosen = proposed.units
      .map((unit) => unit.id)
      .filter((id) => candidate.has(id));
    return chosen;
  };
}

/**
 * Resolve a Change for a recruitment command from either a goal (decomposed
 * against a target project) or a hand-authored Change YAML (--change). Returns
 * undefined when neither a goal+project nor a --change file was provided.
 */
async function resolveChange(
  args: readonly string[],
  options: { readonly live?: boolean } = {},
): Promise<Change | undefined> {
  const changeFile = optionValue(args, "--change");
  if (changeFile) {
    const specYaml = await readFile(resolve(changeFile), "utf8");
    return describeChange(specYaml).change;
  }
  const goal = await resolveGoal(args);
  const projectDir = requireProjectDir(args);
  if (goal === undefined || !projectDir) {
    return undefined;
  }
  // Inject the opt-in schema-constrained planner exactly like the decompose and
  // run-goal commands do, so the live run path (run-live) decomposes through the
  // planner when inference is configured. The planner records how the Change was
  // decomposed ON the Change (change.plan), which rides changeToSpecYaml to the
  // Worker so the live graph roots a real planner node. When inference is not
  // configured this returns undefined, so decomposeGoal stays on the
  // deterministic heuristic path and the Change carries no plan (no planner
  // node), keeping make check and the demo offline and deterministic.
  const planner = plannerInjectionFromEnv();
  const decomposition = await decomposeGoal({
    goal,
    projectDir,
    ...(planner ? { planner } : {}),
  });
  // A live run whose gateway planner exhausted its model ladder fell back to the
  // heuristic. That is recorded on the Change (plan.source "heuristic-fallback",
  // which rides the spec to the Worker's planner node); say it loudly here too so
  // the operator cannot miss that no model planned this run.
  if (options.live && decomposition.change.plan?.source === "heuristic-fallback") {
    console.error(plannerFallbackBanner());
  }
  return decomposition.change;
}

/**
 * Parse the min/max concurrency dial from CLI flags, defaulting to a floor of
 * one and a ceiling of three. The dial is the single lever that governs how many
 * agents recruitment runs at once.
 */
function dialFromArgs(args: readonly string[]): ConcurrencyDial {
  const min = Number(optionValue(args, "--min") ?? "1");
  const max = Number(optionValue(args, "--max") ?? "3");
  return {
    minConcurrency: Number.isFinite(min) ? min : 1,
    maxConcurrency: Number.isFinite(max) ? max : 3,
  };
}

/** True when `value` is the argument consumed by a preceding --flag. */
function isOptionValue(args: readonly string[], value: string): boolean {
  const index = args.indexOf(value);
  if (index <= 0) {
    return false;
  }
  const prev = args[index - 1] ?? "";
  return prev.startsWith("--");
}

/**
 * Deploy an example app to a live workers.dev URL by running `wrangler deploy`
 * in the app directory (the M8.0 deploy hop), and return the reachable URL
 * wrangler prints. This is the real live-URL step; offline runs and tests inject
 * a fake deployer instead, so `make check` never calls the network. The scoped
 * Cloudflare token is read by wrangler from the already-sourced environment; this
 * never reads, prints, or forwards it.
 */
async function wranglerDeploy(appDir: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  // A redeploy runs in a temporary checkout of the PROMOTED commit (outside the
  // repo, with no node_modules), so use the repo's own pinned wrangler binary
  // when present rather than letting npx resolve or download one.
  const [cmd, cmdArgs] = await wranglerCommand(["deploy"]);
  const { stdout, stderr } = await run(cmd, cmdArgs, {
    cwd: appDir,
    // wrangler (a trusted tool) needs the Cloudflare credentials in its own
    // environment; they are passed to it explicitly, never held in ours.
    env: wranglerEnv(),
    maxBuffer: 4 * 1024 * 1024,
  });
  const text = `${stdout}\n${stderr}`;
  const match = text.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/);
  if (!match) {
    throw new Error("wrangler deploy did not print a workers.dev URL");
  }
  return match[0];
}

/** wrangler's environment: ours plus exactly the Cloudflare credentials it needs. */
function wranglerEnv(): NodeJS.ProcessEnv {
  const env = runtimeEnv();
  return {
    ...process.env,
    ...(env.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN } : {}),
    ...(env.CLOUDFLARE_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } : {}),
  };
}

/** The commands that read `.env`: they talk to the live Worker, Cloudflare, or the AI Gateway. */
const LIVE_COMMANDS: ReadonlySet<string> = new Set(["env-check", "doctor", "jev-smoke", "tool-smoke", "recruit-live", "run-live", "run-board", "deploy-app", "cleanup-live"]);

/**
 * Load the repo's `.env` (or SCF_ENV_FILE) into memory, never into this
 * process's environment: code the CLI runs (gates, tools) can read a parent's
 * initial environment, so secrets never travel through it.
 */
function loadCredentials(): void {
  const path = process.env.SCF_ENV_FILE ?? resolve(repoRoot(), ".env");
  const values = loadDotEnvFile(path);
  if (values) {
    setRuntimeCredentials(values);
  }
}

/** The wrangler invocation: the repo's installed binary, else npx. */
async function wranglerCommand(
  args: readonly string[],
): Promise<[string, string[]]> {
  const { access } = await import("node:fs/promises");
  const bin = resolve(repoRoot(), "node_modules", ".bin", "wrangler");
  try {
    await access(bin);
    return [bin, [...args]];
  } catch {
    return ["npx", ["wrangler", ...args]];
  }
}

/**
 * Tear a deployed example app down with `wrangler delete` in the app directory,
 * so a real-app run never leaves a billable Worker behind. Best-effort: a worker
 * already gone is not an error.
 */
async function wranglerDelete(appDir: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await run("npx", ["wrangler", "delete"], {
    cwd: appDir,
    env: wranglerEnv(),
    maxBuffer: 4 * 1024 * 1024,
  }).catch(() => {
    /* best-effort teardown; the Makefile delete-app is the authoritative path */
  });
}
async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  // The credential names in this process's INITIAL environment (what any
  // same-user process can read), taken before anything is loaded.
  const exposed = initialEnvironmentCredentialKeys();
  // Only the live commands read .env (the targets that used to source it); the
  // offline ones (run, run-goal, decompose, recruit, run-board --offline, ...)
  // never see a credential or a live executor setting.
  if (LIVE_COMMANDS.has(args[0] ?? "") && !(args[0] === "run-board" && args.includes("--offline"))) {
    loadCredentials();
  }
  if (exposed.length > 0 && args[0] !== "env-check") {
    console.error(
      `Warning: credential(s) in this process's environment (${exposed.join(", ")}): code this CLI runs could read them from it. ` +
        "Put them in .env instead (the CLI reads it into memory) and do not export them into the CLI's environment.",
    );
  }
  if (args[0] === "env-check") {
    // Names only, never values.
    console.log(`credential names in this process's environment: ${exposed.length > 0 ? exposed.join(", ") : "none"}`);
    console.log(`names loaded into memory from .env (values never shown): ${runtimeCredentialNames().join(", ") || "none"}`);
    return exposed.length > 0 ? 1 : 0;
  }

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    printHelp();
    return 0;
  }

  if (args[0] === "-v" || args[0] === "--version") {
    console.log(VERSION);
    return 0;
  }

  const name = args[0] ?? "";
  const command = commandMap.get(name);
  if (!command) {
    console.error(`Unknown command: ${name}`);
    console.error(`Run \`${CLI_NAME} --help\` to see available commands.`);
    return 1;
  }

  const rest = args.slice(1);
  if (rest[0] === "-h" || rest[0] === "--help") {
    console.log(`Usage: ${command.usage}`);
    console.log(command.summary);
    return 0;
  }

  try {
    return await command.run(rest);
  } catch (error) {
    console.error(`Error: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    if (process.env.SCF_DEBUG && error instanceof Error && error.stack) {
      console.error(redactSecrets(error.stack));
    }
    return 1;
  }
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(redactSecrets(String(error instanceof Error ? (error.stack ?? error.message) : error)));
    process.exit(1);
  });

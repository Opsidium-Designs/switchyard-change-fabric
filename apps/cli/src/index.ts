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
  changeToSpecYaml,
  cleanupLive,
  clearAppDeployment,
  decomposeGoal,
  describeChange,
  formatChangePlan,
  formatDecomposition,
  formatDoctorReport,
  formatRecruitmentSummary,
  formatRunSummary,
  buildAppGateWiring,
  projectHasGateScript,
  readAppDeployment,
  recordAppDeployment,
  runChange,
  runDoctor,
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
  type TeardownApp,
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
    usage: `${CLI_NAME} run <change.yaml> [--project <dir>]`,
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
    usage: `${CLI_NAME} run-goal "<goal>" --project <dir>  |  ${CLI_NAME} run-goal --goal-file <file> --project <dir>`,
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
    usage: `${CLI_NAME} recruit-live "<goal>" --project <dir> --worker <url> [--min N] [--max N]`,
    async run(args) {
      const change = await resolveChange(args);
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
    usage: `${CLI_NAME} run-live "<goal>" --project <dir> --worker <url> [--min N] [--max N] [--owner <unitId>] [--id <changeId>] [--watch] [--await-escalation] [--gate|--no-gate] [--max-model-retries N]`,
    async run(args) {
      const change = await resolveChange(args);
      if (!change) {
        console.error(
          `Usage: ${CLI_NAME} run-live "<goal text>" --project <dir> --worker <url> [--min N] [--max N] [--owner <unitId>]\n` +
            `   or: ${CLI_NAME} run-live --change <change.yaml> --project <dir> --worker <url> [--min N] [--max N]`,
        );
        return 1;
      }
      const projectDir = requireProjectDir(args);
      if (!projectDir) {
        console.error("A target project is required: pass --project <dir>.");
        return 1;
      }
      const workerUrl = optionValue(args, "--worker") ?? "http://127.0.0.1:8787";
      const dial = dialFromArgs(args);

      // Watch mode: leave the real Artifact repos and the Change state in place
      // after the run so a human can watch the finished graph morph in the
      // console, and use a STABLE, predictable Change id (not a per-run Date.now
      // id) so the console can auto-load it without the human hand-typing it.
      // A normal (non-watch) run keeps the unique per-run id and cleans up.
      const watch = hasFlag(args, "--watch") || hasFlag(args, "--no-cleanup");

      // Select the executor from the environment (.env). workers-ai is the live
      // inference path; anything else is the deterministic noop. The credential
      // is read inside selectExecutor and never printed here.
      let selected;
      try {
        selected = selectExecutor();
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
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
      // id is used verbatim.
      const explicitId = optionValue(args, "--id");
      const runId = Date.now().toString(36);
      const liveChange: Change = explicitId
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
      } else {
        console.log("  per-app gate: OFF (no gate script for this project, or --no-gate)");
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
            case "verifying":
              console.log("Verifying and integrating (mechanical ground truth)...");
              break;
            case "promoting":
              console.log(`Promoting to local Git branch ${event.branch}...`);
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
      console.log(`  verification: ${result.evidence.integration.verdict}`);
      if (result.promotion.committed) {
        console.log(
          `  promoted: ${result.promotion.branch} (${result.promotion.commit.slice(0, 10)}) in ${result.sourceRepoDir}`,
        );
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
      return result.promotion.committed && result.completed.length === change.work.length ? 0 : 1;
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
    usage: `${CLI_NAME} promote <change.yaml> [--project <dir>]`,
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
  const raw = optionValue(args, "--max-model-retries") ?? process.env.WORKERS_AI_MAX_MODEL_RETRIES;
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
  };
}

/**
 * Resolve a Change for a recruitment command from either a goal (decomposed
 * against a target project) or a hand-authored Change YAML (--change). Returns
 * undefined when neither a goal+project nor a --change file was provided.
 */
async function resolveChange(args: readonly string[]): Promise<Change | undefined> {
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
  const { stdout, stderr } = await run("npx", ["wrangler", "deploy"], {
    cwd: appDir,
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  const text = `${stdout}\n${stderr}`;
  const match = text.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/);
  if (!match) {
    throw new Error("wrangler deploy did not print a workers.dev URL");
  }
  return match[0];
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
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  }).catch(() => {
    /* best-effort teardown; the Makefile delete-app is the authoritative path */
  });
}
async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

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
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.SCF_DEBUG && error instanceof Error) {
      console.error(error.stack);
    }
    return 1;
  }
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

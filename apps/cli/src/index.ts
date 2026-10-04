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

import {
  changeToSpecYaml,
  decomposeGoal,
  describeChange,
  formatChangePlan,
  formatDecomposition,
  formatDoctorReport,
  formatRunSummary,
  runChange,
  runDoctor,
} from "@switchyard-change/orchestration";

const CLI_NAME = "switchyard-change";
const VERSION = "0.0.0";

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
      const result = await decomposeGoal({ goal, projectDir });
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
      const decomposition = await decomposeGoal({ goal, projectDir });
      console.log(formatDecomposition(decomposition));
      console.log("");
      console.log("Running the decomposed WorkGraph to completion offline...");
      console.log("");
      const result = await runChange({
        specYaml: changeToSpecYaml(decomposition.change),
        projectDir,
      });
      console.log(formatRunSummary(result));
      return result.promotion.committed ? 0 : 1;
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

/** True when `value` is the argument consumed by a preceding --flag. */
function isOptionValue(args: readonly string[], value: string): boolean {
  const index = args.indexOf(value);
  if (index <= 0) {
    return false;
  }
  const prev = args[index - 1] ?? "";
  return prev.startsWith("--");
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
    return 1;
  }
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

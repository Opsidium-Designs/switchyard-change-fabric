#!/usr/bin/env node
/**
 * `switchyard-change` CLI shell.
 *
 * M0 scope: a command parser with stub subcommands that print placeholders.
 * The real behavior (talking to the local Worker control API, issuing
 * Change/WorkUnit operations) arrives in later milestones.
 */

const CLI_NAME = "switchyard-change";
const VERSION = "0.0.0";

interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  run(args: string[]): void;
}

function placeholder(message: string): void {
  console.log(message);
  console.log("(stub — not yet implemented in this milestone)");
}

const commands: Command[] = [
  {
    name: "doctor",
    summary: "Check local prerequisites (Node, Git, wrangler, Cloudflare auth).",
    usage: `${CLI_NAME} doctor`,
    run() {
      placeholder("Would check: Node.js, Git, wrangler, Cloudflare login, inference path.");
    },
  },
  {
    name: "init",
    summary: "Initialize a source project for Change coordination.",
    usage: `${CLI_NAME} init <path-to-project>`,
    run(args) {
      const target = args[0] ?? "<path-to-project>";
      placeholder(`Would initialize Change coordination for project at: ${target}`);
    },
  },
  {
    name: "dev",
    summary: "Start the local development environment (wrangler dev + console + runner).",
    usage: `${CLI_NAME} dev`,
    run() {
      placeholder("Would start wrangler dev, the console, and the local runner pool.");
    },
  },
  {
    name: "run",
    summary: "Run a Change from a declarative specification file.",
    usage: `${CLI_NAME} run <change.yaml>`,
    run(args) {
      const spec = args[0] ?? "<change.yaml>";
      placeholder(`Would create and execute the Change defined in: ${spec}`);
    },
  },
  {
    name: "status",
    summary: "Show the state of a Change and its WorkUnits.",
    usage: `${CLI_NAME} status [change-id]`,
    run(args) {
      const changeId = args[0] ?? "<active-change>";
      placeholder(`Would report WorkUnit/workspace/verification state for: ${changeId}`);
    },
  },
  {
    name: "promote",
    summary: "Promote a verified Change back into local Git.",
    usage: `${CLI_NAME} promote <change-id>`,
    run(args) {
      const changeId = args[0] ?? "<change-id>";
      placeholder(`Would promote verified Change to local Git: ${changeId}`);
    },
  },
];

const commandMap = new Map(commands.map((c) => [c.name, c]));

function printHelp(): void {
  console.log(`${CLI_NAME} v${VERSION} — agent-native change coordination (spike)\n`);
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

function main(argv: string[]): number {
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

  command.run(rest);
  return 0;
}

process.exit(main(process.argv));

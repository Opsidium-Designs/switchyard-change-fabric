/**
 * A fake local model CLI for offline tests: a small Node script written to a
 * temp dir that records how it was invoked (argv, cwd and its entries, env,
 * stdin, pid) and answers with canned output. No real CLI and no network.
 */

import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One canned answer. `hang` never exits (and starts a grandchild that never exits). */
export interface FakeAnswer {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit?: number;
  readonly hang?: boolean;
}

/** What the fake answers: model calls take `calls` in order (the last repeats). */
export interface FakeScenario {
  readonly calls?: readonly FakeAnswer[];
  readonly version?: FakeAnswer;
  readonly auth?: FakeAnswer;
}

/** One recorded invocation. */
export interface FakeCall {
  readonly argv: string[];
  readonly cwd: string;
  readonly cwdEntries: string[];
  readonly env: Record<string, string>;
  readonly stdin: string;
  readonly pid: number;
  readonly grandchild?: number;
}

export interface FakeCli {
  readonly bin: string;
  readonly dir: string;
  set(scenario: FakeScenario): Promise<void>;
  calls(): Promise<FakeCall[]>;
}

/** A Claude-shaped success result line. */
export function claudeResult(fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    result: "",
    stop_reason: "end_turn",
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
    total_cost_usd: 0.01,
    session_id: "s",
    ...fields,
  })}\n`;
}

export async function makeFakeCli(): Promise<FakeCli> {
  const dir = await mkdtemp(join(tmpdir(), "scf-fake-cli-"));
  const bin = join(dir, "fake-claude.cjs");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const dir = ${JSON.stringify(dir)};
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  const sc = JSON.parse(fs.readFileSync(path.join(dir, "scenario.json"), "utf8"));
  const argv = process.argv.slice(2);
  let answer;
  if (argv.includes("--version")) {
    answer = sc.version || { stdout: "2.1.295 (Claude Code)\\n" };
  } else if (argv[0] === "auth") {
    answer = sc.auth || { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com" }) };
  } else {
    const counter = path.join(dir, "counter");
    const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
    fs.writeFileSync(counter, String(n + 1));
    const list = sc.calls || [];
    answer = list[Math.min(n, list.length - 1)] || {};
  }
  let grandchild;
  if (answer.hang) {
    const g = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    grandchild = g.pid;
  }
  const rec = { argv, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), env: process.env, stdin: input, pid: process.pid, grandchild };
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(rec) + "\\n");
  if (answer.hang) { setInterval(() => {}, 1000); return; }
  if (answer.stderr) process.stderr.write(answer.stderr);
  process.stdout.write(answer.stdout || "");
  process.exitCode = answer.exit || 0;
});
`;
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  await writeFile(join(dir, "scenario.json"), "{}", "utf8");
  return {
    bin,
    dir,
    async set(scenario) {
      await writeFile(join(dir, "scenario.json"), JSON.stringify(scenario), "utf8");
      await writeFile(join(dir, "counter"), "0", "utf8");
    },
    async calls() {
      let text = "";
      try {
        text = await readFile(join(dir, "calls.jsonl"), "utf8");
      } catch {
        return [];
      }
      return text
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as FakeCall);
    },
  };
}

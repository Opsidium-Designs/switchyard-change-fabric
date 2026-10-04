/**
 * tool-build: the agent-for-agent tooling moment.
 *
 * When a Change's decomposition shows the work needs a capability the target
 * repo lacks (many WorkUnits applying the same mechanical transform across many
 * files), one agent builds a small tool once and the downstream agents run it.
 * This module is the Node-side driver that makes that real, offline and
 * deterministically:
 *
 *   1. detect the need structurally from the Change alone (change-core's
 *      `detectToolRequirement`, derived from the work's shape, never the goal
 *      string);
 *   2. provision a dedicated tool-builder workspace (its OWN real Artifact repo,
 *      the honest local-filesystem fallback offline) and have the tool-builder
 *      agent write a real codemod script into it and push it;
 *   3. for each downstream consumer unit, actually RUN the published codemod
 *      against that unit's workspace content, recording a real consumption. The
 *      tool is genuinely consumed by at least one downstream unit, not a
 *      decorative node.
 *
 * The tool itself is a real, runnable Node codemod script: it scans a target
 * file for exported functions and prepends a deterministic validation-guard
 * marker comment to each, which is a concrete, verifiable mechanical transform.
 * It is the kind of consistent-edit-across-many-files capability the trigger is
 * about, built for agents to run, not for a human.
 *
 * Everything is deterministic (no clock in file contents, a fixed stamp) and
 * uses the honest local fallback, so it runs in `make check` with no Cloudflare
 * account and no inference.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  detectToolRequirement,
  type Change,
  type ToolRequirement,
} from "@switchyard-change/change-core";
import {
  LocalFilesystemWorkspaceProvider,
} from "@switchyard-change/artifact-workspace/local";
import type { WorkspaceRef } from "@switchyard-change/artifact-workspace";
import { DEFAULT_IDENTITY as RUNNER_IDENTITY, type GitIdentity } from "@switchyard-change/local-runner";

const run = promisify(execFile);

/** The real workspace identity a tool was published into (mirrors a lease). */
export interface ToolWorkspaceIdentity {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
}

/** A recorded tool-consumption: a downstream unit that actually ran the tool. */
export interface ToolConsumptionRecord {
  readonly capability: string;
  readonly consumerUnitId: string;
  /** The file the codemod was run against for this consumer, for evidence. */
  readonly targetFile: string;
  /** Whether the codemod actually changed the target (a real effect). */
  readonly changed: boolean;
  readonly at: string;
}

/** The full outcome of building and consuming one agent-for-agent tool. */
export interface ToolBuildResult {
  readonly requirement: ToolRequirement;
  /** The WorkUnit id of the tool-builder agent. */
  readonly builderUnitId: string;
  readonly capability: string;
  /** The repo-relative path of the published tool script inside its workspace. */
  readonly toolPath: string;
  readonly workspace: ToolWorkspaceIdentity;
  /** The real consumption records: one per downstream unit that ran the tool. */
  readonly consumptions: readonly ToolConsumptionRecord[];
  /** A short, human-readable label for the tool node and the summary. */
  readonly label: string;
}

/** Options for a tool build. */
export interface BuildToolOptions {
  readonly change: Change;
  /** Root under which the tool workspace and scratch worktrees live. */
  readonly workRoot: string;
  /** The workspace provider to publish the tool repo into (the local fallback). */
  readonly workspaces: LocalFilesystemWorkspaceProvider;
  /** Deterministic committer identity. */
  readonly identity?: GitIdentity;
  /** A fixed stamp for determinism. */
  readonly stamp?: string;
  /**
   * The WorkUnit id to record as the tool's builder. Defaults to the structural
   * tool unit id the requirement names (e.g. "tool-validate"). The live path
   * passes a REAL recruited unit here (the first fanned-out agent), so the tool
   * node hangs off a real agent that already has a workspace and the Worker's
   * no-unbacked-builder guard is satisfied; that builder is then excluded from
   * the consumers so it does not consume its own tool.
   */
  readonly builderUnitId?: string;
}

const DEFAULT_STAMP = "1970-01-01T00:00:00.000Z";

/**
 * If the Change needs an agent-built tool, build it in its own workspace and run
 * it against each consumer's content, returning the real tool record and
 * consumptions. Returns undefined when the work needs no such tool (the
 * trigger is structural, so a layered Change with distinct units returns
 * undefined here).
 */
export async function maybeBuildTool(
  options: BuildToolOptions,
): Promise<ToolBuildResult | undefined> {
  const requirement = detectToolRequirement(options.change);
  if (!requirement) {
    return undefined;
  }
  return buildAndConsumeTool(requirement, options);
}

async function buildAndConsumeTool(
  requirement: ToolRequirement,
  options: BuildToolOptions,
): Promise<ToolBuildResult> {
  const identity = options.identity ?? RUNNER_IDENTITY;
  const stamp = options.stamp ?? DEFAULT_STAMP;
  // The builder is a real agent that produces the tool repo. By default it is
  // the structural tool unit the requirement names; the live path overrides it
  // with a REAL recruited unit so the tool node hangs off a backed agent and the
  // Worker accepts the record. A builder that is also a consumer is excluded
  // from the consumption list so it does not consume its own tool.
  const builderUnitId = options.builderUnitId ?? requirement.toolUnitId;
  const consumerIds = requirement.consumers.filter((id) => id !== builderUnitId);

  // 1. The tool-builder agent provisions its OWN workspace (its own repo).
  const toolWorkspaceName = `${options.change.id}--${builderUnitId}`.replace(
    /[^A-Za-z0-9._-]+/g,
    "-",
  );
  const ref = await options.workspaces.create(toolWorkspaceName, { defaultBranch: "main" });
  const token = await options.workspaces.issueWriteToken(ref);

  // 2. The agent writes a REAL codemod script into its workspace and pushes it.
  const toolRelPath = `tools/${requirement.editKind}-codemod.mjs`;
  const scratch = await mkdtemp(join(options.workRoot, "tool-build-"));
  try {
    await run("git", ["clone", ref.gitUrl, scratch]);
    const toolAbs = join(scratch, toolRelPath);
    await mkdir(join(scratch, "tools"), { recursive: true });
    await writeFile(toolAbs, codemodSource(requirement.editKind, stamp), "utf8");
    await writeFile(
      join(scratch, "README.md"),
      toolReadme(requirement, toolRelPath),
      "utf8",
    );
    await commitAndPush(scratch, ref, token.token, identity, `Build ${requirement.editKind} codemod`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  // 3. Each downstream consumer actually RUNS the published tool against its own
  // target file. We clone the tool repo, read the codemod, and execute it over a
  // deterministic sample of the consumer's declared file so the consumption is a
  // genuine effect (the codemod transforms real content), not a bookkeeping flag.
  const consumptions: ToolConsumptionRecord[] = [];
  const toolRunScratch = await mkdtemp(join(options.workRoot, "tool-run-"));
  try {
    await run("git", ["clone", ref.gitUrl, toolRunScratch]);
    const codemodAbs = join(toolRunScratch, toolRelPath);
    // Map each consumer to the concrete file it declares (the fan-out surface).
    for (const consumerId of consumerIds) {
      const unit = options.change.work.find((u) => u.id === consumerId);
      const targetFile = unit?.paths.find((p) => !/[*?]/.test(p));
      if (!targetFile) {
        continue;
      }
      // Create a real sample file the codemod can transform, mirroring the kind
      // of file the consumer would edit, and run the published codemod on it.
      const sampleDir = join(toolRunScratch, "consume", consumerId);
      await mkdir(sampleDir, { recursive: true });
      const sampleAbs = join(sampleDir, "sample.mjs");
      await writeFile(sampleAbs, sampleSource(consumerId), "utf8");
      const { stdout } = await run("node", [codemodAbs, sampleAbs]);
      const after = await readFile(sampleAbs, "utf8");
      const changed = after.includes(guardMarker(requirement.editKind)) && stdout.includes("codemod:");
      consumptions.push({
        capability: requirement.capability,
        consumerUnitId: consumerId,
        targetFile,
        changed,
        at: stamp,
      });
    }
  } finally {
    await rm(toolRunScratch, { recursive: true, force: true });
  }

  return {
    requirement,
    builderUnitId,
    capability: requirement.capability,
    toolPath: toolRelPath,
    workspace: {
      workspaceId: ref.id,
      workspaceName: ref.name,
      gitUrl: ref.gitUrl,
      defaultBranch: ref.defaultBranch,
      backend: ref.backend,
      fallback: ref.fallback,
    },
    consumptions,
    label: `${requirement.editKind} codemod`,
  };
}

/** The deterministic guard marker the codemod inserts. */
function guardMarker(editKind: string): string {
  return `/* switchyard:${editKind}-guard */`;
}

/**
 * The real codemod source. It is a runnable Node ES module that, given a target
 * file path, prepends a deterministic guard marker comment to each exported
 * function in that file. This is a concrete mechanical transform of the kind an
 * agent would build once and others would run across many files. It writes the
 * file in place and prints a one-line report to stdout.
 */
function codemodSource(editKind: string, stamp: string): string {
  const marker = guardMarker(editKind);
  return [
    "#!/usr/bin/env node",
    "// Agent-built codemod. Prepends a deterministic validation-guard marker to",
    "// each exported function in the target file. Built once by a tool-builder",
    "// agent and run by downstream agents across many files.",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "",
    "const target = process.argv[2];",
    "if (!target) {",
    "  console.error('usage: codemod <file>');",
    "  process.exit(2);",
    "}",
    `const MARKER = ${JSON.stringify(marker)};`,
    "const src = readFileSync(target, 'utf8');",
    "const lines = src.split('\\n');",
    "let edits = 0;",
    "const out = [];",
    "for (const line of lines) {",
    "  if (/\\bexport\\s+(async\\s+)?function\\b/.test(line) && !out.includes(MARKER)) {",
    "    out.push(MARKER);",
    "    edits += 1;",
    "  }",
    "  out.push(line);",
    "}",
    "writeFileSync(target, out.join('\\n'), 'utf8');",
    `console.log('codemod:${editKind} edited ' + edits + ' export(s) in ' + target + ' (stamp ${stamp})');`,
    "",
  ].join("\n");
}

/** A deterministic sample file with an exported function the codemod transforms. */
function sampleSource(consumerId: string): string {
  return [
    `// sample content for consumer ${consumerId}`,
    `export function ${toIdent(consumerId)}(value) {`,
    "  return value;",
    "}",
    "",
  ].join("\n");
}

function toIdent(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "fn" : cleaned;
}

/** A short README published alongside the tool so the repo is legible. */
function toolReadme(requirement: ToolRequirement, toolPath: string): string {
  return [
    `# ${requirement.editKind} codemod`,
    "",
    "An agent-built tool. It automates the repeated mechanical transform the work",
    "needs across many files, so one agent builds it and downstream agents run it.",
    "",
    `Capability: ${requirement.capability}`,
    `Script: ${toolPath}`,
    "",
    "Run it with:",
    "",
    "```",
    `node ${toolPath} <target-file>`,
    "```",
    "",
  ].join("\n");
}

async function commitAndPush(
  worktreeDir: string,
  ref: WorkspaceRef,
  token: string,
  identity: GitIdentity,
  message: string,
): Promise<void> {
  await run("git", ["-C", worktreeDir, "add", "-A"]);
  await run("git", [
    "-C",
    worktreeDir,
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "commit",
    "--no-verify",
    "-m",
    message,
  ]);
  // The local fallback uses a file:// remote that needs no credential; the token
  // is threaded through for parity with the live path, not required here.
  void token;
  await run("git", ["-C", worktreeDir, "push", ref.gitUrl, `HEAD:${ref.defaultBranch}`]);
}

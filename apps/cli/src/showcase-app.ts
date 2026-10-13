/**
 * `switchyard-change showcase-app`: publish an example app's ORIGINAL code and
 * the code FIXED by a recorded run on the app's showcase Worker
 * (`switchyard-showcase-<app>`) under the `before` and `after-<run>-r<n>`
 * preview aliases, and record both links on the run in the replay index
 * (apps/console/public/replays/index.json) for the static replay page.
 *
 * The work (checks, honesty proof, temp copies, commands, the index update)
 * is `runShowcaseApp` in the orchestration package; this file only parses the
 * flags and supplies the real wrangler runner. Credentials come from the
 * in-memory .env and go to wrangler only; they are never printed.
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { redactSecrets, runShowcaseApp, runtimeEnv } from "@switchyard-change/orchestration";

const exec = promisify(execFile);

/** What the CLI's command table needs (the same shape as index.ts's Command). */
export interface ShowcaseAppCommand {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  run(args: string[]): Promise<number>;
}

export interface ShowcaseAppDeps {
  readonly cliName: string;
  readonly repoRoot: () => string;
  /** The wrangler invocation (the repo's pinned binary, else npx). */
  readonly wranglerCommand: (args: readonly string[]) => Promise<[string, string[]]>;
  /** wrangler's environment: ours plus exactly the Cloudflare credentials it needs. */
  readonly wranglerEnv: () => NodeJS.ProcessEnv;
  readonly optionValue: (args: readonly string[], flag: string) => string | undefined;
  readonly optionValues: (args: readonly string[], flag: string) => string[];
  readonly hasFlag: (args: readonly string[], flag: string) => boolean;
}

/** Remove the Cloudflare credential values (and any token-like text) from wrangler's output. */
function scrub(text: string): string {
  const env = runtimeEnv();
  let out = text;
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    const value = env[key];
    if (value !== undefined && value.length >= 6) {
      out = out.split(value).join(`<${key}>`);
    }
  }
  return redactSecrets(out);
}

export function showcaseAppCommand(deps: ShowcaseAppDeps): ShowcaseAppCommand {
  const usage = `${deps.cliName} showcase-app --app <app> (--fixed <git dir or bundle>[@ref] --run <replay id> | --before-only [--run <replay id> ...]) [--replays <dir>] [--dry-run]`;
  return {
    name: "showcase-app",
    summary: "Publish an example app's original and run-fixed code side by side (preview aliases) and record the links on the replay page.",
    usage,
    async run(args) {
      const app = deps.optionValue(args, "--app");
      if (app === undefined) {
        console.error(`Usage: ${usage}`);
        return 1;
      }
      const fixed = deps.optionValue(args, "--fixed");
      const runs = deps.optionValues(args, "--run");
      const replaysDir = deps.optionValue(args, "--replays") ?? resolve(deps.repoRoot(), "apps/console/public/replays");
      const dryRun = deps.hasFlag(args, "--dry-run");
      const beforeOnly = deps.hasFlag(args, "--before-only");
      try {
        const result = await runShowcaseApp({
          repoRoot: deps.repoRoot(),
          app,
          ...(fixed !== undefined ? { fixed } : {}),
          runs,
          beforeOnly,
          dryRun,
          replaysDir: resolve(replaysDir),
          log: (line) => console.log(scrub(line)),
          wrangler: async (wranglerArgs, cwd) => {
            const [cmd, cmdArgs] = await deps.wranglerCommand(wranglerArgs);
            try {
              const { stdout, stderr } = await exec(cmd, cmdArgs, { cwd, env: deps.wranglerEnv(), maxBuffer: 4 * 1024 * 1024 });
              return `${stdout}\n${stderr}`;
            } catch (error) {
              const out = error as { stdout?: string; stderr?: string; message?: string };
              const detail = `${out.stderr ?? ""}\n${out.stdout ?? ""}`.trim() || out.message || String(error);
              throw new Error(scrub(detail.split("\n").slice(-12).join("\n")));
            }
          },
        });
        if (dryRun) {
          console.log("Dry run: nothing was uploaded and nothing was written.");
        } else {
          console.log(`Done: ${result.worker}. The links are public workers.dev URLs; remove them with make showcase-down APP=${app}.`);
        }
        return 0;
      } catch (error) {
        console.error(`Error: ${scrub(error instanceof Error ? error.message : String(error))}`);
        return 1;
      }
    },
  };
}

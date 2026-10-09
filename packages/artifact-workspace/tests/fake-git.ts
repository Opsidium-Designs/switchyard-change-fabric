/**
 * Test support: a recording `git` wrapper on PATH (no network).
 */

import { join } from "node:path";

/** A `git` wrapper put first on PATH: it records every invocation, then runs the real git. */
export interface RecordingGit {
  /** Every recorded invocation: its argv and the git-relevant part of its environment. */
  calls(): Promise<readonly { readonly argv: string; readonly env: readonly string[] }[]>;
  /** Put PATH back. */
  restore(): void;
}

/**
 * Install a recording `git` wrapper on PATH for this test file. `redirect`
 * maps a remote URL prefix (for example `https://artifacts.example/`) to a
 * local `file://` prefix, added as command-line-level config, so an https
 * remote resolves to a local bare repo with no network.
 */
export async function installRecordingGit(
  dir: string,
  redirect: Readonly<Record<string, string>> = {},
): Promise<RecordingGit> {
  const { execFileSync } = await import("node:child_process");
  const { chmod, mkdir: mkdirp, readFile, writeFile: write } = await import("node:fs/promises");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(dir, "fake-git-bin");
  const log = join(dir, "fake-git.log");
  await mkdirp(bin, { recursive: true });
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const lines = [
    "#!/bin/sh",
    `{ printf 'ARGV'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n';`,
    `  env | grep -E '^(HOME|XDG_CONFIG_HOME|GIT_CONFIG_GLOBAL|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_[0-9]+)=' | sed 's/^/ENV /'; printf 'END\\n'; } >> ${q(log)}`,
    'n=${GIT_CONFIG_COUNT:-0}',
  ];
  for (const [from, to] of Object.entries(redirect)) {
    lines.push(`eval "export GIT_CONFIG_KEY_$n=${q(`url.${to}.insteadOf`)}"`);
    lines.push(`eval "export GIT_CONFIG_VALUE_$n=${q(from)}"`);
    lines.push("n=$((n+1))");
  }
  lines.push("export GIT_CONFIG_COUNT=$n", `exec ${q(real)} "$@"`, "");
  await write(join(bin, "git"), lines.join("\n"));
  await chmod(join(bin, "git"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved ?? ""}`;
  return {
    async calls() {
      const text = await readFile(log, "utf8").catch(() => "");
      return text
        .split("END\n")
        .filter((block) => block.startsWith("ARGV"))
        .map((block) => {
          const [argv = "", ...env] = block.split("\n").filter((l) => l !== "");
          return { argv, env: env.map((l) => l.replace(/^ENV /, "")) };
        });
    },
    restore() {
      process.env.PATH = saved;
    },
  };
}

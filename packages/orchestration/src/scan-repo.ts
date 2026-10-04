/**
 * scan-repo: read a target project directory into a flat list of RepoFile for
 * the decomposer.
 *
 * The decomposer in change-core is pure and consumes a file list (or a prebuilt
 * snapshot), so the one piece that touches the file system lives here on the
 * Node side. The walk is deterministic (sorted, with build and VCS directories
 * skipped) so the same project directory always yields the same decomposition.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { buildRepoSnapshot, type RepoFile, type RepoSnapshot } from "@switchyard-change/change-core";

/** Directories never worth scanning for a code-change decomposition. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".wrangler",
]);

const TS_SOURCE_PATTERN = /\.[cm]?tsx?$/i;

/** Read a project directory into a sorted list of TypeScript RepoFile entries. */
export async function scanRepoFiles(projectDir: string): Promise<RepoFile[]> {
  const files: RepoFile[] = [];
  await walk(projectDir, projectDir, files);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/** Read a project directory directly into a structural RepoSnapshot. */
export async function scanRepoSnapshot(projectDir: string): Promise<RepoSnapshot> {
  return buildRepoSnapshot(await scanRepoFiles(projectDir));
}

async function walk(root: string, dir: string, out: RepoFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") {
      // Skip dotfiles and dot-directories (e.g. .git, .wrangler) for determinism.
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walk(root, join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile() || !TS_SOURCE_PATTERN.test(entry.name)) {
      continue;
    }
    const abs = join(dir, entry.name);
    const info = await stat(abs);
    if (!info.isFile()) {
      continue;
    }
    const content = await readFile(abs, "utf8");
    out.push({ path: toPosix(relative(root, abs)), content });
  }
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

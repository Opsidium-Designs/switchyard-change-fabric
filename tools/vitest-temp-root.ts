/**
 * Vitest global setup shared by every workspace: one private temp root per
 * test run, removed when the run ends.
 *
 * The tests create their work roots with `mkdtemp(join(tmpdir(), "scf-..."))`
 * (and so do the code paths they exercise: git homes, gate temp dirs, default
 * run work roots). Pointing TMPDIR at a fresh run root before the test workers
 * start puts every one of those inside it, child processes (git, npm) included,
 * and the teardown removes the whole root, so `make check` leaves nothing in
 * the system temp directory. Set SCF_KEEP_TEST_TMP=1 to keep the root for
 * debugging; its path is printed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default async function setup(): Promise<() => Promise<void>> {
  const previous = process.env.TMPDIR;
  const root = await mkdtemp(join(tmpdir(), "scf-test-run-"));
  process.env.TMPDIR = root;
  return async () => {
    if (previous === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previous;
    }
    if (process.env.SCF_KEEP_TEST_TMP === "1") {
      console.log(`test temp root kept: ${root}`);
      return;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  };
}

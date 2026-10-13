/**
 * Export a recorded board run for the static replay page.
 *
 *   node --experimental-transform-types apps/console/scripts/export-replay.ts \
 *     --id <changeId> [--worker http://127.0.0.1:8787] \
 *     [--from-file raw.json] [--title "..."] [--app service-api] [--description "..."]
 *     [--out-dir apps/console/public/replays] [--env-file .env] [--simulated]
 *
 * It pages the board log (GET /changes/:id/board?after=) and the snapshot
 * (GET /changes/:id) from a Worker, or reads a saved raw export
 * ({changeId, messages, snapshot}) with --from-file, scrubs local absolute
 * paths, REFUSES to write when anything token-like (or the value of any env var
 * whose name contains TOKEN, SECRET, KEY, or ACCOUNT) remains, writes
 * apps/console/public/replays/<id>.json, and upserts the run in
 * apps/console/public/replays/index.json. The board GET is open, so no
 * credential is sent; the repo's .env is read into memory only to check the
 * replay holds none of its values. `make export-replay ID=<changeId>` runs this.
 *
 * --simulated marks a run whose agents were scripted (an offline run on the real
 * engine, `run-board --offline --board-out <file>`): the file and its index
 * entry carry `simulated: true`, and the page labels it SIMULATED everywhere.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SIMULATED_NOTE,
  buildReplayFile,
  describeReplay,
  labelSimulated,
  fetchBoardLog,
  fetchSnapshot,
  parseDotEnv,
  recordedOutcome,
  ReplayRefused,
  upsertIndex,
  type ReplayIndex,
} from "./replay-export.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const defaultOut = resolve(here, "../public/replays");

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(["--simulated"]);

function parseArgs(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    if (BOOLEAN_FLAGS.has(arg)) {
      out.set(arg.slice(2), "true");
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    out.set(arg.slice(2), value);
    i += 1;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fromFile = args.get("from-file");
  const worker = args.get("worker") ?? "http://127.0.0.1:8787";
  const outDir = resolve(args.get("out-dir") ?? defaultOut);

  let raw: { changeId: string; messages: never[]; snapshot: unknown };
  if (fromFile !== undefined) {
    raw = JSON.parse(readFileSync(fromFile, "utf8")) as typeof raw;
  } else {
    const id = args.get("id");
    if (id === undefined) throw new Error("--id <changeId> is required (or --from-file)");
    const messages = await fetchBoardLog(fetch, worker, id);
    const snapshot = await fetchSnapshot(fetch, worker, id);
    raw = { changeId: id, messages: messages as never[], snapshot };
  }
  // --id renames a saved export (its file name and index id).
  const changeId = args.get("id") ?? raw.changeId;

  // Check against this process's env AND the repo's .env (read into memory
  // only, never sent anywhere): make does not export .env to this script.
  const dotEnvPath = resolve(args.get("env-file") ?? join(repoRoot, ".env"));
  const env = { ...(existsSync(dotEnvPath) ? parseDotEnv(readFileSync(dotEnvPath, "utf8")) : {}), ...process.env };
  const simulated = args.has("simulated");
  const file = buildReplayFile({ ...raw, changeId }, { repoRoot, env, simulated });
  const indexPath = join(outDir, "index.json");
  const index = existsSync(indexPath) ? (JSON.parse(readFileSync(indexPath, "utf8")) as ReplayIndex) : null;
  const previous = index?.runs.find((r) => r.id === changeId);
  const outcome = recordedOutcome(file);
  const app = args.get("app") ?? previous?.app ?? "app";
  const next = upsertIndex(
    index,
    labelSimulated(
      {
        id: changeId,
        title: args.get("title") ?? previous?.title ?? `${app}: ${outcome}`,
        app,
        outcome,
        // A simulated run is regenerated, and its counts change: they are always read fresh from the log.
        description: simulated
          ? [args.get("description"), describeReplay(file)].filter((t) => t !== undefined && t !== "").join(" ")
          : (args.get("description") ?? previous?.description ?? describeReplay(file)),
        messages: file.messages.length,
      },
      simulated,
    ),
  );

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${changeId}.json`), `${JSON.stringify(file)}\n`);
  writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`wrote ${join(outDir, `${changeId}.json`)} (${file.messages.length} messages, outcome ${outcome}) and updated index.json`);
  if (simulated) console.log(`  labelled SIMULATED: ${SIMULATED_NOTE}`);
}

main().catch((err: unknown) => {
  if (err instanceof ReplayRefused) {
    console.error(err.message);
    console.error("Nothing was written. Remove the secret from the source run, or do not publish it.");
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});

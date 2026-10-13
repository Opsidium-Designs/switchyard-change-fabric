/**
 * Write the synthetic large board logs as replay files into a directory you
 * name (for LOCAL screenshots of a built replay page only: point it at
 * `dist-replay/replays`, never at `public/replays`, and never add the runs to
 * the committed index).
 *
 *   node --disable-warning=ExperimentalWarning --experimental-transform-types \
 *     tests/fixtures/write-large-replay.ts dist-replay/replays
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { largeBoardLog } from "./large-board.ts";

const out = process.argv[2];
if (out === undefined || /public[\\/]+replays/.test(resolve(out))) {
  console.error("usage: write-large-replay.ts <dir> (a built dist directory, never public/replays)");
  process.exit(2);
}
for (const [id, workers] of [["synthetic-large-30", 30], ["synthetic-large-100", 99]] as const) {
  const messages = largeBoardLog({ workers });
  const file = join(out, `${id}.json`);
  writeFileSync(file, JSON.stringify({ format: "switchyard-replay/v1", changeId: id, messages, snapshot: null }));
  console.log(`${file}: ${messages.length} messages, ${workers + 1} agents`);
}

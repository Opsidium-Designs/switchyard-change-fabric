/**
 * local-runner: the out-of-Worker process that executes WorkUnits.
 *
 * It leases a runnable WorkUnit from the Worker, clones the isolated workspace
 * over standard Git, invokes the selected ExecutorProvider, commits, pushes back
 * to the workspace, and reports cost and completion. Running Git and child
 * processes is why this lives in Node and not in a Cloudflare Worker.
 */

export type { FetchLike, Lease, CostReport } from "./worker-client.ts";
export { WorkerClient } from "./worker-client.ts";

export type { GitIdentity } from "./git.ts";
export {
  DEFAULT_IDENTITY,
  authenticatedRemote,
  clone,
  commitAll,
  git,
  hasChanges,
  push,
} from "./git.ts";

export type { RunWorkUnitOptions, RunWorkUnitResult } from "./runner.ts";
export { runWorkUnit } from "./runner.ts";

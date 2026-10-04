/**
 * The per-app live deployment registry.
 *
 * Deploy is a MANUAL, per-app human step taken BEFORE a fix run (so a watcher
 * sees the break at a real URL first), and a verified run REDEPLOYS the fixed
 * code to that SAME deployment IN PLACE. For that to work, the broken deploy and
 * the post-fix redeploy must share ONE stable identity, and the run must be able
 * to tell whether a manual deploy already happened. This module is the single
 * source of truth for both:
 *
 *   - `stableAppWorkerName(app)`: the STABLE worker name derived from the app
 *     (never a per-run id), so deploying examples/apps/<app> and redeploying it
 *     later both target the same Worker and so the same workers.dev URL.
 *   - a tiny per-app MARKER (a gitignored JSON file under `.deployments/<app>.json`)
 *     a manual deploy writes with the live URL, the run reads to decide whether
 *     to redeploy in place, and teardown clears. The marker is the durable "this
 *     app is deployed" fact that outlives any single run's unique Change id.
 *
 * The marker is a local, gitignored file (never committed, never a secret: it
 * holds only the public workers.dev URL). It is intentionally NOT the Worker's
 * per-Change deployment record, which is scoped to one run id; the marker is
 * keyed by the stable app name so it is shared across the manual deploy, the
 * run, and teardown.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * The STABLE worker name for an app. Derived from the app directory name under
 * examples/apps, never from a per-run id, so the manual broken deploy and the
 * post-fix redeploy share one Worker and one URL. This is also the name declared
 * in each app's wrangler.jsonc, so a plain `wrangler deploy` in the app dir
 * targets exactly this name.
 */
export function stableAppWorkerName(app: string): string {
  return `switchyard-change-fabric-${app}`;
}

/** A recorded manual deployment of an app, by its stable identity. */
export interface AppDeploymentMarker {
  /** The app directory name under examples/apps. */
  readonly app: string;
  /** The stable worker name the app was deployed under. */
  readonly workerName: string;
  /** The live workers.dev URL (public; never a secret). */
  readonly url: string;
  /** When the marker was written (ISO). */
  readonly at: string;
}

/** The gitignored directory holding per-app deployment markers, under a root. */
export function deploymentsDir(repoRoot: string): string {
  return join(resolve(repoRoot), ".deployments");
}

/** The marker file path for one app, under a repo root. */
export function markerPath(repoRoot: string, app: string): string {
  return join(deploymentsDir(repoRoot), `${app}.json`);
}

/**
 * Record a manual deployment: write the per-app marker so a later run can see
 * the app is deployed and redeploy in place. Writes only the public URL and the
 * stable name, never a credential.
 */
export async function recordAppDeployment(
  repoRoot: string,
  app: string,
  url: string,
): Promise<AppDeploymentMarker> {
  const marker: AppDeploymentMarker = {
    app,
    workerName: stableAppWorkerName(app),
    url,
    at: new Date().toISOString(),
  };
  const path = markerPath(repoRoot, app);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return marker;
}

/**
 * Read the per-app deployment marker, or undefined when the app has not been
 * manually deployed. This is the "was this app already deployed?" lookup the run
 * uses to decide whether to redeploy in place (a URL) or deploy nothing.
 */
export async function readAppDeployment(
  repoRoot: string,
  app: string,
): Promise<AppDeploymentMarker | undefined> {
  try {
    const raw = await readFile(markerPath(repoRoot, app), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppDeploymentMarker>;
    if (typeof parsed.url === "string" && parsed.url !== "") {
      return {
        app: typeof parsed.app === "string" ? parsed.app : app,
        workerName:
          typeof parsed.workerName === "string" ? parsed.workerName : stableAppWorkerName(app),
        url: parsed.url,
        at: typeof parsed.at === "string" ? parsed.at : new Date(0).toISOString(),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Clear the per-app deployment marker on teardown. A missing marker is a no-op. */
export async function clearAppDeployment(repoRoot: string, app: string): Promise<void> {
  await rm(markerPath(repoRoot, app), { force: true });
}

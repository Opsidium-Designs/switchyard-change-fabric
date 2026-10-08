/**
 * How the browser console sends a MUTATION to the Worker without ever holding
 * the Worker's API token.
 *
 * When the Worker has `SWITCHYARD_API_TOKEN` set, every mutating route requires
 * `authorization: Bearer <token>`. A browser bundle must never carry that secret
 * (anything Vite bakes in, including a VITE_* env var, is readable by whoever
 * loads the page). So the console sends mutations through the dev launcher's
 * Node-side proxy, `POST /api/worker/<worker path>`, which adds the bearer from
 * its own process environment server-side and forwards to the Worker. The
 * proxy marks every response it relays with the `x-switchyard-proxy` header.
 *
 * When the launcher has no such proxy (an older launcher, or a static preview),
 * the proxy path is a plain 404 WITHOUT that marker, and the console falls back
 * to POSTing the Worker directly, which is exactly the old behavior and works
 * whenever the Worker's auth is off (local dev). A response that DOES carry the
 * marker is the Worker's real answer (even a 404 such as "no such Change"), so
 * it is returned as is and the mutation is never sent twice.
 *
 * Read-only polling (GET /changes/:id) stays a direct Worker fetch: the
 * snapshot GETs are open and carry no plaintext token.
 */

/** The launcher route prefix that proxies a Worker path with the bearer added. */
export const WORKER_PROXY_PREFIX = "/api/worker";

/** The header the launcher proxy sets on every response it relays. */
export const WORKER_PROXY_MARKER = "x-switchyard-proxy";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** POST a JSON body to a Worker path, preferring the launcher's auth proxy. */
export async function postToWorker(
  fetchFn: FetchFn,
  workerBase: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  try {
    const proxied = await fetchFn(`${WORKER_PROXY_PREFIX}${path}`, init);
    if (proxied.headers.get(WORKER_PROXY_MARKER) !== null) {
      return proxied;
    }
  } catch {
    // No launcher reachable on this origin: fall through to the direct POST.
  }
  return fetchFn(`${workerBase}${path}`, init);
}

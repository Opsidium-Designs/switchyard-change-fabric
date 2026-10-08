/**
 * worker-auth: attach the optional Worker API bearer token to every Node-side
 * HTTP call the fabric makes to the control-plane Worker.
 *
 * The Worker can require `authorization: Bearer <token>` on its routes when its
 * SWITCHYARD_API_TOKEN secret is set. The Node side (the live run driver, the
 * CLI, and the console launcher's spawned CLI) reads the same value from its own
 * environment and sends it. When the variable is unset or blank nothing changes:
 * the fetch is returned as-is, so offline runs and tests are unaffected. The
 * token is only ever placed in the request header; it is never logged.
 */

/** The environment variable holding the Worker API bearer token. */
export const WORKER_API_TOKEN_ENV = "SWITCHYARD_API_TOKEN";

/** Read the Worker API token from the environment, or undefined when unset/blank. */
export function workerApiToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const token = (env[WORKER_API_TOKEN_ENV] ?? "").trim();
  return token === "" ? undefined : token;
}

/**
 * Wrap a fetch so every request carries `authorization: Bearer <token>` when the
 * Worker API token is set. Returns the original fetch unchanged when it is not,
 * so a caller can apply this unconditionally. An explicit authorization header
 * already on a request is left alone.
 */
export function withWorkerAuth(
  fetchFn: typeof fetch,
  env: Readonly<Record<string, string | undefined>> = process.env,
): typeof fetch {
  const token = workerApiToken(env);
  if (token === undefined) {
    return fetchFn;
  }
  const authed = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    if (headers.authorization === undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    return fetchFn(input, { ...init, headers });
  };
  return authed as typeof fetch;
}

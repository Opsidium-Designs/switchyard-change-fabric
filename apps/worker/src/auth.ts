/**
 * Optional bearer auth for the Worker control plane.
 *
 * When the `SWITCHYARD_API_TOKEN` secret is set on the Worker (`wrangler secret
 * put SWITCHYARD_API_TOKEN` for a deploy, or a gitignored `apps/worker/.dev.vars`
 * for `wrangler dev`), every MUTATING request (any method other than GET, HEAD,
 * or OPTIONS) must carry `authorization: Bearer <token>`. That covers every
 * route that changes state and every route that returns a secret: the lease,
 * round-lease, recruit, fail, and repo-pushed routes hand back plaintext
 * Artifact write tokens, and they are all POSTs. The read-only snapshot GETs
 * stay open: the state projection carries token ids only, never a plaintext
 * token, so the console can poll without holding a credential.
 *
 * When the secret is unset (or empty), the Worker behaves exactly as before, so
 * the local-dev loop and the offline tests need no credential.
 *
 * The Queue consumer is not an HTTP route and is not gated here: it is only
 * reachable from the bound Cloudflare Queue.
 */

/** The methods that never mutate state and so stay open under auth. */
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The configured API token, or undefined when auth is off (unset or blank). */
export function configuredApiToken(env: { readonly SWITCHYARD_API_TOKEN?: string }): string | undefined {
  const token = env.SWITCHYARD_API_TOKEN;
  return typeof token === "string" && token.trim() !== "" ? token : undefined;
}

/** Whether a request with this method must be authenticated when auth is on. */
export function requiresAuth(method: string): boolean {
  return !READ_ONLY_METHODS.has(method.toUpperCase());
}

/**
 * Whether the request carries `authorization: Bearer <expected>`. The compare
 * runs over the full length of both values regardless of where they first
 * differ, so the response time does not reveal how much of a guess matched.
 */
export function hasValidBearer(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }
  return constantTimeEqual(match[1]!.trim(), expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

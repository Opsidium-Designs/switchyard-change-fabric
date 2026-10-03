/**
 * Minimal HTTP client the runner uses to talk to the Worker control surface.
 *
 * The transport is injectable (a `fetch`-shaped function). In production it is
 * the global fetch pointed at the local `wrangler dev` origin; in tests it is a
 * function that calls the Worker's `handleRequest` in-process, so the full lease,
 * cost, and completion loop runs without a network or a live Worker.
 */

/** A fetch-shaped transport. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The lease payload the Worker returns (plaintext token included once). */
export interface Lease {
  readonly unitId: string;
  readonly objective: string;
  readonly paths: readonly string[];
  readonly baselineRef: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly gitUrl: string;
  readonly defaultBranch: string;
  readonly backend: string;
  readonly fallback: boolean;
  readonly tokenId: string;
  readonly tokenExpiresAt: string;
  readonly token: string;
}

/** A cost report sent to the Worker. */
export interface CostReport {
  readonly usd: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly executor?: string;
}

export class WorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchLike,
  ) {}

  /** Lease a runnable WorkUnit, receiving its workspace and scoped token. */
  async lease(changeId: string, unitId: string): Promise<Lease> {
    const res = await this.fetchFn(this.url(`/changes/${enc(changeId)}/work/${enc(unitId)}/lease`), {
      method: "POST",
    });
    return (await this.expectJson(res, 201)) as Lease;
  }

  /** Send a cost heartbeat for a WorkUnit. */
  async reportCost(changeId: string, unitId: string, cost: CostReport): Promise<void> {
    const res = await this.fetchFn(this.url(`/changes/${enc(changeId)}/work/${enc(unitId)}/cost`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cost),
    });
    await this.expectJson(res, 200);
  }

  /** Mark a WorkUnit complete, with an optional final cost event. */
  async complete(changeId: string, unitId: string, cost?: CostReport): Promise<void> {
    const res = await this.fetchFn(this.url(`/changes/${enc(changeId)}/work/${enc(unitId)}/complete`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cost ? { cost } : {}),
    });
    await this.expectJson(res, 200);
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async expectJson(res: Response, expectedStatus: number): Promise<unknown> {
    const text = await res.text();
    let body: unknown;
    try {
      body = text === "" ? {} : JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    if (res.status !== expectedStatus) {
      const detail = (body as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new Error(`Worker request failed (${res.status}): ${detail}`);
    }
    return body;
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

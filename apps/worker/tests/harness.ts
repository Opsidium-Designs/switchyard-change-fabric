/**
 * In-process harness for the Worker: the real `handleRequest` and the real
 * ChangeState class, over an in-memory Durable Object storage and a fake
 * namespace that hands back one ChangeState instance per Change id (the RPC
 * stub is just the instance, since its methods are already async). Workspace
 * provisioning is a recording fake, so lease issuance and revocation are
 * observable without Artifacts or a network.
 */
import { ChangeState } from "../src/change-state.ts";
import { handleRequest } from "../src/index.ts";
import type {
  EnvWithProvisioner,
  ProvisionedWorkspace,
  WorkspaceProvisioner,
} from "../src/workspace-provisioner.ts";

/**
 * An in-memory stand-in for Durable Object storage: get, put (one key or an
 * entries object), delete (one key or many), list (prefix/start/end/limit, in
 * key order), and transaction (all-or-nothing: a throw rolls every write back).
 */
export class MemoryStorage {
  private data = new Map<string, unknown>();
  /** Writes performed, for tests that assert atomicity. */
  writes = 0;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof keyOrEntries === "string" ? { [keyOrEntries]: value } : keyOrEntries;
    if (Object.keys(entries).length > 128) {
      throw new Error("put accepts at most 128 keys");
    }
    for (const [key, entry] of Object.entries(entries)) {
      this.data.set(key, structuredClone(entry));
      this.writes += 1;
    }
  }
  async delete(keys: string | string[]): Promise<boolean | number> {
    const list = Array.isArray(keys) ? keys : [keys];
    let count = 0;
    for (const key of list) {
      count += this.data.delete(key) ? 1 : 0;
    }
    return Array.isArray(keys) ? count : count > 0;
  }
  async list<T>(options: { prefix?: string; start?: string; end?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const keys = [...this.data.keys()]
      .filter(
        (key) =>
          (options.prefix === undefined || key.startsWith(options.prefix)) &&
          (options.start === undefined || key >= options.start) &&
          (options.end === undefined || key < options.end),
      )
      .sort()
      .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER);
    return new Map(keys.map((key) => [key, structuredClone(this.data.get(key)) as T]));
  }
  async transaction<T>(closure: (txn: MemoryStorage) => Promise<T>): Promise<T> {
    const snapshot = new Map(this.data);
    try {
      return await closure(this);
    } catch (error) {
      this.data = snapshot;
      throw error;
    }
  }
}

/** A provisioner that records every issued and revoked token. */
export class RecordingProvisioner implements WorkspaceProvisioner {
  readonly issued: { workspaceName: string; tokenId: string; ttlSeconds?: number }[] = [];
  readonly revoked: { workspaceName: string; tokenId: string }[] = [];
  private counter = 0;

  async provision(workspaceName: string, options: { ttlSeconds?: number } = {}): Promise<ProvisionedWorkspace> {
    this.counter += 1;
    const tokenId = `tok-${this.counter}`;
    this.issued.push({ workspaceName, tokenId, ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}) });
    return {
      workspaceId: `ws-${workspaceName}`,
      workspaceName,
      gitUrl: `memory://test/${workspaceName}`,
      defaultBranch: "main",
      backend: "test",
      fallback: true,
      tokenId,
      token: `secret-${tokenId}`,
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    };
  }
  async revoke(workspaceName: string, tokenId: string): Promise<void> {
    this.revoked.push({ workspaceName, tokenId });
  }
  readonly archived: string[] = [];
  async archive(workspaceName: string): Promise<void> {
    this.archived.push(workspaceName);
  }
  readonly forks: { source: string; target: string; ttlSeconds?: number }[] = [];
  async fork(source: string, target: string, options: { ttlSeconds?: number } = {}): Promise<ProvisionedWorkspace> {
    this.forks.push({ source, target, ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}) });
    return this.provision(target, options);
  }
  readonly readTokens: { workspaceName: string; ttlSeconds: number }[] = [];
  async issueReadToken(workspaceName: string, ttlSeconds: number): Promise<{ tokenId: string; token: string; tokenExpiresAt: string }> {
    this.readTokens.push({ workspaceName, ttlSeconds });
    return { tokenId: `read-${this.readTokens.length}`, token: `read-secret-${this.readTokens.length}`, tokenExpiresAt: "2099-01-01T00:00:00.000Z" };
  }
}

export interface Harness {
  readonly provisioner: RecordingProvisioner;
  /** The env the handler runs with (tests can read the bindings they injected). */
  readonly env: EnvWithProvisioner;
  /** The ChangeState instance of a Change (created on first use). */
  state(changeId: string): ChangeState;
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
}

export function createHarness(
  options: {
    readonly apiToken?: string;
    readonly provisioner?: RecordingProvisioner;
    /** Extra bindings (for example a fake INTEGRATION_WORKFLOW). */
    readonly env?: Record<string, unknown>;
  } = {},
): Harness {
  const provisioner = options.provisioner ?? new RecordingProvisioner();
  const objects = new Map<string, ChangeState>();
  const env = {
    ...(options.apiToken !== undefined ? { SWITCHYARD_API_TOKEN: options.apiToken } : {}),
    WORKSPACE_PROVISIONER: provisioner,
    ...(options.env ?? {}),
  } as Record<string, unknown>;
  env.CHANGE_STATE = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let object = objects.get(id);
      if (!object) {
        object = new ChangeState({ storage: new MemoryStorage() } as never, env as never);
        objects.set(id, object);
      }
      return object;
    },
  };
  const typedEnv = env as unknown as EnvWithProvisioner;

  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] =
        typeof body === "string" ? "text/plain" : "application/json";
    }
    return handleRequest(new Request(`http://worker.test${path}`, init), typedEnv);
  };

  return {
    provisioner,
    env: typedEnv,
    state: (changeId: string) => (env.CHANGE_STATE as { get(id: string): ChangeState }).get(changeId),
    request,
    async json(method, path, body, headers) {
      const res = await request(method, path, body, headers);
      const text = await res.text();
      return { status: res.status, body: (text === "" ? {} : JSON.parse(text)) as never };
    },
  };
}

/** A minimal two-unit Change spec (unit b depends on unit a). */
export function specYaml(id: string): string {
  return [
    `id: ${id}`,
    "objective: add audit logging",
    "baseline: main",
    "budget_usd: 5",
    "assurance: standard",
    "work:",
    "  - id: a",
    "    objective: do a",
    "    paths: [src/a.ts]",
    "  - id: b",
    "    objective: do b",
    "    paths: [src/b.ts]",
    "    depends_on: [a]",
    "",
  ].join("\n");
}

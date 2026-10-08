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

class MemoryStorage {
  private readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

/** A provisioner that records every issued and revoked token. */
export class RecordingProvisioner implements WorkspaceProvisioner {
  readonly issued: { workspaceName: string; tokenId: string }[] = [];
  readonly revoked: { workspaceName: string; tokenId: string }[] = [];
  private counter = 0;

  async provision(workspaceName: string): Promise<ProvisionedWorkspace> {
    this.counter += 1;
    const tokenId = `tok-${this.counter}`;
    this.issued.push({ workspaceName, tokenId });
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
  async archive(_workspaceName: string): Promise<void> {}
}

export interface Harness {
  readonly provisioner: RecordingProvisioner;
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
}

export function createHarness(options: { readonly apiToken?: string } = {}): Harness {
  const provisioner = new RecordingProvisioner();
  const objects = new Map<string, ChangeState>();
  const env = {
    ...(options.apiToken !== undefined ? { SWITCHYARD_API_TOKEN: options.apiToken } : {}),
    WORKSPACE_PROVISIONER: provisioner,
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

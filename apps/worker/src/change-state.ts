import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.ts";

/**
 * ChangeState — single-owner, serialized Durable Object holding the live Change
 * projection and path/write leases. M0 is a stub: it accepts a Change
 * id and echoes a tiny state record so the binding is exercised end-to-end. The
 * Change/WorkUnit projection and lease logic land in M1/M4.
 */
export class ChangeState extends DurableObject<Env> {
  async getStatus(): Promise<{ id: string; initialized: boolean }> {
    const id = (await this.ctx.storage.get<string>("changeId")) ?? "";
    return { id, initialized: id !== "" };
  }

  async initialize(changeId: string): Promise<void> {
    await this.ctx.storage.put("changeId", changeId);
  }
}

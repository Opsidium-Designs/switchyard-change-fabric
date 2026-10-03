import { CloudflareArtifactWorkspaceProvider } from "@switchyard-change/artifact-workspace";
import { parseChangeSpec } from "@switchyard-change/change-core";

import type { Env } from "./env.ts";

// Durable Object and Workflow classes MUST be exported from the entry module so
// the runtime can instantiate them from their bindings.
export { ChangeState } from "./change-state.ts";
export { ChangeWorkflow } from "./workflow.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      // The console is served from a separate origin in local dev.
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

/** Get the ChangeState Durable Object stub addressed by Change id. */
function changeStateStub(env: Env, changeId: string) {
  const id = env.CHANGE_STATE.idFromName(changeId);
  return env.CHANGE_STATE.get(id);
}

/**
 * The Worker is the Change control surface. It exposes:
 *   - a health probe
 *   - create/delete of an Artifact repo (workspace provider wiring)
 *   - create a Change from a spec, read its live orchestration state, and mark a
 *     WorkUnit complete to drive runnable/waiting transitions
 *
 * The Artifacts runner that would mark WorkUnits complete automatically is out
 * of scope for this milestone; this surface is orchestration and state only.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return json({}, 204);
    }

    // Health / readiness probe.
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        service: "switchyard-change-fabric",
        status: "ok",
        artifactsBinding: env.ARTIFACTS ? "live" : "stubbed",
      });
    }

    // Create a Change from a spec. The request body is the Change spec YAML.
    // The Change id is taken from the parsed spec and used to address the DO.
    if (request.method === "POST" && url.pathname === "/changes") {
      const specYaml = await request.text();
      if (specYaml.trim() === "") {
        return json({ error: "empty Change spec body" }, 400);
      }
      let probeId: string;
      try {
        // Parse once here only to learn the id to address the DO; the DO parses
        // and validates authoritatively.
        probeId = parseChangeSpec(specYaml).id;
      } catch (error) {
        return json({ error: errorMessage(error) }, 400);
      }
      const stub = changeStateStub(env, probeId);
      try {
        const state = await stub.createFromSpec(specYaml);
        return json(state, 201);
      } catch (error) {
        return json({ error: errorMessage(error) }, 400);
      }
    }

    // Read a Change's live orchestration state.
    const stateMatch = url.pathname.match(/^\/changes\/([^/]+)$/);
    if (request.method === "GET" && stateMatch) {
      const changeId = decodeURIComponent(stateMatch[1] ?? "");
      const stub = changeStateStub(env, changeId);
      if (!(await stub.isInitialized())) {
        return json({ error: `no such Change: ${changeId}` }, 404);
      }
      return json(await stub.getState());
    }

    // Mark a WorkUnit complete to drive runnable/waiting transitions.
    const completeMatch = url.pathname.match(/^\/changes\/([^/]+)\/work\/([^/]+)\/complete$/);
    if (request.method === "POST" && completeMatch) {
      const changeId = decodeURIComponent(completeMatch[1] ?? "");
      const unitId = decodeURIComponent(completeMatch[2] ?? "");
      const stub = changeStateStub(env, changeId);
      if (!(await stub.isInitialized())) {
        return json({ error: `no such Change: ${changeId}` }, 404);
      }
      try {
        return json(await stub.completeUnit(unitId));
      } catch (error) {
        return json({ error: errorMessage(error) }, 400);
      }
    }

    const provider = new CloudflareArtifactWorkspaceProvider(env.ARTIFACTS);

    // Create an Artifact repo (workspace provider wiring).
    if (request.method === "POST" && url.pathname === "/artifacts") {
      const name = url.searchParams.get("name") ?? `workunit-${Date.now()}`;
      const ref = await provider.create(name);
      return json({ created: ref, stubbed: provider.stubbed }, 201);
    }

    // Delete an Artifact repo.
    if (request.method === "DELETE" && url.pathname.startsWith("/artifacts/")) {
      const id = decodeURIComponent(url.pathname.slice("/artifacts/".length));
      if (id === "") {
        return json({ error: "missing artifact id" }, 400);
      }
      await provider.delete(id);
      return json({ deleted: id, stubbed: provider.stubbed });
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

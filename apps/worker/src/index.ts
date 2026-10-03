import { CloudflareArtifactWorkspaceProvider } from "@switchyard-change/artifact-workspace";

import type { Env } from "./env.ts";

// Durable Object and Workflow classes MUST be exported from the entry module so
// the runtime can instantiate them from their bindings.
export { ChangeState } from "./change-state.ts";
export { ChangeWorkflow } from "./workflow.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The Worker is the Change control surface. M0 exposes just enough to
 * prove the exit capability: a health probe plus a create/delete path for an
 * Artifact repo, wired to the ARTIFACTS binding (`remote = true`). When the
 * binding is unavailable (no `wrangler login` / Artifacts access) the provider
 * stubs cleanly and the response advertises `stubbed: true`.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const provider = new CloudflareArtifactWorkspaceProvider(env.ARTIFACTS);

    // Health / readiness probe.
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        service: "switchyard-change-fabric",
        status: "ok",
        artifactsBinding: env.ARTIFACTS ? "live" : "stubbed",
      });
    }

    // M0 exit capability: create an Artifact repo.
    if (request.method === "POST" && url.pathname === "/artifacts") {
      const name = url.searchParams.get("name") ?? `workunit-${Date.now()}`;
      const ref = await provider.create(name);
      return json({ created: ref, stubbed: provider.stubbed }, 201);
    }

    // M0 exit capability: delete an Artifact repo.
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

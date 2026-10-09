/**
 * Filling a tool skeleton's regions with one schema-constrained call: the
 * prompt names every region with its signature and an example, replies are
 * validated strictly, and the strongest model goes first, falling back only on
 * a transport error. A faked fetch; no network.
 */
import { describe, expect, it } from "vitest";

import {
  buildToolRegionMessages,
  createAiGatewayToolRegionFiller,
  parseToolRegionFills,
  ToolRegionError,
  type ToolRegionRequest,
} from "../src/index.ts";

const request: ToolRegionRequest = {
  capability: "scan-unit",
  kind: "scanner",
  contract: "A scanner prints one JSON object per line.",
  goal: "Add input validation and require auth on every resource",
  regions: [
    { file: "tools/scan-unit/run.mjs", name: "detect", guidance: "return the places in one file that need the change", signature: "function detect(path, text)", example: "function detect(path, text) {\n  return [];\n}" },
    { file: "tools/scan-unit/test.mjs", name: "fixture", guidance: "write a small file and assert the findings", signature: "", example: "assert.equal(run(dir).status, 0);" },
  ],
  files: [{ path: "tools/scan-unit/run.mjs", text: "// FILL-BEGIN detect: ...\nfunction detect(path, text) {\n}\n// FILL-END detect" }],
  excerpts: [{ path: "src/resources/users.js", text: "export async function handle(request) {}" }],
  gateFailure: "filled: the skeleton is not filled in yet",
};

const good = {
  fills: [
    { file: "tools/scan-unit/run.mjs", name: "detect", code: "function detect(path, text) {\n  return [];\n}" },
    { file: "tools/scan-unit/test.mjs", name: "fixture", code: "assert.equal(run(dir).status, 0);" },
  ],
};

function reply(content: unknown, status = 200): Response {
  return new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content: JSON.stringify(content) } }] } : { error: "boom" }), { status });
}

describe("tool region fills", () => {
  it("the prompt names every region with its signature, an example fill, the contract, the goal, and the failing checks", () => {
    const [system, user] = buildToolRegionMessages(request);
    expect(system!.content).toContain("one entry for EVERY region");
    expect(system!.content).toContain("A scanner prints one JSON object per line.");
    expect(user!.content).toContain('tools/scan-unit/run.mjs region "detect"');
    expect(user!.content).toContain("signature: function detect(path, text)");
    expect(user!.content).toContain('tools/scan-unit/test.mjs region "fixture"');
    expect(user!.content).toContain("example of a correct fill");
    expect(user!.content).toContain("Add input validation and require auth on every resource");
    expect(user!.content).toContain("UNTRUSTED DATA: the previous build's failing gate checks");
    expect(user!.content).toContain("UNTRUSTED DATA: files the tool acts on");
  });

  it("validates replies strictly: every region exactly once, known regions only, the signature kept", () => {
    expect(parseToolRegionFills(good, request.regions)).toHaveLength(2);
    expect(() => parseToolRegionFills({ fills: [good.fills[0]] }, request.regions)).toThrow(/left unfilled: tools\/scan-unit\/test.mjs#fixture/);
    expect(() => parseToolRegionFills({ fills: [...good.fills, { file: "tools/scan-unit/run.mjs", name: "evil", code: "x" }] }, request.regions)).toThrow(/unknown region evil/);
    expect(() => parseToolRegionFills({ fills: [{ ...good.fills[0], code: "function other() {}" }, good.fills[1]] }, request.regions)).toThrow(/must define function detect\(path, text\)/);
    expect(() => parseToolRegionFills("not json", request.regions)).toThrow(ToolRegionError);
  });

  it("runs on the strongest model first and falls back down the ladder only on a transport error", async () => {
    const asked: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const model = (JSON.parse(String(init!.body)) as { model: string }).model;
      asked.push(model);
      return model === "strong" ? reply({}, 503) : reply(good);
    }) as unknown as typeof fetch;
    const filler = createAiGatewayToolRegionFiller({ gatewayUrl: "https://gw.example", gatewayToken: "t", models: ["strong", "base"], fetchFn });
    const result = await filler(request);
    expect(asked).toEqual(["strong", "base"]);
    expect(result.model).toBe("base");
    // A wrong reply is the model's fault: no fallback.
    const wrongAsked: string[] = [];
    const wrong = createAiGatewayToolRegionFiller({
      gatewayUrl: "https://gw.example",
      gatewayToken: "t",
      models: ["strong", "base"],
      fetchFn: (async (_url: string, init?: RequestInit) => {
        wrongAsked.push((JSON.parse(String(init!.body)) as { model: string }).model);
        return reply({ fills: [] });
      }) as unknown as typeof fetch,
    });
    await expect(wrong(request)).rejects.toThrow(/left unfilled/);
    expect(wrongAsked).toEqual(["strong"]);
  });
});

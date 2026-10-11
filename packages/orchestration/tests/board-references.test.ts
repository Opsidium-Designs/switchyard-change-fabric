/**
 * The board's read-only reference picker (`boardReferenceFiles`): pure over an
 * in-memory repo, so every priority and bound is fixed.
 */
import { describe, expect, it } from "vitest";

import { boardReferenceFiles, MAX_REFERENCE_FILES, typeNamesIn } from "../src/board-references.ts";

function repo(files: Record<string, string>) {
  return { files: Object.keys(files).sort(), read: async (path: string) => files[path] };
}

describe("boardReferenceFiles", () => {
  it("puts a file the failure locates outside the write scope first, then seams, then imports; resolves index and .js specifiers", async () => {
    const r = repo({
      "src/billing/invoices.ts": 'import { pay } from "../payments/index.js";\nimport { Money } from "../contracts";\nexport const x = 1;\n',
      "src/payments/index.ts": 'export function pay(): void {}\n',
      "src/contracts/index.ts": "export interface Money { readonly cents: number }\n",
      "src/orders/routes.ts": "export const routes = [];\n",
      "src/unrelated.ts": "export const u = 1;\n",
    });
    const refs = await boardReferenceFiles({
      ...r,
      writable: ["src/billing/invoices.ts"],
      seams: ["src/contracts/index.ts"],
      evidence: "src/orders/routes.ts(4,10): error TS2305: Module '../billing/invoices.ts' has no exported member 'total'.",
    });
    expect(refs.map((f) => f.path)).toEqual(["src/orders/routes.ts", "src/contracts/index.ts", "src/payments/index.ts"]);
  });

  it("resolves a named type to the imported module that declares it, preferring a declaration over a re-export", async () => {
    const r = repo({
      "src/a.ts": 'import { Order } from "./store.ts";\nexport const a = 1;\n',
      "src/store.ts": 'export { Order } from "./models.ts";\n',
      "src/models.ts": "export interface Order { readonly id: string }\n",
    });
    const refs = await boardReferenceFiles({ ...r, writable: ["src/a.ts"], evidence: "Property 'totalAmount' does not exist on type 'Order'." });
    expect(refs.map((f) => f.path)).toEqual(["src/models.ts", "src/store.ts"]);
  });

  it("bounds the count and each body, skips unreadable files and writable ones", async () => {
    const files: Record<string, string> = { "src/main.ts": "" };
    for (let i = 0; i < 8; i += 1) {
      files["src/main.ts"] += `import { m${i} } from "./m${i}.ts";\n`;
      files[`src/m${i}.ts`] = `export const m${i} = ${i};\n`;
    }
    files["src/m0.ts"] = `export const m0 = 0;\n${"y".repeat(500)}`;
    const r = repo(files);
    const refs = await boardReferenceFiles({
      files: r.files,
      read: async (path) => (path === "src/m2.ts" ? undefined : r.read(path)),
      writable: ["src/main.ts", "src/m1.ts"],
      maxBytes: 100,
    });
    expect(refs.map((f) => f.path)).toEqual(["src/m0.ts", "src/m3.ts", "src/m4.ts", "src/m5.ts", "src/m6.ts"]);
    expect(refs).toHaveLength(MAX_REFERENCE_FILES);
    expect(refs[0]!.contents).toBe(`${files["src/m0.ts"]!.slice(0, 100)}\n... (read-only reference truncated at 100 characters of ${files["src/m0.ts"]!.length})`);
  });

  it("reads the type names TypeScript diagnostics name", () => {
    expect(typeNamesIn("Type '{ id: string; }' is not assignable to type 'Payment[]'. Property 'x' does not exist on type 'Ctx<User>'.")).toEqual(["Payment", "Ctx"]);
  });
});

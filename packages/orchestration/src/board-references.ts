/**
 * board-references: the bounded READ-ONLY reference files a board edit is
 * shown next to its writable files.
 *
 * An agent's executor sees only the files its claim may write. The types and
 * helpers those files import (a shared store, a contract module) live outside
 * the write scope, so without them a model invents fields that do not exist,
 * and a fix for "Property 'x' does not exist on type 'Order'" never sees the
 * Order it must use. This picks a small set of files the agent may read but
 * never write, in priority order:
 *   1. files the current failure evidence names outside the write scope (an
 *      error or stack location, `failingRepoFiles`), and the file that exports
 *      a type the evidence names (`on type 'Order'`) among the modules the
 *      writable files import;
 *   2. shared seams (the goal's frozen contracts) the writable files import;
 *   3. the other relative imports of the writable files (depth 1, then 2).
 * Files already writable are never repeated; each body is bounded and a long
 * one is truncated with a clear marker (never skipped). Deterministic: the
 * order depends only on the inputs.
 */

import { posix } from "node:path";

import { failingRepoFiles } from "@switchyard-change/change-core";

import { importCandidates, relativeImports } from "./protected-paths.ts";

/** How many reference files one edit is shown at most. */
export const MAX_REFERENCE_FILES = 5;
/** The characters of one reference file shown at most (longer ones are truncated with a marker). */
export const MAX_REFERENCE_BYTES = 12 * 1024;

/** One read-only reference file (the executor's `frozenContractFiles` shape). */
export interface ReferenceFile {
  readonly path: string;
  readonly contents: string;
}

export interface ReferenceInput {
  /** The concrete files this edit may write (never repeated as references). */
  readonly writable: readonly string[];
  /** Every repo file the agent sees (repo-relative, POSIX). */
  readonly files: readonly string[];
  /** Read a file as the agent currently sees it (its own version, else the baseline), or undefined. */
  readonly read: (path: string) => Promise<string | undefined>;
  /** The shared seam paths the goal declared (frozen contracts). */
  readonly seams?: readonly string[];
  /** The current failure evidence (gate output, regression lines), untrusted text. */
  readonly evidence?: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

/** The type names a TypeScript diagnostic names (`on type 'Order'`, `to type 'Payment[]'`). */
export function typeNamesIn(evidence: string): string[] {
  const out: string[] = [];
  const re = /\btype '([A-Za-z_$][\w$]*)(?:<[^'\n]*>)?(?:\[\])*'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(evidence)) !== null) {
    if (match[1] && !out.includes(match[1])) {
      out.push(match[1]);
    }
  }
  return out;
}

/** Whether a module declares (`declared`) or re-exports by name (`listed`) the export `name`. */
function exportsName(source: string, name: string, how: "declared" | "listed"): boolean {
  const n = name.replace(/\$/g, "\\$");
  return how === "declared"
    ? new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:interface|type|class|function\\*?|const|let|var|enum)\\s+${n}(?![\\w$])`).test(source)
    : new RegExp(`\\bexport\\s+(?:type\\s+)?\\{[^}]*(?<![\\w$])${n}(?![\\w$])[^}]*\\}`).test(source);
}

/** The bounded read-only reference files for one edit, in priority order. */
export async function boardReferenceFiles(input: ReferenceInput): Promise<ReferenceFile[]> {
  const maxFiles = input.maxFiles ?? MAX_REFERENCE_FILES;
  const maxBytes = input.maxBytes ?? MAX_REFERENCE_BYTES;
  if (maxFiles <= 0) {
    return [];
  }
  const writable = new Set(input.writable);
  const fileSet = new Set(input.files);
  const cache = new Map<string, Promise<string | undefined>>();
  const read = (path: string): Promise<string | undefined> => {
    let hit = cache.get(path);
    if (hit === undefined) {
      hit = input.read(path).catch(() => undefined);
      cache.set(path, hit);
    }
    return hit;
  };
  // A file's relative imports resolved to repo files the way the runtime resolves them.
  const importsOf = async (file: string): Promise<string[]> => {
    const source = await read(file);
    if (source === undefined) {
      return [];
    }
    const out: string[] = [];
    for (const spec of relativeImports(source)) {
      const joined = posix.normalize(posix.join(posix.dirname(file), spec));
      if (joined.startsWith("..") || joined.startsWith("/")) {
        continue;
      }
      const hit = importCandidates(joined).find((c) => fileSet.has(c));
      if (hit !== undefined && hit !== file && !out.includes(hit)) {
        out.push(hit);
      }
    }
    return out;
  };
  const depth1: string[] = [];
  for (const file of input.writable) {
    for (const imported of await importsOf(file)) {
      if (!writable.has(imported) && !depth1.includes(imported)) {
        depth1.push(imported);
      }
    }
  }
  const depth2: string[] = [];
  for (const file of depth1) {
    for (const imported of await importsOf(file)) {
      if (!writable.has(imported) && !depth1.includes(imported) && !depth2.includes(imported)) {
        depth2.push(imported);
      }
    }
  }
  const closure = [...depth1, ...depth2];
  const evidence = input.evidence ?? "";
  const named: string[] = evidence !== "" ? failingRepoFiles(evidence, input.files) : [];
  // A type the evidence names: the imported module that declares it, else one that re-exports it by name.
  for (const name of evidence !== "" ? typeNamesIn(evidence) : []) {
    let owner: string | undefined;
    for (const how of ["declared", "listed"] as const) {
      for (const file of closure) {
        const source = await read(file);
        if (source !== undefined && exportsName(source, name, how)) {
          owner = file;
          break;
        }
      }
      if (owner !== undefined) {
        break;
      }
    }
    if (owner !== undefined) {
      named.push(owner);
    }
  }
  const seams = new Set(input.seams ?? []);
  const ordered = [...named, ...closure.filter((f) => seams.has(f)), ...closure];
  const out: ReferenceFile[] = [];
  const taken = new Set<string>();
  for (const path of ordered) {
    if (out.length >= maxFiles) {
      break;
    }
    if (writable.has(path) || taken.has(path)) {
      continue;
    }
    taken.add(path);
    const contents = await read(path);
    if (contents === undefined) {
      continue;
    }
    out.push({
      path,
      contents: contents.length > maxBytes ? `${contents.slice(0, maxBytes)}\n... (read-only reference truncated at ${maxBytes} characters of ${contents.length})` : contents,
    });
  }
  return out;
}

/**
 * Syntax-only check of a model edit's result, before it is written.
 *
 * An anchored edit can apply cleanly and still leave a file unparsable: a
 * `replace` that drops a closing brace, or one that covers more than its
 * `search` and duplicates a block ending. Pushing that file costs a full
 * integration and gate cycle, and a model that misreads the gate error can push
 * it again and again. This check rejects such an edit up front as unusable model
 * output, so the attempt fails honestly and the parse error goes back to the
 * agent instead of to the gate.
 *
 * It is a refusal only: it never accepts anything the gate would reject, and
 * the gate stays authoritative. It uses Node's built-in TypeScript parser
 * (`module.stripTypeScriptTypes`, no new dependency, no type checking); where
 * that parser is unavailable (older Node), the check is skipped. A file that
 * already failed to parse before the edit is not checked, so a model can still
 * edit a broken file toward fixed.
 */
import * as nodeModule from "node:module";

type StripTypes = (code: string, options: { mode: "transform"; sourceMap?: boolean }) => string;

const PARSED_EXTENSIONS = /\.(ts|mts|cts)$/i;

function stripper(): StripTypes | undefined {
  const fn = (nodeModule as unknown as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes;
  return typeof fn === "function" ? (fn as StripTypes) : undefined;
}

/** True when this runtime can syntax-check TypeScript. */
export function syntaxCheckAvailable(): boolean {
  return stripper() !== undefined;
}

/**
 * The parse error for `contents` as the file at `path`, or undefined when it
 * parses, is not a checked file type, or the parser is unavailable.
 */
export function syntaxError(path: string, contents: string): string | undefined {
  if (!PARSED_EXTENSIONS.test(path)) {
    return undefined;
  }
  const strip = stripper();
  if (strip === undefined) {
    return undefined;
  }
  try {
    strip(contents, { mode: "transform" });
    return undefined;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "ERR_INVALID_TYPESCRIPT_SYNTAX") {
      // Anything other than a syntax verdict (an unsupported construct, an
      // internal parser failure) is not evidence the edit broke the file.
      return undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.split("\n")[0]!.slice(0, 200);
  }
}

/**
 * The edits that broke a file's syntax: each changed file that parsed before
 * the edit and no longer parses after it, with the parse error.
 */
export function brokenByEdit(
  changed: ReadonlyArray<{ readonly path: string; readonly before: string; readonly after: string }>,
): Array<{ path: string; error: string }> {
  const broken: Array<{ path: string; error: string }> = [];
  for (const file of changed) {
    const after = syntaxError(file.path, file.after);
    if (after === undefined) {
      continue;
    }
    if (syntaxError(file.path, file.before) !== undefined) {
      continue;
    }
    broken.push({ path: file.path, error: after });
  }
  return broken;
}

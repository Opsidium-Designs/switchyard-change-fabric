// Safe source edits for agent-built codemods.
//
// The runtime ships this file with every codemod it scaffolds (as
// tools/<capability>/lib/edit.mjs). A codemod DECIDES what to change (which
// functions, which statement, which import); these primitives do the text
// surgery. Every edit is validated by re-parsing the result (Node's own
// TypeScript-stripping parser when this Node has it, plus a token-aware
// bracket check that always runs): an edit whose result would not parse is
// skipped and reported as a finding, never written. Every primitive is
// idempotent: applying the same edits to their own output changes nothing.
//
// Dependency-free (node:* only), deterministic, and it executes nothing it
// reads.
//
// API (all pure; nothing here reads or writes a file):
//   functions(text)                    the functions in a JS/TS source text:
//       [{ name, kind: "function"|"arrow"|"method", exported, isDefault,
//          async, params: [name | null], header, body, line }]
//   insertAtStart(target, statement)   insert a statement at the start of every
//       matched function body (skipped where the body already contains it)
//   wrapBody(target, before, after)    wrap every matched function body
//       (skipped where the body already starts with before and ends with after)
//   addImport({ from, names?, default? })  add a named/default import unless
//       it is already there (merged into an existing import of the same module)
//   replaceOnce(find, replacement)     replace a snippet only when it occurs
//       exactly once (refused when ambiguous; a no-op once already replaced)
//   applyEdits(path, text, edits)      apply edits in order, re-parsing after
//       each: { text, findings: [string], applied: number }
//   relativeImport(fromFile, toFile)   the import specifier from one
//       repo-relative file to another ("../contracts/auth.js")
//   parseProblem(path, text)           undefined when the text parses, else why
//
// A target selects functions: a name string, a RegExp on the name, a
// predicate (fn) => boolean, or an object { name?, exported?, kind?, async?,
// pattern? (RegExp on the header), where? (predicate) } whose fields all hold.
// A statement (and wrapBody's before/after) is a string, or (fn) => string to
// derive it from the function (for example its first parameter name);
// returning undefined or "" skips that function.

import * as nodeModule from "node:module";
import { posix } from "node:path";

const KEYWORDS_BEFORE_EXPR = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "extends",
]);

const NOT_A_METHOD = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "do", "else", "typeof", "new", "await", "yield", "super", "import", "export", "class", "throw", "delete", "void", "in", "of", "instanceof"]);
const METHOD_PREFIX = new Set(["async", "static", "get", "set", "public", "private", "protected", "readonly", "override"]);

const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

function lineCol(src, at) {
  const before = src.slice(0, at);
  const line = before.split("\n").length;
  return `line ${line}`;
}

/**
 * Tokenize JS/TS source: names, punctuation, strings, templates, regexes, and
 * numbers, with comments skipped and every bracket matched (`match` on an
 * opening and closing bracket token is the index of its partner).
 * Returns { tokens, error } (error: why the text is not well formed).
 */
export function tokenize(src) {
  const tokens = [];
  const stack = [];
  const n = src.length;
  let i = 0;
  if (src.startsWith("#!")) {
    const e = src.indexOf("\n");
    i = e < 0 ? n : e;
  }
  const fail = (message, at) => ({ tokens, error: `${message} (${lineCol(src, at)})` });
  const push = (type, value, start, end) => {
    tokens.push({ type, value, start, end });
    return tokens.length - 1;
  };
  const regexAllowed = () => {
    const t = tokens[tokens.length - 1];
    if (!t) return true;
    if (t.type === "punct") return !(t.value === ")" || t.value === "]" || t.value === "}");
    if (t.type === "name") return KEYWORDS_BEFORE_EXPR.has(t.value);
    if (t.type === "template") return t.value.endsWith("${");
    return false;
  };
  // Scan template characters from i; stops after the closing backtick or after "${".
  const scanTemplate = () => {
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i += 1;
        return "end";
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        return "interp";
      }
      i += 1;
    }
    return "eof";
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c) || c === "﻿") {
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) return fail("unterminated comment", i);
      i = e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "\n") return fail("unterminated string", start);
        i += 1;
      }
      if (i >= n) return fail("unterminated string", start);
      i += 1;
      push("string", src.slice(start, i), start, i);
      continue;
    }
    if (c === "`") {
      const start = i;
      i += 1;
      const r = scanTemplate();
      if (r === "eof") return fail("unterminated template literal", start);
      push("template", r === "interp" ? "`${" : "``", start, i);
      if (r === "interp") stack.push({ open: "${", at: start, index: -1 });
      continue;
    }
    if (c === "/" && regexAllowed()) {
      const start = i;
      i += 1;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "\n") return fail("unterminated regular expression", start);
        if (inClass) {
          if (d === "]") inClass = false;
        } else if (d === "[") {
          inClass = true;
        } else if (d === "/") {
          break;
        }
        i += 1;
      }
      if (i >= n) return fail("unterminated regular expression", start);
      i += 1;
      while (i < n && /[A-Za-z]/.test(src[i])) i += 1;
      push("regex", src.slice(start, i), start, i);
      continue;
    }
    if (/[A-Za-z_$]/.test(c) || c > "\u007f") {
      const start = i;
      while (i < n && (/[\w$]/.test(src[i]) || src[i] > "\u007f")) i += 1;
      push("name", src.slice(start, i), start, i);
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const start = i;
      while (i < n && /[\w.]/.test(src[i])) i += 1;
      push("number", src.slice(start, i), start, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push({ open: c, at: i, index: push("punct", c, i, i + 1) });
      i += 1;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (!top) return fail(`unexpected '${c}'`, i);
      if (top.open === "${") {
        if (c !== "}") return fail(`expected '}' to close a template expression but found '${c}'`, i);
        const start = i;
        i += 1;
        const r = scanTemplate();
        if (r === "eof") return fail("unterminated template literal", start);
        push("template", r === "interp" ? "}${" : "}`", start, i);
        if (r === "interp") stack.push({ open: "${", at: start, index: -1 });
        continue;
      }
      const want = top.open === "(" ? ")" : top.open === "[" ? "]" : "}";
      if (c !== want) return fail(`expected '${want}' (opened at ${lineCol(src, top.at)}) but found '${c}'`, i);
      const k = push("punct", c, i, i + 1);
      tokens[k].match = top.index;
      tokens[top.index].match = k;
      i += 1;
      continue;
    }
    if (c === "=" && src[i + 1] === ">") {
      push("punct", "=>", i, i + 2);
      i += 2;
      continue;
    }
    if (c === "." && src[i + 1] === "." && src[i + 2] === ".") {
      push("punct", "...", i, i + 3);
      i += 3;
      continue;
    }
    push("punct", c, i, i + 1);
    i += 1;
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return fail(`'${top.open}' is never closed`, top.at);
  }
  return { tokens, error: undefined };
}

/** Why a source text does not parse (undefined when it does). JSON via JSON.parse; JS/TS via Node's parser and the token check. */
export function parseProblem(path, text) {
  if (/\.json$/i.test(path)) {
    try {
      JSON.parse(text);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  const { error } = tokenize(text);
  if (error) {
    return error;
  }
  if (/\.(?:[cm]?[jt]s)$/i.test(path) && typeof nodeModule.stripTypeScriptTypes === "function") {
    // The parser announces itself as experimental on stderr; that line is noise in a tool's output.
    const emit = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      if (!/stripTypeScriptTypes/.test(String(warning?.message ?? warning))) emit.call(process, warning, ...rest);
    };
    try {
      nodeModule.stripTypeScriptTypes(text, { mode: "transform" });
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      process.emitWarning = emit;
    }
  }
  return undefined;
}

const isTok = (tokens, k, value) => tokens[k] !== undefined && tokens[k].value === value && (tokens[k].type === "punct" || tokens[k].type === "name");
const isName = (tokens, k) => tokens[k] !== undefined && tokens[k].type === "name";

/** Skip a `<...>` generic list starting at k (tokens[k] is "<"); returns the index after it. */
function skipAngles(tokens, k) {
  let depth = 0;
  for (let j = k; j < tokens.length; j += 1) {
    const t = tokens[j];
    if (t.type === "punct" && (t.value === "(" || t.value === "[" || t.value === "{")) {
      j = t.match;
      continue;
    }
    if (t.type === "punct" && t.value === "<") depth += 1;
    if (t.type === "punct" && t.value === ">") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    if (t.type === "punct" && t.value === ";") return -1;
  }
  return -1;
}

const TYPE_LEAD = new Set([":", "|", "&", "<", ",", "=>", "(", "[", "?"]);

/** The index of a function body's "{" after its parameter list's ")" (an optional `: Type` between), or -1. */
function blockAfterParams(tokens, close) {
  let k = close + 1;
  if (!isTok(tokens, k, ":")) {
    return isTok(tokens, k, "{") ? k : -1;
  }
  k += 1;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "punct" && t.value === "{") {
      const prev = tokens[k - 1];
      if (prev.type === "punct" && TYPE_LEAD.has(prev.value)) {
        k = t.match + 1; // an object type
        continue;
      }
      return k;
    }
    if (t.type === "punct" && (t.value === "(" || t.value === "[")) {
      k = t.match + 1;
      continue;
    }
    if (t.type === "punct" && (t.value === ";" || t.value === "=" || t.value === "=>" || t.value === "}" || t.value === ")")) return -1;
    k += 1;
  }
  return -1;
}

/** The index of an arrow body's "{" after its parameter list's ")" (an optional `: Type` then "=>"), or -1 (an expression body). */
function blockAfterArrowParams(tokens, close) {
  let k = close + 1;
  if (isTok(tokens, k, ":")) {
    k += 1;
    while (k < tokens.length && !isTok(tokens, k, "=>")) {
      const t = tokens[k];
      if (t.type === "punct" && (t.value === "(" || t.value === "[" || t.value === "{")) {
        k = t.match + 1;
        continue;
      }
      if (t.type === "punct" && (t.value === ";" || t.value === "=" || t.value === ")" || t.value === "}")) return -1;
      k += 1;
    }
  }
  return isTok(tokens, k, "=>") && isTok(tokens, k + 1, "{") ? k + 1 : -1;
}

/** Top-level parameter names between an opening "(" at `open` and its match (null for a destructured one). */
function paramNames(tokens, open) {
  const close = tokens[open].match;
  const out = [];
  let expecting = true;
  for (let k = open + 1; k < close; k += 1) {
    const t = tokens[k];
    if (expecting) {
      if (t.type === "punct" && t.value === "...") continue;
      if (t.type === "name" && METHOD_PREFIX.has(t.value) && isName(tokens, k + 1)) continue; // TS parameter properties
      if (t.type === "name") out.push(t.value);
      else if (t.type === "punct" && (t.value === "{" || t.value === "[")) out.push(null);
      expecting = false;
    }
    if (t.type === "punct" && (t.value === "(" || t.value === "[" || t.value === "{")) {
      k = t.match;
      continue;
    }
    if (t.type === "punct" && t.value === ",") expecting = true;
  }
  return out;
}

/** The modifiers before token k: export, default, async (in source order, any subset). */
function leadOf(tokens, k) {
  let s = k;
  let isAsync = false;
  let isDefault = false;
  let exported = false;
  if (isTok(tokens, s - 1, "async")) {
    isAsync = true;
    s -= 1;
  }
  if (isTok(tokens, s - 1, "default")) {
    isDefault = true;
    s -= 1;
  }
  if (isTok(tokens, s - 1, "export")) {
    exported = true;
    s -= 1;
  }
  return { start: s, isAsync, isDefault, exported };
}

function locate(text, tokens, record) {
  const open = tokens[record.bodyTok];
  const close = tokens[open.match];
  const start = tokens[record.startTok].start;
  return {
    name: record.name,
    kind: record.kind,
    exported: record.exported,
    isDefault: record.isDefault,
    async: record.isAsync,
    params: record.params,
    header: text.slice(start, open.start).trim(),
    body: text.slice(open.start + 1, close.start),
    line: text.slice(0, start).split("\n").length,
    start,
    bodyOpen: open.start,
    bodyClose: close.start,
  };
}

/**
 * The functions with a block body in a JS/TS source text, in source order:
 * declarations (`[export] [default] [async] function name(...) {`), arrow
 * and function expressions bound to a const/let/var, and methods (class and
 * object-literal). An unparsable text has none.
 */
export function functions(text) {
  const { tokens, error } = tokenize(text);
  if (error) {
    return [];
  }
  const records = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type !== "name") continue;
    // function declarations and function expressions
    if (t.value === "function" && !isTok(tokens, k - 1, ".")) {
      let j = k + 1;
      if (isTok(tokens, j, "*")) j += 1;
      let name = isName(tokens, j) ? tokens[j].value : undefined;
      if (name !== undefined) j += 1;
      if (isTok(tokens, j, "<")) j = skipAngles(tokens, j);
      if (j < 0 || !isTok(tokens, j, "(")) continue;
      const body = blockAfterParams(tokens, tokens[j].match);
      if (body < 0) continue;
      const lead = leadOf(tokens, k);
      let startTok = lead.start;
      let exported = lead.exported;
      let isDefault = lead.isDefault;
      const kind = "function";
      // `const x = [async] function ...`: named by its binding.
      if (isTok(tokens, lead.start - 1, "=") && isName(tokens, lead.start - 2) && ["const", "let", "var"].includes(tokens[lead.start - 3]?.value)) {
        name ??= tokens[lead.start - 2].value;
        startTok = lead.start - 3;
        exported = isTok(tokens, startTok - 1, "export");
        if (exported) startTok -= 1;
        isDefault = false;
      }
      records.push({ name, kind, exported, isDefault, isAsync: lead.isAsync, params: paramNames(tokens, j), startTok, bodyTok: body });
      continue;
    }
    // const name = [async] (params) => {   or   const name = [async] param => {
    if ((t.value === "const" || t.value === "let" || t.value === "var") && isName(tokens, k + 1)) {
      let j = k + 2;
      if (isTok(tokens, j, ":")) {
        while (j < tokens.length && !isTok(tokens, j, "=") && !isTok(tokens, j, ";")) {
          const u = tokens[j];
          j = u.type === "punct" && (u.value === "(" || u.value === "[" || u.value === "{") ? u.match + 1 : j + 1;
        }
      }
      if (!isTok(tokens, j, "=")) continue;
      j += 1;
      let isAsync = false;
      if (isTok(tokens, j, "async") && !isTok(tokens, j + 1, "=>")) {
        isAsync = true;
        j += 1;
      }
      if (isTok(tokens, j, "<")) j = skipAngles(tokens, j);
      let body = -1;
      let params = [];
      if (j >= 0 && isTok(tokens, j, "(")) {
        body = blockAfterArrowParams(tokens, tokens[j].match);
        params = paramNames(tokens, j);
      } else if (isName(tokens, j) && isTok(tokens, j + 1, "=>") && isTok(tokens, j + 2, "{")) {
        body = j + 2;
        params = [tokens[j].value];
      }
      if (body < 0) continue;
      const exported = isTok(tokens, k - 1, "export");
      records.push({ name: tokens[k + 1].value, kind: "arrow", exported, isDefault: false, isAsync, params, startTok: exported ? k - 1 : k, bodyTok: body });
      continue;
    }
    // methods: name(params) {  after "{", ",", ";", "}", "*", or a modifier
    if ((!NOT_A_METHOD.has(t.value) && !METHOD_PREFIX.has(t.value)) || (METHOD_PREFIX.has(t.value) && isTok(tokens, k + 1, "("))) {
      let j = k + 1;
      if (isTok(tokens, j, "<")) j = skipAngles(tokens, j);
      if (j < 0 || !isTok(tokens, j, "(")) continue;
      let s = k;
      let isAsync = false;
      if (isTok(tokens, s - 1, "*")) s -= 1;
      while (isName(tokens, s - 1) && METHOD_PREFIX.has(tokens[s - 1].value)) {
        if (tokens[s - 1].value === "async") isAsync = true;
        s -= 1;
      }
      const before = tokens[s - 1];
      if (before !== undefined && !(before.type === "punct" && ["{", ",", ";", "}"].includes(before.value))) continue;
      if (isTok(tokens, k - 1, ".") || isTok(tokens, k - 1, "function")) continue;
      const body = blockAfterParams(tokens, tokens[j].match);
      if (body < 0) continue;
      records.push({ name: t.value, kind: "method", exported: false, isDefault: false, isAsync, params: paramNames(tokens, j), startTok: s, bodyTok: body });
    }
  }
  records.sort((a, b) => tokens[a.bodyTok].start - tokens[b.bodyTok].start);
  return records.map((r) => locate(text, tokens, r));
}

/** Whether a function matches a target (see the module comment). */
export function matches(fn, target) {
  if (typeof target === "function") return Boolean(target(fn));
  if (typeof target === "string") return fn.name === target;
  if (target instanceof RegExp) {
    target.lastIndex = 0;
    return fn.name !== undefined && target.test(fn.name);
  }
  if (target === null || typeof target !== "object") return false;
  if (target.name !== undefined) {
    if (target.name instanceof RegExp) {
      target.name.lastIndex = 0;
      if (fn.name === undefined || !target.name.test(fn.name)) return false;
    } else if (fn.name !== target.name) return false;
  }
  if (target.exported !== undefined && fn.exported !== target.exported) return false;
  if (target.kind !== undefined && fn.kind !== target.kind) return false;
  if (target.async !== undefined && fn.async !== target.async) return false;
  if (target.pattern instanceof RegExp) {
    target.pattern.lastIndex = 0;
    if (!target.pattern.test(fn.header)) return false;
  }
  if (typeof target.where === "function" && !target.where(fn)) return false;
  return true;
}

/** Edit descriptors (data; applyEdits performs them). */
export function insertAtStart(target, statement) {
  return { op: "insert-start", target, statement };
}
export function wrapBody(target, before, after) {
  return { op: "wrap-body", target, before, after };
}
export function addImport(spec) {
  return { op: "add-import", spec };
}
export function replaceOnce(find, replacement) {
  return { op: "replace-once", find, replacement };
}

/** The import specifier from one repo-relative file to another (`./x.js`, `../contracts/auth.js`). */
export function relativeImport(fromFile, toFile) {
  const rel = posix.relative(posix.dirname(fromFile), toFile);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

const squash = (s) => String(s).replace(/\s+/g, "");
const lineStartAt = (text, at) => text.lastIndexOf("\n", at - 1) + 1;
const indentAt = (text, at) => /^[ \t]*/.exec(text.slice(lineStartAt(text, at)))[0];

function bodyIndent(text, fn) {
  const m = /\n([ \t]*)\S/.exec(fn.body);
  if (m) return m[1];
  return `${indentAt(text, fn.start)}  `;
}

/** A (possibly multi-line) snippet re-indented to `indent`, keeping its relative indentation (the first line may be written flush). */
function indentBlock(snippet, indent) {
  const lines = String(snippet).replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n");
  const width = (l) => /^[ \t]*/.exec(l)[0].length;
  const rest = lines.slice(1).filter((l) => l.trim() !== "");
  const min = rest.length > 0 ? Math.min(...rest.map(width)) : 0;
  return lines.map((l, i) => (l.trim() === "" ? "" : indent + (i === 0 ? l.trimStart() : l.slice(Math.min(min, width(l)))))).join("\n");
}

const resolveText = (value, fn) => {
  const out = typeof value === "function" ? value(fn) : value;
  return out === undefined || out === null ? "" : String(out);
};

function insertInto(text, fn, statement) {
  const block = indentBlock(statement, bodyIndent(text, fn));
  const inner = fn.body;
  let next;
  if (inner.trim() === "") {
    next = `\n${block}\n${indentAt(text, fn.start)}`;
  } else if (/^[ \t]*\n/.test(inner)) {
    next = `\n${block}${inner.replace(/^[ \t]*/, "")}`;
  } else {
    next = `\n${block}\n${bodyIndent(text, fn)}${inner.replace(/^[ \t]+/, "")}`;
  }
  return text.slice(0, fn.bodyOpen + 1) + next + text.slice(fn.bodyClose);
}

function wrapInto(text, fn, before, after) {
  const ind = bodyIndent(text, fn);
  const outer = indentAt(text, fn.start);
  const unit = ind.length > outer.length ? ind.slice(outer.length) : "  ";
  const core = fn.body.replace(/^[ \t]*\n/, "").replace(/\s+$/, "");
  // Re-indent only when no string or template in the body spans lines (re-indenting one would change its value).
  const { tokens } = tokenize(fn.body);
  const multiline = tokens.some((t) => (t.type === "template" || t.type === "string") && fn.body.slice(t.start, t.end).includes("\n"));
  const moved = multiline ? core : core.split("\n").map((l) => (l.trim() === "" ? "" : unit + l)).join("\n");
  const next = `\n${indentBlock(before, ind)}\n${moved}\n${indentBlock(after, ind)}\n${outer}`;
  return text.slice(0, fn.bodyOpen + 1) + next + text.slice(fn.bodyClose);
}

/** The import declarations of a source text: { start, end, source, names, hasDefault, braceOpen, braceClose, quote, semi }. */
function importsOf(text) {
  const { tokens, error } = tokenize(text);
  if (error) return [];
  const out = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    // Static imports are top-level only; import(...) and import.meta are expressions.
    if (t.type !== "name" || t.value !== "import") continue;
    if (isTok(tokens, k + 1, "(") || isTok(tokens, k + 1, ".") || isTok(tokens, k - 1, ".")) continue;
    let j = k + 1;
    const names = [];
    let hasDefault = false;
    let braceOpen;
    let braceClose;
    let source;
    while (j < tokens.length) {
      const u = tokens[j];
      if (u.type === "string") {
        source = u.value.slice(1, -1);
        break;
      }
      if (u.type === "punct" && u.value === "{") {
        braceOpen = u.start;
        braceClose = tokens[u.match].start;
        for (let m = j + 1; m < u.match; m += 1) {
          const v = tokens[m];
          if (v.type === "name" && v.value !== "as" && v.value !== "type") names.push(v.value);
        }
        j = u.match + 1;
        continue;
      }
      if (u.type === "name" && u.value !== "from" && u.value !== "type" && u.value !== "as" && braceOpen === undefined && !isTok(tokens, j - 1, "*") && !isTok(tokens, j - 1, "as")) {
        hasDefault = true;
        names.push(u.value);
      }
      if (u.type === "name" && isTok(tokens, j - 1, "as")) names.push(u.value);
      if (u.type === "punct" && u.value === ";") break;
      j += 1;
    }
    if (source === undefined) continue;
    let end = tokens[j].end;
    const semi = isTok(tokens, j + 1, ";");
    if (semi) end = tokens[j + 1].end;
    out.push({ start: t.start, end, source, names, hasDefault, braceOpen, braceClose, quote: tokens[j].value[0], semi });
    k = j;
  }
  return out;
}

function importInto(text, spec) {
  if (spec === null || typeof spec !== "object" || typeof spec.from !== "string" || spec.from === "") {
    throw new Error("addImport needs { from, names?, default? }");
  }
  const names = Array.isArray(spec.names) ? spec.names.map(String) : [];
  const def = typeof spec.default === "string" && spec.default !== "" ? spec.default : undefined;
  const all = importsOf(text);
  const same = all.filter((d) => d.source === spec.from);
  const have = new Set(same.flatMap((d) => d.names));
  const missing = names.filter((name) => !have.has(name));
  const needDefault = def !== undefined && !same.some((d) => d.hasDefault);
  if (missing.length === 0 && !needDefault) {
    return text; // already imported
  }
  const braced = same.find((d) => d.braceOpen !== undefined);
  if (!needDefault && braced) {
    const inner = text.slice(braced.braceOpen + 1, braced.braceClose);
    const trimmed = inner.replace(/\s+$/, "");
    const glue = trimmed.trim() === "" ? " " : trimmed.endsWith(",") ? " " : ", ";
    const tailSpace = inner.slice(trimmed.length) || " ";
    return text.slice(0, braced.braceOpen + 1) + trimmed + glue + missing.join(", ") + tailSpace + text.slice(braced.braceClose);
  }
  const quote = all[0]?.quote ?? '"';
  const semi = all.length === 0 || all.some((d) => d.semi) ? ";" : "";
  const clause = [needDefault ? def : undefined, missing.length > 0 ? `{ ${missing.join(", ")} }` : undefined].filter(Boolean).join(", ");
  const line = `import ${clause} from ${quote}${spec.from}${quote}${semi}`;
  if (all.length > 0) {
    const last = all[all.length - 1];
    return `${text.slice(0, last.end)}\n${line}${text.slice(last.end)}`;
  }
  // No import yet: before the first token (after a hashbang and leading comments).
  const { tokens } = tokenize(text);
  const first = tokens.find((t) => !(t.type === "string" && /^["']use strict["']$/.test(t.value)));
  if (!first) {
    return `${text.replace(/\s*$/, "")}${text.trim() === "" ? "" : "\n"}${line}\n`;
  }
  const at = lineStartAt(text, first.start);
  return `${text.slice(0, at)}${line}\n${text.slice(at)}`;
}

function describe(target) {
  if (typeof target === "string") return target;
  if (target instanceof RegExp) return String(target);
  if (typeof target === "function") return "a predicate";
  try {
    return JSON.stringify(target, (k, v) => (v instanceof RegExp ? String(v) : typeof v === "function" ? "fn" : v));
  } catch {
    return "a target";
  }
}

/**
 * Apply edits to one file's text, in order. The text must parse before any
 * edit (otherwise it is left as it was, with a finding); every edit's result
 * is re-parsed and an edit that would break the file is skipped with a
 * finding. Returns { text, findings, applied } (applied: edits that changed
 * the text; an edit already in place is a no-op, not a finding).
 */
export function applyEdits(path, text, edits) {
  const findings = [];
  const list = Array.isArray(edits) ? edits : edits ? [edits] : [];
  const script = SCRIPT.test(path);
  const initial = script || /\.json$/i.test(path) ? parseProblem(path, text) : undefined;
  if (initial !== undefined) {
    return { text, findings: [`${path} does not parse before any edit (${initial}); left as it was`], applied: 0 };
  }
  let current = text;
  let applied = 0;
  const accept = (candidate, label) => {
    if (candidate === current) return false;
    const problem = script || /\.json$/i.test(path) ? parseProblem(path, candidate) : undefined;
    if (problem !== undefined) {
      findings.push(`${label}: the result would not parse (${problem}); skipped`);
      return false;
    }
    current = candidate;
    return true;
  };
  for (const edit of list) {
    if (edit === null || typeof edit !== "object" || typeof edit.op !== "string") {
      findings.push("not an edit (build edits with insertAtStart, wrapBody, addImport, or replaceOnce); skipped");
      continue;
    }
    try {
      if (edit.op === "replace-once") {
        const find = String(edit.find ?? "");
        const replacement = String(edit.replacement ?? "");
        if (find === "") {
          findings.push("replaceOnce: an empty snippet; skipped");
          continue;
        }
        // Already replaced: the replacement is there and (when it contains the snippet) that is the only reason the snippet is.
        if (replacement !== "" && replacement.includes(find) && current.includes(replacement)) continue;
        let count = 0;
        for (let at = current.indexOf(find); at >= 0; at = current.indexOf(find, at + find.length)) count += 1;
        if (count === 0) {
          // Already replaced: the snippet is gone and its replacement is there, exactly once.
          if (replacement !== "" && current.indexOf(replacement) >= 0 && current.indexOf(replacement) === current.lastIndexOf(replacement)) continue;
          findings.push(`replaceOnce: ${JSON.stringify(find.slice(0, 60))} was not found; skipped`);
          continue;
        }
        if (count > 1) {
          findings.push(`replaceOnce: ${JSON.stringify(find.slice(0, 60))} matches ${count} places (ambiguous); refused`);
          continue;
        }
        const at = current.indexOf(find);
        if (accept(current.slice(0, at) + replacement + current.slice(at + find.length), "replaceOnce")) applied += 1;
        continue;
      }
      if (!script) {
        findings.push(`${edit.op}: ${path} is not a JavaScript or TypeScript file; skipped`);
        continue;
      }
      if (edit.op === "add-import") {
        if (accept(importInto(current, edit.spec), `addImport ${edit.spec?.from ?? ""}`)) applied += 1;
        continue;
      }
      if (edit.op === "insert-start" || edit.op === "wrap-body") {
        const count = functions(current).filter((fn) => matches(fn, edit.target)).length;
        if (count === 0) {
          findings.push(`${edit.op}: no function matches ${describe(edit.target)}`);
          continue;
        }
        let changed = false;
        // Last to first, re-finding each time, so an edit never shifts a target still to come.
        for (let idx = count - 1; idx >= 0; idx -= 1) {
          const matched = functions(current).filter((fn) => matches(fn, edit.target));
          if (matched.length !== count) {
            findings.push(`${edit.op}: the edit changed which functions match ${describe(edit.target)}; stopped`);
            break;
          }
          const fn = matched[idx];
          const label = `${edit.op} ${fn.name ?? "(anonymous)"} (line ${fn.line})`;
          if (edit.op === "insert-start") {
            const statement = resolveText(edit.statement, fn);
            if (statement.trim() === "" || squash(fn.body).includes(squash(statement))) continue;
            changed = accept(insertInto(current, fn, statement), label) || changed;
          } else {
            const before = resolveText(edit.before, fn);
            const after = resolveText(edit.after, fn);
            if (before.trim() === "" && after.trim() === "") continue;
            const body = squash(fn.body);
            if (body.startsWith(squash(before)) && body.endsWith(squash(after))) continue;
            changed = accept(wrapInto(current, fn, before, after), label) || changed;
          }
        }
        if (changed) applied += 1;
        continue;
      }
      findings.push(`unknown edit ${edit.op}; skipped`);
    } catch (error) {
      findings.push(`${edit.op}: ${error instanceof Error ? error.message : String(error)}; skipped`);
    }
  }
  return { text: current, findings, applied };
}

/**
 * The most telling line of a gate's output, for a failing revision's reason.
 * Pure (no I/O), so the local integrator, the integration job that runs in a
 * container, and the control plane all name a failure the same way.
 */

/**
 * The most telling line of a gate's output: an error (`SyntaxError: ...`,
 * `AssertionError ...`), a failing test line, else undefined. npm/yarn/pnpm
 * command echoes (`> ...`) are never it.
 */
export function gateFailureLine(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^[>$] /.test(l) && !/^npm (error|ERR!)/.test(l));
  return (
    // An install that failed means the gate never ran: that is the reason.
    lines.find((l) => /^dependency install failed:/.test(l)) ??
    // A type checker's error (tsc: `src/a.ts(4,2): error TS2339: ...`) names its location first.
    lines.find((l) => /\(\d+,\d+\): error TS\d+:/.test(l) || /^error TS\d+:/.test(l)) ??
    lines.find((l) => /^\w*(Error|Exception)\b(\s*\[[A-Z_]+\])?:/.test(l)) ??
    lines.find((l) => /^(not ok\b|✖|FAIL\b|--- FAIL)/.test(l) && !/^✖ failing tests:/.test(l)) ??
    lines.find((l) => /\b(Error|Exception):/.test(l))
  );
}

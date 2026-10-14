/**
 * The live console's two views, addressed by the URL so links and reload work:
 *
 *   /                    HOME: the templates and the runs table
 *   ?run=<change id>     the RUN page of a run launched by this console
 *   ?watch=<change id>   the RUN page of a run started from the CLI, read-only
 *
 * Pure (no React, no window), so it is tested offline.
 */

import type { LaunchMode } from "./templates";

/** Where the console is. */
export type ConsoleRoute =
  | { readonly kind: "home" }
  | {
      readonly kind: "run";
      readonly changeId: string;
      /** Followed read-only (?watch=): not launched here. */
      readonly watch: boolean;
    };

/** A CLI change id (?watch=): `change-...`, lowercase. */
const WATCH_ID = /^change-[a-z0-9-]{1,64}$/;

/** A launched (or CLI) change id (?run=): the launcher's `console-<template>-<stamp>` or a CLI `change-...`. */
const RUN_ID = /^(?:console|change)-[A-Za-z0-9._-]{1,120}$/;

/** The route a URL query names; anything malformed is home. */
export function routeFromSearch(search: string): ConsoleRoute {
  const params = new URLSearchParams(search);
  const watch = params.get("watch");
  if (watch !== null && WATCH_ID.test(watch)) {
    return { kind: "run", changeId: watch, watch: true };
  }
  const run = params.get("run");
  if (run !== null && RUN_ID.test(run)) {
    return { kind: "run", changeId: run, watch: false };
  }
  return { kind: "home" };
}

/** The link to a run page (?run= for a launched run, ?watch= for a CLI run). */
export function runHref(changeId: string, watch: boolean): string {
  return `?${watch ? "watch" : "run"}=${encodeURIComponent(changeId)}`;
}

/** The home link: the console's own path with no query. */
export function homeHref(pathname = "/"): string {
  return pathname === "" ? "/" : pathname;
}

/**
 * The replay page's base URL for "Open replay": VITE_REPLAY_URL when it is an
 * http(s) URL or a same-origin path (starting with "/"), else null (the link
 * is hidden with a hint: the replay page is a separate build, served by
 * `npm -w apps/console run dev:replay` on its own port in dev).
 */
export function replayBaseUrl(configured: string | undefined): string | null {
  const value = configured?.trim() ?? "";
  if (value === "") return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** The replay page link for a recorded run (the replay page reads ?run=<id>). */
export function replayHref(base: string, runId: string): string {
  const [path, query = ""] = base.split("?", 2) as [string, string?];
  const params = new URLSearchParams(query);
  params.set("run", runId);
  return `${path}?${params.toString()}`;
}

/** A launched run as GET /api/runs lists it. */
export interface LaunchedRunSummary {
  readonly changeId: string;
  readonly templateId: string;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly mode: LaunchMode;
  readonly startedAt: string;
  readonly repoDir?: string;
  readonly promoted?: { readonly branch: string; readonly commit: string };
  readonly fixed?: { readonly url: string; readonly commit: string };
  readonly publish?: { readonly kind: "publishing" } | { readonly kind: "failed"; readonly error: string; readonly output?: readonly string[] };
}

/** The well-formed runs of a GET /api/runs body (anything malformed is skipped). */
export function readLaunchedRuns(body: unknown): { readonly runs: LaunchedRunSummary[]; readonly active: string | null } {
  const b = (body ?? {}) as { runs?: unknown; active?: unknown };
  const runs = Array.isArray(b.runs)
    ? (b.runs as unknown[]).filter((r): r is LaunchedRunSummary => {
        const x = r as Partial<LaunchedRunSummary> | null;
        return (
          x !== null &&
          typeof x === "object" &&
          typeof x.changeId === "string" &&
          typeof x.templateId === "string" &&
          (x.status === "running" || x.status === "exited") &&
          typeof x.startedAt === "string"
        );
      })
    : [];
  return { runs, active: typeof b.active === "string" ? b.active : null };
}

/**
 * Whether a Worker snapshot says the run is over: an integration verdict is
 * recorded, or planning failed. The console uses this only for a run it did
 * not launch (?watch=), which the launcher cannot know about.
 */
export function snapshotFinished(snapshot: unknown): boolean {
  const s = (snapshot ?? {}) as { integration?: unknown; status?: unknown };
  return (s.integration !== null && typeof s.integration === "object") || s.status === "planning-failed";
}

/** The run the home page treats as in progress, if any. */
export interface ActiveRun {
  readonly changeId: string;
  readonly href: string;
  /** "launcher": a run this console launched (the launcher refuses a second); "watch": a CLI run the Worker reports unfinished. */
  readonly source: "launcher" | "watch";
}

/** The active run for the UI: the launcher's, else a followed CLI run the Worker reports unfinished. */
export function activeRunFor(launcherActive: string | null, watched: { readonly changeId: string; readonly finished: boolean } | null): ActiveRun | null {
  if (launcherActive !== null) {
    return { changeId: launcherActive, href: runHref(launcherActive, false), source: "launcher" };
  }
  if (watched !== null && !watched.finished) {
    return { changeId: watched.changeId, href: runHref(watched.changeId, true), source: "watch" };
  }
  return null;
}

/** Where the console remembers the last run it followed with ?watch= (so home can list it). */
export const WATCHED_STORAGE_KEY = "switchyard.watched";

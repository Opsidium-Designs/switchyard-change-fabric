/**
 * The gate container's egress policy, per phase of an integration job.
 *
 * The container starts with internet access OFF; the only hosts it can reach
 * are the ones the GateRunner intercepts (the Artifacts host and the package
 * registry), and every intercepted request is decided here:
 *
 *   fetch  the Artifacts host, only the repos the job names, GET/POST (git
 *          smart HTTP); the request gets that repo's short-lived token as an
 *          Authorization header (the container never holds a token)
 *   deps   the package registry only, GET/HEAD, no credential
 *   gate   nothing
 *   push   the Artifacts host again, as in fetch (the trusted push of the gated
 *          commit to its candidate ref)
 *   closed nothing (before and after a job)
 *
 * "Revoking" a phase is replacing the handler's props with the next phase's:
 * the policy in force is always exactly one of these. Pure: no I/O.
 */

import type { EgressPhase } from "@switchyard-change/verification/integrate-job";

/** The default package registry the deps phase may reach. */
export const DEFAULT_REGISTRY_HOST = "registry.npmjs.org";

/** The props the egress handler is registered with. */
export interface GateEgressProps {
  readonly phase: EgressPhase | "closed";
  readonly artifactsHost: string;
  readonly registryHost: string;
  /** Repo path (`/git/<namespace>/<name>.git`) to the token for it. */
  readonly repos: Readonly<Record<string, string>>;
}

/** What the handler does with one request. */
export type EgressDecision =
  | { readonly allow: false; readonly reason: string }
  | { readonly allow: true; readonly url: string; readonly headers: Headers };

/** A one-word label of what a phase allows (recorded in the evidence). */
export function egressLabel(phase: EgressPhase | "closed"): string {
  switch (phase) {
    case "fetch":
    case "push":
      return "artifacts-only";
    case "deps":
      return "registry-only";
    default:
      return "deny-all";
  }
}

/** The repo path of a clone URL (`https://host/git/ns/name.git` -> `/git/ns/name.git`). */
export function repoPathOf(gitUrl: string): string {
  const url = new URL(gitUrl);
  return url.pathname.replace(/\/+$/, "");
}

/** The host of a clone URL. */
export function repoHostOf(gitUrl: string): string {
  return new URL(gitUrl).hostname;
}

const STRIPPED = ["authorization", "proxy-authorization", "cookie"];

function cleanHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of STRIPPED) {
    headers.delete(name);
  }
  return headers;
}

/** Decide one intercepted request against the policy in force. */
export function decideEgress(props: GateEgressProps, method: string, rawUrl: string, requestHeaders: Headers): EgressDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allow: false, reason: "not a URL" };
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return { allow: false, reason: "only plain https requests are relayed" };
  }
  const phase = props.phase;
  if (phase === "fetch" || phase === "push") {
    if (url.hostname !== props.artifactsHost) {
      return { allow: false, reason: `phase ${phase} allows only the Artifacts host` };
    }
    if (method !== "GET" && method !== "POST") {
      return { allow: false, reason: `phase ${phase} relays only git smart HTTP (GET/POST)` };
    }
    const path = url.pathname;
    const repo = Object.keys(props.repos).find((p) => path === p || path.startsWith(`${p}/`));
    if (repo === undefined) {
      return { allow: false, reason: "the job names no such repo" };
    }
    const headers = cleanHeaders(requestHeaders);
    headers.set("authorization", `Bearer ${props.repos[repo]}`);
    return { allow: true, url: url.toString(), headers };
  }
  if (phase === "deps") {
    if (url.hostname !== props.registryHost) {
      return { allow: false, reason: "phase deps allows only the package registry" };
    }
    if (method !== "GET" && method !== "HEAD") {
      return { allow: false, reason: "phase deps relays only GET/HEAD" };
    }
    return { allow: true, url: url.toString(), headers: cleanHeaders(requestHeaders) };
  }
  return { allow: false, reason: phase === "gate" ? "the gate runs with no network" : "no job is running" };
}

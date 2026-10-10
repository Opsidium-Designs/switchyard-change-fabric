/**
 * token-refresh: keep agents' short-lived repo tokens valid for runs longer
 * than one token lifetime.
 *
 * Each agent pushes to its own Artifact repo (and a helper to its fork) with a
 * repo-scoped write token that expires (the join asks for an explicit TTL).
 * Before a token expires (its expiry minus a margin, on an injected clock),
 * the refresher asks the Worker for a FRESH token for the same agent and repo
 * (the agent-token route, under the operator's bearer), swaps it in for every
 * later git call, records `token.refreshed {agent, kind}` on the board (never
 * the token), and revokes the old token only once a grace period has passed
 * on the same clock (default 60 s, configurable), so a push already in flight
 * with the old token is not cut off however soon the next tick comes. The
 * margin is clamped to at most half the token lifetime, so a short-lived token
 * is not refreshed on every tick. A failure is reported, never thrown: the old
 * token stays in use until it expires.
 */

import type { BoardOperatorClient } from "./board-client.ts";
import { redactSecrets } from "./redact.ts";

/** One agent's token the refresher keeps valid. */
export interface RefreshableToken {
  readonly agent: string;
  readonly kind: "repo-write" | "help-fork";
  /** The help request whose fork this token writes (help-fork only). */
  readonly request?: string;
  readonly tokenId: string;
  /** The token's expiry (ISO). */
  readonly expiresAt: string;
  /** Swap a fresh token in for every later git call. */
  swap(fresh: { readonly token: string; readonly tokenId: string; readonly tokenExpiresAt: string }): void;
}

/** Options for a refresher. */
export interface TokenRefresherOptions {
  readonly operator: Pick<BoardOperatorClient, "agentToken" | "revokeReadToken" | "recordEngine">;
  /** The lifetime each fresh token asks for, in seconds. */
  readonly ttlSeconds: number;
  /**
   * Refresh this long before expiry (default: max(60 s, a fifth of the
   * lifetime)); clamped to at most half the lifetime.
   */
  readonly marginMs?: number;
  /** How long a replaced token stays valid before it is revoked (default 60 s). */
  readonly graceMs?: number;
  /** The clock (default Date.now): injected in tests. */
  readonly now?: () => number;
  /** Every credential the run handles (a fresh token joins it, so text that leaves the run is scrubbed). */
  readonly secrets?: Set<string>;
  readonly onRefresh?: (event: { readonly agent: string; readonly kind: "repo-write" | "help-fork"; readonly request?: string }) => void;
  readonly onFailure?: (reason: string) => void;
}

/** Refreshes tokens before they expire (see the module comment). */
/** The default time a replaced token stays valid (an in-flight push keeps working). */
export const DEFAULT_REVOKE_GRACE_MS = 60_000;

export class TokenRefresher {
  private pendingRevokes: { agent: string; tokenId: string; help?: string; revokeAfter: number }[] = [];
  /** Refreshes done so far. */
  refreshed = 0;

  constructor(private readonly options: TokenRefresherOptions) {}

  /** The margin before expiry at which a token is refreshed (at most half the lifetime). */
  get marginMs(): number {
    const lifetime = this.options.ttlSeconds * 1000;
    const wanted = this.options.marginMs ?? Math.max(60_000, Math.floor(lifetime / 5));
    return Math.min(wanted, Math.floor(lifetime / 2));
  }

  /** How long a replaced token stays valid before it is revoked. */
  get graceMs(): number {
    return Math.max(0, this.options.graceMs ?? DEFAULT_REVOKE_GRACE_MS);
  }

  /** Revoke the replaced tokens whose grace has passed, then refresh every token due now. Returns how many were refreshed. */
  async tick(tokens: readonly RefreshableToken[]): Promise<number> {
    const now = (this.options.now ?? Date.now)();
    const due = this.pendingRevokes.filter((p) => now >= p.revokeAfter);
    this.pendingRevokes = this.pendingRevokes.filter((p) => now < p.revokeAfter);
    for (const old of due) {
      await this.options.operator.revokeReadToken(old.agent, old.tokenId, old.help).catch(() => false);
    }
    let count = 0;
    for (const token of tokens) {
      const expires = Date.parse(token.expiresAt);
      if (!Number.isFinite(expires) || now < expires - this.marginMs) {
        continue;
      }
      let fresh: Awaited<ReturnType<TokenRefresherOptions["operator"]["agentToken"]>>;
      try {
        fresh = await this.options.operator.agentToken(token.agent, this.options.ttlSeconds, token.request !== undefined ? { help: token.request } : {});
      } catch (error) {
        this.options.onFailure?.(redactSecrets(`could not refresh ${token.agent}'s ${token.kind} token: ${error instanceof Error ? error.message : String(error)}`));
        continue;
      }
      if (!fresh.ok) {
        this.options.onFailure?.(redactSecrets(`could not refresh ${token.agent}'s ${token.kind} token (${fresh.code}): ${fresh.error}`));
        continue;
      }
      this.options.secrets?.add(fresh.token);
      const oldId = token.tokenId;
      token.swap({ token: fresh.token, tokenId: fresh.tokenId, tokenExpiresAt: fresh.tokenExpiresAt });
      this.pendingRevokes.push({ agent: token.agent, tokenId: oldId, revokeAfter: now + this.graceMs, ...(token.request !== undefined ? { help: token.request } : {}) });
      await this.options.operator
        .recordEngine("token.refreshed", { agent: token.agent, kind: token.kind, ...(token.request !== undefined ? { request: token.request } : {}) })
        .catch(() => undefined);
      this.refreshed += 1;
      count += 1;
      this.options.onRefresh?.({ agent: token.agent, kind: token.kind, ...(token.request !== undefined ? { request: token.request } : {}) });
    }
    return count;
  }

  /** Revoke what is still pending, grace or not (the run is over). */
  async flush(): Promise<void> {
    const all = this.pendingRevokes;
    this.pendingRevokes = [];
    for (const old of all) {
      await this.options.operator.revokeReadToken(old.agent, old.tokenId, old.help).catch(() => false);
    }
  }
}

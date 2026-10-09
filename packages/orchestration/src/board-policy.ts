/**
 * board-policy: a deterministic, goal-agnostic stand-in for the model behind an
 * agent turn. It is the fake turn transport offline runs and tests use, so a
 * board run is reproducible with no network.
 *
 * The policy reads only what a live model reads (the agent's digest, its own
 * past decisions, the public board facts, and the repo listing) and applies
 * generic rules, in priority order:
 *   1. the lead decides pending contracts (accept unless the target overlaps a
 *      write intent held by someone other than the proposer), else waits;
 *   2. answer an open contest: as the claimant, narrow the overlapping part of
 *      the write intent to the concrete files nobody else holds (cede when
 *      nothing is left); as the owner, keep once;
 *   3. reply to a help request or question addressed to the agent;
 *   4. after narrowing in a contest, ask the other party (a `to`-addressed
 *      question) about the scope they now share a boundary on;
 *   5. fix a held item a failing revision asked it to fix (an edit carrying the
 *      revision), edit a held item that has no push yet, then propose it done;
 *   6. while free, claim the first open item it has not been refused, with the
 *      item's scope hint as the write intent; a claim refused because it
 *      touches the contract (existing tests, gate config) proposes a contract
 *      change per protected entry, waits for the decision, and claims again;
 *   7. otherwise wait.
 * No rule names a file, an app, or a goal: the same policy runs unchanged on any
 * repo.
 */

import {
  entriesOverlap,
  hasWildcard,
  intentPath,
  overlappingEntries,
  type BoardDigest,
  type BoardMessage,
} from "@switchyard-change/change-core";
import type {
  AgentAction,
  AgentTurnInput,
  AgentTurnOutcome,
  AgentTurnTransport,
} from "@switchyard-change/model-adapters";
import { matchesGlob } from "@switchyard-change/verification";

type Input = AgentTurnInput<BoardDigest, BoardMessage>;

/** The write intent the agent asked for in its latest claim of `item`. */
function claimedWrite(input: Input, item: string): readonly string[] | undefined {
  for (let i = input.capsule.decisions.length - 1; i >= 0; i -= 1) {
    const action = input.capsule.decisions[i]!.action;
    if (action.type === "claim" && action.itemId === item) {
      return action.intent.write;
    }
  }
  return undefined;
}

/**
 * Narrow a write intent away from an overlap: entries that do not overlap are
 * kept; an overlapping glob is replaced by the concrete files it names that no
 * other agent's live claim covers. Every result stays within the original.
 */
function narrowed(input: Input, write: readonly string[], overlap: readonly string[]): string[] {
  const others = input.board.liveClaims.filter((c) => c.owner !== input.agent).flatMap((c) => c.write);
  const out: string[] = [];
  for (const entry of write) {
    if (!overlap.includes(entry)) {
      out.push(entry);
      continue;
    }
    const path = intentPath(entry);
    if (!hasWildcard(path)) {
      continue;
    }
    for (const file of input.repo.files) {
      if (matchesGlob(file, path) && !others.some((o) => entriesOverlap(file, o)) && !out.includes(file)) {
        out.push(file);
      }
    }
  }
  return out;
}

function decide(input: Input): AgentAction {
  const d = input.digest;
  const me = input.agent;
  const decisions = input.capsule.decisions;

  if (input.role === "lead") {
    // Contracts on the original tests or the gate's configuration are a
    // human's to decide; the lead decides only the others.
    const contract = input.board.pendingContracts.find((c) => !c.protected);
    if (contract) {
      const clash = input.board.liveClaims.some(
        (c) => c.owner !== contract.proposedBy && c.write.some((w) => entriesOverlap(w, contract.target)),
      );
      return {
        type: "decide_contract",
        contractId: contract.contract,
        decision: clash ? "reject" : "accept",
        rationale: clash
          ? `${contract.target} is inside another agent's claimed write intent`
          : `${contract.target} is not held by anyone but the proposer`,
      };
    }
    return { type: "wait", reason: "no contract awaits a decision" };
  }

  // 2. Contests the agent is party to.
  for (const contest of d.contests) {
    if (contest.status !== "open") {
      continue;
    }
    if (contest.claimant === me) {
      const write = claimedWrite(input, contest.item) ?? contest.overlap;
      const narrower = narrowed(input, write, overlappingEntries(write, contest.overlap));
      return narrower.length > 0
        ? {
            type: "contest_reply",
            contestId: contest.id,
            reply: "narrow",
            write: narrower,
            rationale: `narrowing to what ${contest.owner} does not hold`,
          }
        : { type: "contest_reply", contestId: contest.id, reply: "cede", rationale: "nothing is left once the overlap is removed" };
    }
    if (contest.owner === me && contest.turns === 0) {
      return { type: "contest_reply", contestId: contest.id, reply: "keep", rationale: `item ${contest.ownerItem} is already granted to me` };
    }
  }

  // 3. Answer requests addressed to me.
  const answered = new Set(
    decisions.flatMap((h) => (h.action.type === "message" && h.action.kind === "reply" && h.action.payload.requestId ? [h.action.payload.requestId] : [])),
  );
  for (const m of input.messages) {
    if (m.type === "help.requested" && m.to?.includes(me) && !answered.has(m.payload.request)) {
      return {
        type: "message",
        kind: "reply",
        to: [m.from],
        payload: { requestId: m.payload.request },
        rationale: `answering ${m.from} on item ${m.payload.item}: my write intent stays as granted; yours is clear of it`,
      };
    }
  }

  // 4. After narrowing, ask the other party about the shared boundary.
  const asked = new Set(
    decisions.flatMap((h) => (h.action.type === "message" && h.action.kind === "question" && h.outcome === "posted" ? [h.note?.to ?? ""] : [])),
  );
  for (const h of decisions) {
    const owner = h.note?.owner;
    const item = h.note?.item;
    if (
      h.action.type === "contest_reply" &&
      h.action.reply === "narrow" &&
      h.outcome === "posted" &&
      owner !== undefined &&
      item !== undefined &&
      !asked.has(owner) &&
      d.claims.some((c) => c.item === item)
    ) {
      return {
        type: "message",
        kind: "question",
        to: [owner],
        payload: { itemId: item, need: "shared-boundary" },
        rationale: `I narrowed item ${item} away from your write intent; tell me if you also need any file I kept`,
      };
    }
  }

  // 5. Work on held items: a requested fix first.
  for (const claim of d.claims) {
    if (claim.fix !== undefined) {
      const failedFixes = decisions.filter(
        (h) => h.action.type === "edit" && h.action.itemId === claim.item && h.outcome !== "posted" && h.note?.fix === String(claim.fix!.n),
      ).length;
      if (failedFixes < 2) {
        return {
          type: "edit",
          itemId: claim.item,
          instruction: `Fix what failed the integration gate on revision ${claim.fix.n} (attempt ${claim.fix.attempt}): ${claim.objective}`,
        };
      }
    }
  }
  for (const claim of d.claims) {
    // No push yet, or only the previous owner's (a handed-off item): edit it.
    if (!claim.lastPush || claim.lastPush.agent !== me) {
      const failedEdits = decisions.filter((h) => h.action.type === "edit" && h.action.itemId === claim.item && h.outcome !== "posted").length;
      if (failedEdits >= 2) {
        continue;
      }
      return { type: "edit", itemId: claim.item, instruction: `Implement: ${claim.objective}` };
    }
    if (!claim.doneProposed) {
      return { type: "propose_done", itemId: claim.item, rationale: `pushed ${claim.lastPush.commit}` };
    }
  }

  // 6. Claim the first open item not already refused. A claim refused because
  //    it touches the contract (PROTECTED) goes through the contract route:
  //    propose the change for each protected entry it needs, wait for the
  //    decision, then claim once more (a second PROTECTED refusal gives up).
  const free = d.pending.length === 0 && d.claims.every((c) => c.doneProposed && c.fix === undefined);
  if (free) {
    for (const open of d.openItems.filter((i) => i.scopeHint.length > 0)) {
      const claims = decisions.filter((h) => h.action.type === "claim" && h.action.itemId === open.item);
      const last = claims.at(-1);
      if (last === undefined || last.outcome === "posted") {
        return {
          type: "claim",
          itemId: open.item,
          intent: { read: [], write: [...open.scopeHint] },
          rationale: `taking the first open item; writing its scope hint`,
        };
      }
      const protectedRefusals = claims.filter((h) => h.outcome === "rejected" && h.code === "PROTECTED").length;
      if (last.code !== "PROTECTED" || protectedRefusals >= 3 || last.action.type !== "claim") {
        continue;
      }
      const write = last.action.intent.write;
      const hits = d.protected.filter((p) => write.some((w) => entriesOverlap(w, p)));
      // A human already said no for this item (the board refuses repeat
      // proposals with CONTRACT_REJECTED): go straight to a new test file.
      const contractRefused = decisions.some(
        (h) => h.action.type === "message" && h.action.kind === "contract" && h.action.payload.itemId === open.item && h.code === "CONTRACT_REJECTED",
      );
      if (protectedRefusals === 2 || contractRefused) {
        // The human did not release every path: add a NEW test file instead,
        // beside the first protected test, named after the item.
        const first = hits.find((p) => !/[*?]/.test(p));
        const suffix = first ? /(\.(test|spec)\.[A-Za-z0-9]+)$/.exec(first)?.[1] : undefined;
        if (first && suffix) {
          const dir = first.includes("/") ? first.slice(0, first.lastIndexOf("/") + 1) : "";
          const fresh = `${dir}${open.item}${suffix}`;
          if (!d.protected.includes(fresh)) {
            return {
              type: "claim",
              itemId: open.item,
              intent: { read: [], write: [fresh] },
              rationale: "the existing tests stay as they are; adding a new test file instead",
            };
          }
        }
        continue;
      }
      const proposed = decisions.flatMap((h) =>
        h.action.type === "message" && h.action.kind === "contract" && h.action.payload.itemId === open.item && h.outcome === "posted"
          ? [h.action.payload.target ?? ""]
          : [],
      );
      // One contract per protected path the claim needs, each a concrete path
      // from the contract (a human decides each).
      // Another agent already asked for this item: wait for the human's answer.
      if (input.board.pendingContracts.some((c) => c.item === open.item && c.proposedBy !== me)) {
        continue;
      }
      const needed = hits.filter((p) => !proposed.includes(p));
      if (needed.length > 0) {
        return {
          type: "message",
          kind: "contract",
          payload: { target: needed[0]!, change: "modify", itemId: open.item },
          rationale: `item ${open.item} needs to change ${needed[0]}, which is part of the original tests or the gate's configuration`,
        };
      }
      if (input.board.pendingContracts.some((c) => c.proposedBy === me && c.item === open.item)) {
        continue; // waiting for the lead or a human to decide
      }
      return {
        type: "claim",
        itemId: open.item,
        intent: { read: [], write: [...write] },
        rationale: "claiming again now that the contract change was decided",
      };
    }
  }
  return { type: "wait", reason: free ? "no open item I can claim" : "waiting on the board" };
}

/** The deterministic generic policy as a turn transport. */
export function createGenericBoardPolicy(): AgentTurnTransport<BoardDigest, BoardMessage> {
  return async (input): Promise<AgentTurnOutcome> => ({ action: decide(input), model: "generic-policy" });
}

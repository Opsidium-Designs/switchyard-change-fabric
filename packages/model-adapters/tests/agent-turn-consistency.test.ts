/**
 * Schema, prompt, and validator stay in step. A live model answers in the
 * strict JSON schema and its reply goes through the REAL transport parser
 * (agentActionOrWait); offline policies build actions directly and never do,
 * so drift between the three (a field the prompt asks for that the validator
 * refuses) is caught only here. Every check below goes through the parser.
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_ACTION_TYPES,
  AGENT_MESSAGE_KINDS,
  AGENT_TURN_JSON_SCHEMA,
  agentActionOrWait,
  buildAgentTurnMessages,
  type AgentActionType,
  type AgentTurnInput,
} from "../src/index.ts";

interface Schema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly items?: Schema;
  readonly anyOf?: readonly Schema[];
}

const variants = (AGENT_TURN_JSON_SCHEMA.properties.action.anyOf as unknown as readonly Schema[]).map((v) => ({
  type: (v.properties!.type!.enum as readonly string[])[0] as AgentActionType,
  schema: v,
}));
const variantOf = (type: string): Schema => variants.find((v) => v.type === type)!.schema;
const payloadSchema = variantOf("message").properties!.payload!;

const LEAD_ONLY: readonly AgentActionType[] = ["decide_contract", "decide_item"];
const WORKER: readonly AgentActionType[] = AGENT_ACTION_TYPES.filter((t) => !LEAD_ONLY.includes(t));
const LEAD: readonly AgentActionType[] = ["decide_contract", "decide_item", "propose_item", "message", "wait"];

/** A schema-valid value for a field, by its name (ids, paths, capabilities, enums). */
function sample(schema: Schema, name: string): unknown {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.enum) {
    return schema.enum.find((v) => v !== null);
  }
  if (types.includes("boolean")) {
    return true;
  }
  if (types.includes("object")) {
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, s]) => [k, sample(s, k)]));
  }
  if (types.includes("array")) {
    const byName: Record<string, unknown[]> = { to: ["agent-2"], outputs: ["findings"], acceptance: ["it works"] };
    return byName[name] ?? [sample(schema.items!, name === "children" ? "child" : "path")];
  }
  const strings: Record<string, string> = {
    capability: "codemod-guard",
    need: "shared-boundary",
    target: "src/store.ts",
    path: "src/a.ts",
    version: "1",
  };
  return strings[name] ?? (/Id$|^(toAgent|volunteer)$/.test(name) ? "id-1" : "some text");
}

/** A strict reply: every schema property present, the ones not given set to null (absent). */
function strict(type: AgentActionType, given: Record<string, unknown>): { action: Record<string, unknown> } {
  const props = variantOf(type).properties!;
  const action: Record<string, unknown> = { type };
  for (const key of Object.keys(props)) {
    if (key !== "type") action[key] = key in given ? given[key] : null;
  }
  if (type === "message") {
    const payload = (given.payload ?? {}) as Record<string, unknown>;
    action.payload = Object.fromEntries(Object.keys(payloadSchema.properties!).map((k) => [k, k in payload ? payload[k] : null]));
  }
  return { action };
}

function parsed(reply: unknown, allowed: readonly AgentActionType[] = WORKER) {
  const outcome = agentActionOrWait(reply, allowed);
  expect(outcome.invalid, JSON.stringify(reply)).toBeUndefined();
  return outcome.action;
}

describe("the strict schema and the validator accept the same replies", () => {
  it("every action variant, with EVERY field the schema offers filled in, validates", () => {
    for (const { type, schema } of variants) {
      if (type === "message") continue;
      const reply = { action: sample(schema, "action") as Record<string, unknown> };
      expect(parsed(reply, AGENT_ACTION_TYPES).type).toBe(type);
    }
  });

  it("every message kind, with every payload field the schema offers filled in, validates (a new schema field the validator refuses fails here)", () => {
    const full = sample(payloadSchema, "payload") as Record<string, unknown>;
    expect(Object.keys(full)).toContain("description");
    for (const kind of AGENT_MESSAGE_KINDS) {
      const action = parsed(strict("message", { kind, to: ["agent-2"], rationale: "why", payload: full }));
      expect(action).toMatchObject({ type: "message", kind });
    }
  });

  it("every nullable field may be null (strict mode's 'absent')", () => {
    for (const { type } of variants) {
      if (type === "message") continue;
      const required = Object.fromEntries(
        Object.entries(variantOf(type).properties!)
          .filter(([k, s]) => k !== "type" && !(Array.isArray(s.type) && s.type.includes("null")))
          .map(([k, s]) => [k, k === "accept" ? false : sample(s, k)]),
      );
      expect(parsed(strict(type, required), AGENT_ACTION_TYPES).type).toBe(type);
    }
  });

  it("still refuses a field no schema lists", () => {
    const reply = strict("message", { kind: "contract", rationale: "r", payload: { target: "src/a.ts", change: "modify" } });
    (reply.action.payload as Record<string, unknown>).surprise = 1;
    expect(agentActionOrWait(reply).invalid).toMatch(/unknown field "surprise"/);
  });
});

describe("every field the prompt tells the model to send is in the schema and accepted", () => {
  const base: AgentTurnInput = {
    agent: "agent-1",
    role: "worker",
    goal: "g",
    digest: {},
    messages: [],
    capsule: { objective: "g", constraints: [], decisions: [], evidence: [] },
    board: { liveClaims: [], pendingContracts: [] },
    repo: { files: [], excerpts: [] },
    allowed: AGENT_ACTION_TYPES,
  };
  const system = [base, { ...base, role: "lead" as const }].map((input) => String(buildAgentTurnMessages(input)[0]!.content)).join("\n");

  it("the `kind {field, ...}` and `action {field, ...}` forms in the rules name only schema fields", () => {
    const forms = [...system.matchAll(/(?:message kind (\w+)|\b([a-z_]+)) \{([^{}]*)\}/g)];
    let checked = 0;
    for (const [, kind, action, body] of forms) {
      const props = kind !== undefined ? payloadSchema.properties! : (AGENT_ACTION_TYPES as readonly string[]).includes(action!) ? variantOf(action!).properties! : undefined;
      if (!props) continue;
      for (const part of body!.split(",")) {
        const field = /^\s*([A-Za-z]+)/.exec(part)?.[1];
        if (field === undefined) continue;
        expect(Object.keys(props), `${kind ?? action} {${body}} names ${field}`).toContain(field);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("the prompt's examples, written as a model would (strict, nulls for unused fields), all validate", () => {
    const examples: [AgentActionType, Record<string, unknown>, (readonly AgentActionType[])?][] = [
      // SEAM CONTRACT: a change to a shared seam, with the exact change.
      [
        "message",
        {
          kind: "contract",
          rationale: "TS2339 on Ctx: the shared seam lacks the field",
          payload: { target: "src/store.ts", change: "modify", itemId: "unit-orders-cart", description: "add an optional `user: User` field to the Ctx type" },
        },
      ],
      // A protected-test contract (no description).
      ["message", { kind: "contract", rationale: "the test pins the old rounding", payload: { target: "tests/tax.test.ts", change: "modify", itemId: "unit-tax" } }],
      ["message", { kind: "help", rationale: "two files left", payload: { itemId: "unit-a", need: "parallel-edit", scope: ["src/a/x.ts"] } }],
      ["message", { kind: "question", to: ["agent-2"], rationale: "who owns the boundary?", payload: { itemId: "unit-a", need: "shared-boundary" } }],
      ["message", { kind: "reply", rationale: "taking it", payload: { requestId: "agent-2-help-1" } }],
      ["message", { kind: "review", rationale: "please review", payload: { itemId: "unit-a" } }],
      ["message", { kind: "review", rationale: "found one", payload: { reviewId: "r1", findings: [{ kind: "failing-test", path: "tests/a.test.ts" }] } }],
      ["offer_help", { itemId: "unit-a", toAgent: "agent-2", why: "I am idle and know this module" }],
      ["answer_volunteer", { itemId: "unit-a", volunteer: "agent-3", accept: true, scope: ["src/a/y.ts"], rationale: "take y" }],
      ["answer_volunteer", { itemId: "unit-a", volunteer: "agent-3", accept: false }],
      ["pull", { itemId: "unit-a" }],
      ["pull", { itemId: "unit-a", requestId: "agent-1-help-1" }],
      ["pull", { itemId: "unit-a", requestId: "agent-1-help-1", decline: true }],
      ["split", { itemId: "unit-a", children: [{ objective: "x", acceptance: ["x works"], scopeHint: ["src/a/x.ts"] }], rationale: "two sub-changes" }],
      ["use_tool", { capability: "codemod-guard", version: "1", args: ["src/a.js"], itemId: "guard-a" }],
      ["build_tool", { capability: "codemod-guard" }],
      ["propose_tool", { capability: "codemod-guard", kind: "codemod", why: "same edit in 9 files", inputs: ["src/**/*.ts"], outputs: ["edits"] }],
      ["claim", { itemId: "unit-a", intent: { read: [], write: ["src/a.ts"] } }],
      ["edit", { itemId: "unit-a", instruction: "fix what failed revision 3" }],
      ["propose_done", { itemId: "unit-a" }],
      ["propose_item", { objective: "cap refunds", acceptance: ["refunds cap"], scopeHint: ["src/billing/refunds.ts"], fromTool: { capability: "scan-guard", version: "1" } }],
      ["contest_reply", { contestId: "contest-4", reply: "narrow", write: ["src/a/x.ts"] }],
      ["wait", { reason: "nothing to do" }],
      ["decide_contract", { contractId: "agent-1-contract-1", decision: "accept", rationale: "additive optional field" }, LEAD],
      ["decide_item", { itemId: "agent-2-item-1", decision: "reject", rationale: "duplicates unit-a" }, LEAD],
    ];
    const covered = new Set(examples.map(([type]) => type));
    expect([...covered].sort()).toEqual([...AGENT_ACTION_TYPES].sort());
    for (const [type, given, allowed] of examples) {
      const action = parsed(strict(type, given), allowed ?? WORKER);
      expect(action.type).toBe(type);
    }
    const seam = parsed(strict("message", examples[0]![1]));
    expect(seam).toMatchObject({ payload: { target: "src/store.ts", description: "add an optional `user: User` field to the Ctx type" } });
  });

  it("a long description is shortened, never a reason to drop the turn", () => {
    const action = parsed(strict("message", { kind: "contract", rationale: "r", payload: { target: "src/store.ts", change: "modify", itemId: "u", description: "x".repeat(2000) } }));
    expect(action.type === "message" ? action.payload.description?.length : 0).toBe(400);
  });
});

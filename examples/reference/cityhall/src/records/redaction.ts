// cityhall records: redaction before release.
//
// Routes (staff only):
//   POST /records/redaction {text}            the text with personal data masked
//   GET  /records/redaction?limit=&offset=    the log of redactions
//
// Masked: social security numbers (123-45-6789 as [SSN]), email addresses
// ([EMAIL]), and US phone numbers in the forms (555) 123-4567, 555-123-4567,
// and 555.123.4567 ([PHONE]). The reply counts each kind. Text is at most
// 10000 characters.

import { requireStaff } from "../contracts/auth.ts";
import { json, notFound, problem, readBody } from "../contracts/http.ts";
import { pageOf, readPage, text } from "../contracts/validate.ts";
import type { Ctx } from "../store.ts";

const PATTERNS = [
  { kind: "ssn", mask: "[SSN]", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "email", mask: "[EMAIL]", pattern: /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g },
  { kind: "phone", mask: "[PHONE]", pattern: /(\(\d{3}\)\s?|\b\d{3}[-.])\d{3}[-.]\d{4}\b/g },
] as const;

export type Counts = Record<(typeof PATTERNS)[number]["kind"], number>;

export interface RedactionLog {
  id: string;
  staffId: string;
  counts: Counts;
}

/** Mask the personal data in a text. */
export function redact(input: string): { redacted: string; counts: Counts } {
  const counts: Counts = { ssn: 0, email: 0, phone: 0 };
  let redacted = input;
  for (const { kind, mask, pattern } of PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      counts[kind] += 1;
      return mask;
    });
  }
  return { redacted, counts };
}

export async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { store, url, rest } = ctx;
  const log = store.table<RedactionLog>("redactionLog");
  const staff = requireStaff(request);
  if (staff instanceof Response) return staff;
  if (rest.length === 0 && request.method === "GET") {
    const page = readPage(url);
    if (page instanceof Response) return page;
    return json(pageOf(log, page));
  }
  if (rest.length === 0 && request.method === "POST") {
    const body = await readBody(request);
    const input = text(body.text, 10_000);
    if (!input) {
      return problem(400, "text is required (at most 10000 characters)");
    }
    const result = redact(input);
    log.push({ id: store.nextId("red"), staffId: staff.id, counts: result.counts });
    return json(result);
  }
  return notFound();
}

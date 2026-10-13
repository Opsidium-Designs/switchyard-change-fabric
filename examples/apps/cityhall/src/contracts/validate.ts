// cityhall SHARED validate contract.
//
// Field checks every route module uses on request input. Each returns the
// clean value, or null when the input is invalid (the module answers 400).
//
//   text(v, max)          a non-blank string of at most max characters, trimmed
//   positiveCents(v)      a positive safe integer
//   intIn(v, min, max)    an integer within [min, max]
//   date(v)               a real calendar date "YYYY-MM-DD"
//   month(v)              a real month "YYYY-MM"
//   instant(v)            an ISO 8601 timestamp with a Z or +hh:mm offset
//   choice(v, options)    one of the allowed strings
//
// And the ONE pagination rule every list endpoint shares:
//
//   readPage(url)         { limit, offset } from the query string (default
//                         limit 20, offset 0), or a Response to return as is
//   pageOf(items, page)   the shared list body { items, total, limit, offset }

export interface Page {
  limit: number;
  offset: number;
}

export const DEFAULT_LIMIT = 20;

/** The page a list request asks for. */
export function readPage(url: URL): Page | Response {
  const limit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  return { limit, offset };
}

/** The shared list body. */
export function pageOf<T>(items: readonly T[], page: Page): { items: T[]; total: number; limit: number; offset: number } {
  return {
    items: items.slice(page.offset, page.offset + page.limit),
    total: items.length,
    limit: page.limit,
    offset: page.offset,
  };
}

/** A non-blank string of at most `max` characters, trimmed. */
export function text(value: unknown, max = 200): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** A positive safe integer number of cents. */
export function positiveCents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** An integer within [min, max]. */
export function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** A real calendar date "YYYY-MM-DD". */
export function date(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}

/** A real month "YYYY-MM". */
export function month(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value) && date(`${value}-01`) ? value : null;
}

/** An ISO 8601 timestamp with an explicit Z or +hh:mm offset. */
export function instant(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/** One of the allowed strings. */
export function choice<T extends string>(value: unknown, options: readonly T[]): T | null {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : null;
}

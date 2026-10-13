// Tool results: compact JSON as text, the same object as structuredContent, and a hard size cap.

export type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

export type Result = { [key: string]: Json };

/** The most characters of JSON a tool returns. About 6,000 tokens. */
export const MAX_RESPONSE_CHARS = 24_000;

const size = (value: Json) => (value === undefined ? 0 : JSON.stringify(value).length);

/**
 * Cuts a result down to `max` characters of JSON: the largest top-level array is cut to the share
 * of it that fits (at most half at a time) until the result fits, then the longest top-level
 * string is cut. What was dropped, and how to ask for it,
 * goes in `truncated`.
 */
export function capped(result: Result, hint: string, max = MAX_RESPONSE_CHARS): Result {
  if (size(result) <= max) return result;
  const out: Result = { ...result };
  const dropped: Record<string, { shown: number; total: number }> = {};

  // Leave room for the `truncated` note itself.
  const budget = max - 400;

  for (let pass = 0; pass < 64; pass++) {
    const total = size(out);

    if (total <= budget) break;

    // Each member is measured once a pass: measuring is the expensive part of a large result.
    const sizes = Object.entries(out).map(([key, value]): [string, Json, number] => [key, value, size(value)]);
    const [key, list, bytes] = sizes.filter((entry): entry is [string, Json[], number] => Array.isArray(entry[1]) && entry[1].length > 1).sort((a, b) => b[2] - a[2])[0] ?? [];

    if (key && list && bytes) {
      // Keep the share of it that fits, and at most half, so a list far over the cap is cut in a few passes.
      const fits = Math.floor((list.length * Math.max(0, bytes - (total - budget))) / bytes);
      const shown = Math.max(1, Math.min(fits, Math.ceil(list.length / 2)));

      dropped[key] = { shown, total: dropped[key]?.total ?? list.length };
      out[key] = list.slice(0, shown);
      continue;
    }

    const [longest, text] = sizes.filter((entry): entry is [string, string, number] => typeof entry[1] === 'string' && entry[1].length > 200).sort((a, b) => b[1].length - a[1].length)[0] ?? [];

    if (!longest || text === undefined) break;
    const keep = Math.max(200, text.length - (total - budget) - 20);

    dropped[longest] = { shown: keep, total: text.length };
    out[longest] = `${text.slice(0, keep)}…`;
  }

  // Nothing left to cut by halves: keep only the scalars.
  if (size(out) > budget) {
    for (const [key, value] of Object.entries(out)) {
      if (typeof value === 'object' && value !== null) {
        dropped[key] = { shown: 0, total: Array.isArray(value) ? value.length : 1 };
        delete out[key];
      }
    }
  }

  out.truncated = { reason: `The full result is over ${max} characters.`, dropped, hint };

  return out;
}

export interface ToolResponse {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: Result;
}

/** `undefined` members are left out, so the text and the structured content are the same object. */
export function respond(result: Result, hint = 'Narrow the request.'): ToolResponse {
  const text = JSON.stringify(capped(result, hint));
  // INVARIANT: JSON.parse of JSON.stringify of an object is an object of JSON values.
  const structuredContent = JSON.parse(text) as Result;

  return { content: [{ type: 'text', text }], structuredContent };
}

/** What a tool answers when the library configured no data for it. */
export function notAvailable(what: string, option: string): Result {
  return { available: false, reason: `Not available: this library configured no ${what}.`, enableWith: `The \`${option}\` option of mcpOutputTarget().` };
}

/** A typed value as plain JSON, for a result. */
export function plain(value: object): Json {
  // INVARIANT: every value passed here came from index.json, so it is JSON.
  return JSON.parse(JSON.stringify(value)) as Json;
}

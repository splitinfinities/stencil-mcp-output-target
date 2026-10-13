import type { Capabilities, ToolName } from '../src/types.ts';
import type { Library } from './library.ts';
import type { Json, Result } from './respond.ts';

/** A JSON Schema, as far as the tools use it. */
export interface Schema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  maxProperties?: number;
  default?: string | number | boolean;
}

/** Arguments the SDK has already validated against the tool's input schema. */
export type Args = Record<string, Json>;

export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  input: { properties: Record<string, Schema>; required?: string[] };
  /** The result's documented members. Every result may also carry the shared ones (`found`, `available`, `truncated`, …). */
  output: Record<string, Schema>;
  /** The section of the index the tool reads. Without it, the tool answers "not available". */
  requires?: { capability: keyof Capabilities; what: string; option: string };
  /** How to ask for less, shown when a result is cut at the size cap. */
  hint?: string;
  run(library: Library, args: Args): Result;
}

export const text = (value: Json): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

export const integer = (value: Json, fallback: number, min: number, max: number): number => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback);

export const strings = (value: Json): string[] => (Array.isArray(value) ? value.flatMap((item) => (typeof item === 'string' ? [item] : [])) : []);

export const TAG: Schema = { type: 'string', description: 'A component tag, e.g. my-button. The prefix may be left out.' };

const STRINGS: Schema = { type: 'array', items: { type: 'string' } };

/** Members any result may carry. */
export const SHARED_OUTPUT: Record<string, Schema> = {
  found: { type: 'boolean', description: 'false when the tag is not a component of this library; see `suggestions`.' },
  available: { type: 'boolean', description: 'false when the library configured no data for this tool; see `reason` and `enableWith`.' },
  reason: { type: 'string' },
  enableWith: { type: 'string' },
  message: { type: 'string' },
  suggestions: STRINGS,
  truncated: { type: 'object', description: 'Present when the result was cut at the size cap: what was dropped and how to ask for it.' },
};

export const LIST = (items: Schema = { type: 'object' }, description?: string): Schema => (description ? { type: 'array', items, description } : { type: 'array', items });

// Input limits. Every tool's cost grows with its input, and over HTTP one slow call holds up
// every client, so nothing a caller sends is unbounded. A limit a tool doesn't set itself is
// filled in by `bounded()`; the SDK rejects an input over one before the tool runs.

/** The most markup `validate_component_usage` and `diagnose_component` read at once. */
export const MAX_CODE_CHARS = 200_000;

/** A name, a query, a sentence. */
export const MAX_TEXT_CHARS = 1_000;

export const MAX_ITEMS = 100;

/** The most array elements and object members one call's arguments may hold, at any depth. */
export const MAX_INPUT_ELEMENTS = 1_000;

/** An input schema with a limit on every string, array and object in it. */
export function bounded(schema: Schema): Schema {
  const out: Schema = { ...schema };

  if (schema.type === 'string' && !schema.enum) out.maxLength ??= MAX_TEXT_CHARS;

  if (schema.type === 'array') out.maxItems ??= MAX_ITEMS;

  if (schema.type === 'object') out.maxProperties ??= MAX_ITEMS;

  if (schema.items) out.items = bounded(schema.items);

  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, property]) => [name, bounded(property)]));

  if (typeof schema.additionalProperties === 'object') out.additionalProperties = bounded(schema.additionalProperties);

  return out;
}

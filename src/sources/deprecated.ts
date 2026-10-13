import type { Deprecation } from '../types.ts';

// The documented forms:
//   @deprecated Use <my-dialog> instead     a replacement tag
//   @deprecated Use `size` instead          a replacement prop (or event, or method)
// Anything else is kept verbatim, without a replacement.
const TAG = /^use\s+`?<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[^>]*>/i;

const MEMBER = /^use\s+`([A-Za-z_$][\w$-]*)`/i;

/** Reads a `@deprecated` text. `on` says what is deprecated: a tag can only be replaced by a tag, a member by a member. */
export function parseDeprecation(text: string, on: 'tag' | 'member'): Deprecation {
  const trimmed = text.trim();
  const tag = trimmed.match(TAG)?.[1];
  const member = trimmed.match(MEMBER)?.[1];

  if (on === 'tag' && tag) return { text: trimmed, replacement: { kind: 'tag', name: tag } };

  if (on === 'member' && member) return { text: trimmed, replacement: { kind: 'prop', name: member } };

  return { text: trimmed };
}

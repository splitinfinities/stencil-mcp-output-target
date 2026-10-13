import type { TokenEntry } from '../types.ts';

// A custom property declaration. Its description is the comment after it on the same line
// (`--space-xs: 0.5rem; /* 8px */`), or else a comment on the line or lines directly above it.
const DECLARATION = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+?)\s*(?:;|(?=\}))(?:[ \t]*\/\*((?:[^*\n]|\*(?!\/))*)\*\/)?/g;

/** A comment that ends the text, standing on its own lines. */
const COMMENT_ABOVE = /(?:^|\n)[ \t]*\/\*((?:[^*]|\*(?!\/))*)\*\/[ \t]*\n[ \t]*$/;

const tidy = (text: string) => text.replace(/\s*\n\s*\*?\s*/g, ' ').replace(/\s+/g, ' ').trim();

/** Every custom property a stylesheet declares. The first declaration of a name wins (later ones are overrides, as for dark mode). */
export function cssTokens(css: string, source: string): TokenEntry[] {
  const seen = new Map<string, TokenEntry>();

  for (const match of css.matchAll(DECLARATION)) {
    const [, name, value, after] = match;

    if (seen.has(name)) continue;
    const entry: TokenEntry = { name, value: tidy(value), source };
    const description = tidy(after ?? css.slice(0, match.index).match(COMMENT_ABOVE)?.[1] ?? '');

    if (description) entry.description = description;
    seen.set(name, entry);
  }

  return [...seen.values()];
}

interface DtcgGroup {
  [key: string]: DtcgNode;
}

type DtcgNode = string | number | boolean | null | DtcgNode[] | DtcgGroup;

function isGroup(node: DtcgNode | undefined): node is DtcgGroup {
  return typeof node === 'object' && node !== null && !Array.isArray(node);
}

function isDtcgNode(value: unknown): value is DtcgNode {
  return value === null || ['string', 'number', 'boolean', 'object'].includes(typeof value);
}

const text = (node: DtcgNode | undefined) => (typeof node === 'string' ? node : undefined);

/** A W3C Design Tokens (DTCG) document: every object with a `$value` is a token, named by its path. `$type` is inherited from its groups. */
export function dtcgTokens(json: string, source: string): TokenEntry[] {
  const parsed: unknown = JSON.parse(json);
  const tokens: TokenEntry[] = [];

  const walk = (node: DtcgNode, path: string[], inherited: string | undefined) => {
    if (!isGroup(node)) return;
    const type = text(node.$type) ?? inherited;

    if ('$value' in node) {
      const value = node.$value;
      const entry: TokenEntry = { name: `--${path.join('-')}`, path: path.join('.'), value: typeof value === 'string' ? value : JSON.stringify(value), source };

      if (type) entry.category = type;

      if (text(node.$description)) entry.description = text(node.$description);
      tokens.push(entry);

      return;
    }

    for (const [key, child] of Object.entries(node)) {
      if (!key.startsWith('$')) walk(child, [...path, key], type);
    }
  };

  if (isDtcgNode(parsed)) walk(parsed, [], undefined);

  return tokens;
}

/** The category of the longest configured prefix the name starts with (`my-space` matches `--my-space-2`). */
export function categorize(tokens: TokenEntry[], categories: Record<string, string>): TokenEntry[] {
  const prefixes = Object.keys(categories).sort((a, b) => b.length - a.length);
  const bare = (name: string) => name.replace(/^--/, '');

  return tokens.map((token) => {
    const prefix = prefixes.find((candidate) => bare(token.name) === bare(candidate) || bare(token.name).startsWith(`${bare(candidate)}-`));

    return prefix ? { ...token, category: categories[prefix] } : token;
  });
}

const VAR = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/** The names from `known` a stylesheet reads through `var()`, sorted. */
export function tokensRead(css: string, known: Set<string>): string[] {
  const read = new Set<string>();

  for (const [, name] of css.matchAll(VAR)) {
    if (known.has(name)) read.add(name);
  }

  return [...read].sort();
}

import type { ComponentEntry, Deprecation, McpIndex, PropEntry } from '../src/types.ts';

/** The index, with the lookups every tool needs. */
export class Library {
  readonly index: McpIndex;
  readonly byTag: Map<string, ComponentEntry>;
  /** `nearest()` answers: markup tends to repeat the same wrong tag. */
  private readonly near = new Map<string, string[]>();

  constructor(index: McpIndex) {
    this.index = index;
    this.byTag = new Map(index.components.map((component) => [component.tag, component]));
  }

  /** What to call the library in a sentence: its npm package, or the server's name. */
  get label(): string {
    return this.index.library.package ?? this.index.library.name;
  }

  get prefix(): string {
    return this.index.library.prefix;
  }

  /** A component by its tag, written any way an agent might: `my-button`, `<my-button>`, `button`, `MyButton`. */
  find(name: string): ComponentEntry | undefined {
    const bare = name.trim().replace(/^<\/?|\/?>$/g, '').trim();
    const kebab = kebabCase(bare);

    return this.byTag.get(bare) ?? this.byTag.get(bare.toLowerCase()) ?? this.byTag.get(kebab) ?? this.byTag.get(`${this.prefix}${kebab}`);
  }

  /** The tags closest to a name that isn't one. */
  nearest(name: string, limit = 3): string[] {
    const cached = this.near.get(name);

    if (cached) return cached.slice(0, limit);
    const wanted = kebabCase(name.replace(/[<>/]/g, ''));
    const strip = (tag: string) => (this.prefix && tag.startsWith(this.prefix) ? tag.slice(this.prefix.length) : tag);

    const found = closest(
      strip(wanted),
      [...this.byTag.keys()].map((tag) => [strip(tag), tag]),
      5,
    );

    // Bounded: the names come from the caller.
    if (this.near.size < 2000) this.near.set(name, found);

    return found.slice(0, limit);
  }

  /** The answer for a tag that isn't in the library. */
  unknown(name: string): { found: false; tag: string; message: string; suggestions: string[] } {
    const suggestions = this.nearest(name);
    const moved = this.index.migrations.tags.find((migration) => migration.from === name);
    const hint = moved ? ` It was replaced by <${moved.to}>.` : suggestions.length > 0 ? ` Did you mean ${suggestions.map((tag) => `<${tag}>`).join(', ')}?` : '';

    return { found: false, tag: name, message: `<${name}> is not a component of ${this.label}.${hint}`, suggestions: moved ? [moved.to, ...suggestions.filter((tag) => tag !== moved.to)] : suggestions };
  }

  /** The wrapper component's name in the framework packages: `MyButton` for `my-button`. */
  wrapperName(tag: string): string {
    return tag.replace(/(^|-)([a-z0-9])/g, (_, _dash: string, letter: string) => letter.toUpperCase());
  }
}

export const kebabCase = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();

export const camelCase = (name: string) => name.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

/** Edit distance, for "did you mean". */
export function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];

    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }

  return previous[b.length];
}

/** The candidates nearest to `wanted`: those containing it, then those within a third of its length in edits. Each candidate is [compared, returned]. */
export function closest(wanted: string, candidates: [string, string][], limit = 3): string[] {
  const scored = candidates.flatMap(([compared, returned]): [number, string][] => {
    if (wanted && (compared.includes(wanted) || wanted.includes(compared))) return [[Math.abs(compared.length - wanted.length) / 10, returned]];
    const edits = distance(wanted, compared);

    return edits <= Math.max(2, Math.ceil(wanted.length / 3)) ? [[edits, returned]] : [];
  });

  return scored
    .sort(([a, tagA], [b, tagB]) => a - b || tagA.localeCompare(tagB))
    .slice(0, limit)
    .map(([, returned]) => returned);
}

export const firstSentence = (text: string) => {
  const line = text.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ');
  const end = line.search(/[.!?](\s|$)/);

  return end === -1 ? line : line.slice(0, end + 1);
};

export function deprecationNote(deprecation: Deprecation | undefined): string | undefined {
  if (!deprecation) return undefined;
  const replacement = deprecation.replacement;

  if (!replacement) return deprecation.text || 'Deprecated.';

  return replacement.kind === 'tag' ? `Deprecated: use <${replacement.name}>.` : `Deprecated: use \`${replacement.name}\`.`;
}

/** Whether a prop's type is exactly boolean (so its attribute's presence means true). */
export const isBooleanProp = (prop: PropEntry) => prop.type.replace(/\s*\|\s*undefined/g, '').trim() === 'boolean';

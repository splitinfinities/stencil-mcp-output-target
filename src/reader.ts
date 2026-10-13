import type { JsonDocs, JsonDocsComponent, JsonDocsProp } from '@stencil/core/internal';
import { parseDeprecation } from './sources/deprecated.ts';
import type { ComponentEntry, Deprecation, EventEntry, MethodEntry, NamedDoc, PropEntry } from './types.ts';

// docs-json → the index's components. Two things docs-json doesn't say are read from each
// component's source: `formAssociated`, and the `<slot>`s of a light-DOM component that has no
// `@slot` tags (a shadow component's slots are part of its documented API; a light-DOM
// component's are found in its render function or not at all).

export interface Message {
  /** A tag, an option path (`rules[2]`), or `package.json`. */
  where: string;
  message: string;
}

/** Tags the index reads itself, so they aren't repeated in `docsTags`. */
const READ_TAGS = new Set(['slot', 'part', 'category', 'mcpIgnore', 'deprecated']);

const tagText = (component: JsonDocsComponent, name: string) => component.docsTags.find((tag) => tag.name === name)?.text?.trim();

export const isIgnored = (component: JsonDocsComponent) => component.docsTags.some((tag) => tag.name === 'mcpIgnore');

/** The first sentence of the first paragraph, on one line. */
export function summarize(docs: string): string {
  const paragraph = docs.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ');
  const end = paragraph.search(/[.!?](\s|$)/);

  return end === -1 ? paragraph : paragraph.slice(0, end + 1);
}

/** The string literals a prop's type allows, when it allows nothing else (`undefined` aside). */
function enumValues(prop: JsonDocsProp): string[] | undefined {
  const real = prop.values.filter((value) => value.type !== 'undefined' && value.type !== 'null');
  const literals = real.flatMap((value) => (value.type === 'string' && value.value !== undefined ? [value.value] : []));

  return real.length > 0 && literals.length === real.length ? literals : undefined;
}

function withDeprecation<T extends { deprecation?: Deprecation }>(entry: T, text: string | undefined, where: string, warn: (message: Message) => void): T {
  if (text === undefined) return entry;
  entry.deprecation = parseDeprecation(text, 'member');

  if (!entry.deprecation.replacement) warn({ where, message: `@deprecated has no machine-readable replacement (write "Use \`name\` instead"): ${JSON.stringify(text.trim())}` });

  return entry;
}

function readProp(prop: JsonDocsProp, tag: string, warn: (message: Message) => void): PropEntry {
  const entry: PropEntry = {
    name: prop.name,
    type: prop.type,
    required: prop.required,
    reflect: prop.reflectToAttr,
    mutable: prop.mutable,
    description: prop.docs.trim(),
  };

  if (prop.attr) entry.attribute = prop.attr;
  const values = enumValues(prop);

  if (values) entry.values = values;

  if (prop.default !== undefined) entry.default = prop.default;

  return withDeprecation(entry, prop.deprecation, `${tag}.${prop.name}`, warn);
}

const SLOT = /<slot\b([^>]*)>/g;

/** The slots a light-DOM component's source renders: `''` for the default slot. */
export function sourceSlots(source: string): string[] {
  const names = [...source.matchAll(SLOT)].map(([, attrs]) => attrs.match(/\bname=["']([^"']+)["']/)?.[1] ?? '');

  return [...new Set(names)].sort();
}

const FORM_ASSOCIATED = /formAssociated\s*:\s*true/;

const named = (items: { name: string; docs: string }[]): NamedDoc[] => items.map((item) => ({ name: item.name, description: item.docs.trim() }));

export function readComponent(
  component: JsonDocsComponent,
  category: string | undefined,
  readSource: (filePath: string) => string | undefined,
  warn: (message: Message) => void,
): ComponentEntry {
  const source = component.filePath ? readSource(component.filePath) : undefined;
  const slots = named(component.slots);

  if (component.encapsulation !== 'shadow' && source !== undefined) {
    for (const name of sourceSlots(source)) {
      if (!slots.some((slot) => slot.name === name)) slots.push({ name, description: '' });
    }
  }

  const entry: ComponentEntry = {
    tag: component.tag,
    summary: summarize(component.docs),
    description: component.docs.trim(),
    docsTags: component.docsTags.filter((tag) => !READ_TAGS.has(tag.name)).map((tag) => ({ name: tag.name, text: (tag.text ?? '').trim() })),
    encapsulation: component.encapsulation,
    formAssociated: source !== undefined && FORM_ASSOCIATED.test(source),
    props: component.props.map((prop) => readProp(prop, component.tag, warn)),
    events: component.events.map((event) =>
      withDeprecation<EventEntry>(
        { name: event.event, detail: event.detail, bubbles: event.bubbles, cancelable: event.cancelable, composed: event.composed, description: event.docs.trim() },
        event.deprecation,
        `${component.tag}.${event.event}`,
        warn,
      ),
    ),
    methods: component.methods.map((method) =>
      withDeprecation<MethodEntry>({ name: method.name, signature: method.signature, description: method.docs.trim() }, method.deprecation, `${component.tag}.${method.name}()`, warn),
    ),
    slots,
    parts: named(component.parts),
    cssProperties: named(component.styles),
    dependencies: [...component.dependencies].sort(),
    dependents: [...component.dependents].sort(),
    examples: Object.entries(component.usage)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, markdown]) => ({ title, markdown: markdown.trim() })),
    tokens: [],
  };

  const chosen = tagText(component, 'category') || category;

  if (chosen) entry.category = chosen;

  if (component.deprecation !== undefined) {
    entry.deprecation = parseDeprecation(component.deprecation, 'tag');

    if (!entry.deprecation.replacement) {
      warn({ where: component.tag, message: `@deprecated has no machine-readable replacement (write "Use <other-tag> instead"): ${JSON.stringify(component.deprecation.trim())}` });
    }
  }

  return entry;
}

/** The prefix most tags start with, up to and including the dash: `my-` for `my-button`, `my-input` and a stray `x-legacy`. `''` without tags. */
export function tagPrefix(tags: string[]): string {
  const counts = new Map<string, number>();

  for (const tag of tags) {
    const prefix = tag.slice(0, tag.indexOf('-') + 1);

    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }

  return [...counts].sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))[0]?.[0] ?? '';
}

/** The components the index holds: not excluded, not `@mcpIgnore`, sorted by tag. */
export function readComponents(
  docs: JsonDocs,
  options: { exclude: string[]; categories: Record<string, string> },
  readSource: (filePath: string) => string | undefined,
  warn: (message: Message) => void,
): ComponentEntry[] {
  const kept = docs.components.filter((component) => !options.exclude.includes(component.tag) && !isIgnored(component));
  const tags = new Set(kept.map((component) => component.tag));

  return kept
    .map((component) => {
      const entry = readComponent(component, options.categories[component.tag], readSource, warn);

      // A dependency on a component that was left out isn't something an agent can look up.
      entry.dependencies = entry.dependencies.filter((tag) => tags.has(tag));
      entry.dependents = entry.dependents.filter((tag) => tags.has(tag));

      return entry;
    })
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

import type { ComponentEntry, PropEntry } from '../../src/types.ts';
import { deprecationNote, firstSentence, type Library } from '../library.ts';
import { plain, type Json, type Result } from '../respond.ts';
import { search } from '../search.ts';
import { integer, LIST, strings, TAG, text, type ToolDefinition } from '../tool.ts';

const SECTIONS = ['props', 'events', 'methods', 'slots', 'parts', 'cssProperties', 'dependencies', 'guidance', 'accessibility'] as const;

/** One line per component. */
export function brief(component: ComponentEntry): Result {
  return { tag: component.tag, summary: component.summary, category: component.category, deprecated: deprecationNote(component.deprecation) };
}

function prop(entry: PropEntry, full: boolean): Result {
  return {
    name: entry.name,
    attribute: entry.attribute,
    // A union of literals is said once, as `values`.
    type: entry.values && !full ? undefined : entry.type,
    values: entry.values,
    default: entry.default,
    required: entry.required || undefined,
    reflect: full ? entry.reflect : undefined,
    mutable: full ? entry.mutable : undefined,
    deprecated: deprecationNote(entry.deprecation),
    description: (full ? entry.description : firstSentence(entry.description)) || undefined,
  };
}

const described = (items: { name: string; description: string }[], full: boolean): Json[] => items.map((item) => ({ name: item.name || '(default)', description: (full ? item.description : firstSentence(item.description)) || undefined }));

/** A component's API, flat, with only the sections asked for. */
export function api(library: Library, component: ComponentEntry, sections: readonly string[], full: boolean): Result {
  const wants = (section: string) => sections.length === 0 || sections.includes(section);
  const result: Result = {
    found: true,
    tag: component.tag,
    summary: component.summary,
    description: full && component.description !== component.summary ? component.description : undefined,
    category: component.category,
    encapsulation: component.encapsulation,
    formAssociated: component.formAssociated || undefined,
    deprecated: deprecationNote(component.deprecation),
    docsTags: full && component.docsTags.length > 0 ? component.docsTags : undefined,
  };

  if (wants('props')) result.props = component.props.map((entry) => prop(entry, full));

  if (wants('events')) {
    result.events = component.events.map((event) => ({
      name: event.name,
      detail: event.detail,
      bubbles: full ? event.bubbles : undefined,
      composed: full ? event.composed : undefined,
      cancelable: full ? event.cancelable : undefined,
      deprecated: deprecationNote(event.deprecation),
      description: (full ? event.description : firstSentence(event.description)) || undefined,
    }));
  }

  if (wants('methods')) {
    result.methods = component.methods.map((method) => ({ name: method.name, signature: method.signature, deprecated: deprecationNote(method.deprecation), description: (full ? method.description : firstSentence(method.description)) || undefined }));
  }

  if (wants('slots')) result.slots = described(component.slots, full);

  if (wants('parts')) result.parts = described(component.parts, full);

  if (wants('cssProperties')) result.cssProperties = described(component.cssProperties, full);

  if (wants('dependencies')) {
    result.dependencies = component.dependencies;
    result.dependents = component.dependents;
  }

  // Curated sections are opt-in when compact: they can be long.
  if (sections.includes('guidance') || (full && sections.length === 0)) result.guidance = plain(library.index.guidance[component.tag] ?? {});

  if (sections.includes('accessibility') || (full && sections.length === 0)) result.accessibility = plain(library.index.accessibility[component.tag] ?? {});

  result.examples = component.examples.length || undefined;

  return result;
}

export const listComponents: ToolDefinition = {
  name: 'list_components',
  title: 'List components',
  description: "Every component of the library: tag and one-line summary, with the categories and their counts. Start here. Pass `category` to list one category; page with `offset`.",
  input: {
    properties: {
      category: { type: 'string', description: 'Only this category (see `categories` in a first call).' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 60 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
  output: {
    total: { type: 'integer', description: 'Components matching, before paging.' },
    categories: LIST({ type: 'object' }, 'Each category and how many components it holds.'),
    components: LIST({ type: 'object' }, 'tag, summary, category, and `deprecated` when it is.'),
    nextOffset: { type: 'integer', description: 'Pass as `offset` for the next page. Absent on the last page.' },
  },
  hint: 'Pass `category`, or a smaller `limit` with `offset`.',
  run(library, args) {
    const category = text(args.category)?.toLowerCase();
    const limit = integer(args.limit, 60, 1, 200);
    const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const counts = new Map<string, number>();

    for (const component of library.index.components) counts.set(component.category ?? '(none)', (counts.get(component.category ?? '(none)') ?? 0) + 1);
    const matching = library.index.components.filter((component) => !category || (component.category ?? '(none)').toLowerCase() === category);
    const result: Result = {
      total: matching.length,
      categories: library.index.capabilities.categories ? [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })) : [],
      components: matching.slice(offset, offset + limit).map(brief),
    };

    if (offset + limit < matching.length) result.nextOffset = offset + limit;

    if (category && matching.length === 0) result.message = `No category "${args.category}". The categories: ${[...counts.keys()].sort().join(', ')}.`;

    return result;
  },
};

export const getComponentApi: ToolDefinition = {
  name: 'get_component_api',
  title: 'Get a component\'s API',
  description: "One component's API: props (attribute, type, allowed values, default), events, methods, slots, CSS parts and custom properties. Compact by default; pass `sections` to get only some, `detail: \"full\"` for whole descriptions, guidance and accessibility notes.",
  input: {
    properties: {
      tag: TAG,
      sections: { type: 'array', items: { type: 'string', enum: SECTIONS }, description: 'Only these sections. Default: all but guidance and accessibility.' },
      detail: { type: 'string', enum: ['compact', 'full'], default: 'compact' },
    },
    required: ['tag'],
  },
  output: {
    tag: { type: 'string' },
    summary: { type: 'string' },
    description: { type: 'string' },
    category: { type: 'string' },
    encapsulation: { type: 'string', description: 'shadow, scoped or none: whether outside CSS reaches inside.' },
    formAssociated: { type: 'boolean', description: 'true when it takes part in a <form> like a native control.' },
    deprecated: { type: 'string' },
    props: LIST(),
    events: LIST(),
    methods: LIST(),
    slots: LIST(),
    parts: LIST(),
    cssProperties: LIST(),
    dependencies: LIST({ type: 'string' }, 'Tags it renders.'),
    dependents: LIST({ type: 'string' }, 'Tags that render it.'),
    examples: { type: 'integer', description: 'How many usage examples get_component_examples has.' },
  },
  hint: 'Pass `sections` (for example ["props"]), or `detail: "compact"`.',
  run(library, args) {
    const tag = text(args.tag) ?? '';
    const component = library.find(tag);

    return component ? api(library, component, strings(args.sections), args.detail === 'full') : library.unknown(tag);
  },
};

export const searchComponents: ToolDefinition = {
  name: 'search_components',
  title: 'Search components',
  description: "Keyword search over tags, summaries, prop, slot and event names, descriptions and the library's guidance. Returns the best matches with where they matched. For \"which component do I use for X\", prefer suggest_components.",
  input: {
    properties: { query: { type: 'string', description: 'Keywords, e.g. "date picker" or "loading".' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
    required: ['query'],
  },
  output: { query: { type: 'string' }, results: LIST({ type: 'object' }, 'tag, summary, category, score, and `matched`: the fields the query hit.') },
  hint: 'Pass a smaller `limit`.',
  run(library, args) {
    const query = text(args.query) ?? '';
    const results = search(library, query, integer(args.limit, 10, 1, 50)).map((hit) => ({ ...brief(hit.component), score: Math.round(hit.score * 10) / 10, matched: hit.matched }));

    return results.length > 0 ? { query, results } : { query, results, message: `Nothing matches "${query}". list_components shows everything.` };
  },
};

export const getComponentExamples: ToolDefinition = {
  name: 'get_component_examples',
  title: 'Get usage examples',
  description: "A component's usage examples, as its authors wrote them (the component's usage/*.md files).",
  input: {
    properties: { tag: TAG, title: { type: 'string', description: 'Only the example with this title.' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 } },
    required: ['tag'],
  },
  output: { tag: { type: 'string' }, total: { type: 'integer' }, examples: LIST({ type: 'object' }, 'title and markdown.') },
  requires: { capability: 'examples', what: 'usage examples (no component has a usage/*.md file); generate_snippet writes one from the API', option: 'usage/*.md files beside each component, read by Stencil' },
  hint: 'Pass `title` for one example, or a smaller `limit`.',
  run(library, args) {
    const tag = text(args.tag) ?? '';
    const component = library.find(tag);

    if (!component) return library.unknown(tag);
    const title = text(args.title)?.toLowerCase();
    const examples = component.examples.filter((example) => !title || example.title.toLowerCase() === title);
    const result: Result = { found: true, tag: component.tag, total: examples.length, examples: examples.slice(0, integer(args.limit, 5, 1, 20)).map((example) => ({ title: example.title, markdown: example.markdown })) };

    if (examples.length === 0) result.message = component.examples.length > 0 ? `No example titled "${args.title}". Its examples: ${component.examples.map((example) => example.title).join(', ')}.` : `<${component.tag}> has no usage examples. generate_snippet writes one from its API.`;

    return result;
  },
};

export const getComponentRelationships: ToolDefinition = {
  name: 'get_component_relationships',
  title: 'Get component relationships',
  description: 'What a component renders inside itself, what renders it, everything it pulls in transitively, the other components of its category, and what replaces it when it is deprecated.',
  input: { properties: { tag: TAG }, required: ['tag'] },
  output: {
    tag: { type: 'string' },
    renders: LIST({ type: 'string' }, "Tags in its own template: don't add them again around or inside it."),
    renderedBy: LIST({ type: 'string' }),
    rendersTransitively: LIST({ type: 'string' }, 'Everything loaded when it is used.'),
    sameCategory: LIST({ type: 'string' }),
    replacedBy: { type: 'string' },
    replaces: LIST({ type: 'string' }),
  },
  run(library, args) {
    const tag = text(args.tag) ?? '';
    const component = library.find(tag);

    if (!component) return library.unknown(tag);
    const all: string[] = [];

    const visit = (current: string) => {
      for (const next of library.byTag.get(current)?.dependencies ?? []) {
        if (all.includes(next) || next === component.tag) continue;
        all.push(next);
        visit(next);
      }
    };

    visit(component.tag);

    return {
      found: true,
      tag: component.tag,
      renders: component.dependencies,
      renderedBy: component.dependents,
      rendersTransitively: all.sort(),
      sameCategory: component.category ? library.index.components.filter((other) => other.category === component.category && other.tag !== component.tag).map((other) => other.tag) : [],
      replacedBy: library.index.migrations.tags.find((migration) => migration.from === component.tag)?.to,
      replaces: library.index.migrations.tags.filter((migration) => migration.to === component.tag).map((migration) => migration.from),
    };
  },
};

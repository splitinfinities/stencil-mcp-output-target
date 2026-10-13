import { changelogFor, guideResult, migrationGuide } from '../migration.ts';
import type { Result } from '../respond.ts';
import { words } from '../search.ts';
import { integer, LIST, TAG, text, type ToolDefinition } from '../tool.ts';

export const getDesignTokens: ToolDefinition = {
  name: 'get_design_tokens',
  title: 'Get design tokens',
  description: "The library's design tokens (CSS custom properties): name, value, category and description. Filter by `category` or `query`; page with `offset`. Use these names instead of hard-coded colors, sizes and spacing.",
  input: {
    properties: {
      category: { type: 'string', description: 'Only this category (see `categories` in a first call).' },
      query: { type: 'string', description: 'Words the name, value or description must contain.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
  output: {
    total: { type: 'integer' },
    categories: LIST({ type: 'object' }),
    tokens: LIST({ type: 'object' }, 'name (the custom property), value, category, description.'),
    nextOffset: { type: 'integer' },
  },
  requires: { capability: 'tokens', what: 'design tokens', option: 'tokens' },
  hint: 'Pass `category` or `query`, or a smaller `limit` with `offset`.',
  run(library, args) {
    const category = text(args.category)?.toLowerCase();
    const terms = words(text(args.query) ?? '');
    const limit = integer(args.limit, 100, 1, 500);
    const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const counts = new Map<string, number>();

    for (const token of library.index.tokens) counts.set(token.category ?? '(none)', (counts.get(token.category ?? '(none)') ?? 0) + 1);

    const matching = library.index.tokens.filter((token) => {
      const haystack = `${token.name} ${token.path ?? ''} ${token.value} ${token.description ?? ''}`.toLowerCase();

      return (!category || (token.category ?? '(none)').toLowerCase() === category) && terms.every((term) => haystack.includes(term));
    });

    const result: Result = {
      total: matching.length,
      categories: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })),
      tokens: matching.slice(offset, offset + limit).map((token) => ({ name: token.name, path: token.path, value: token.value, category: token.category, description: token.description })),
    };

    if (offset + limit < matching.length) result.nextOffset = offset + limit;

    return result;
  },
};

export const getTokenUsage: ToolDefinition = {
  name: 'get_token_usage',
  title: 'Get token usage',
  description: "Which components read a design token (pass `token`), or which tokens a component reads (pass `tag`), from each component's compiled CSS. Use it to see what changing a token affects.",
  input: { properties: { token: { type: 'string', description: 'A custom property, e.g. --my-color-primary. The dashes may be left out.' }, tag: TAG } },
  output: {
    token: { type: 'object' },
    usedBy: LIST({ type: 'string' }, 'Tags whose CSS reads the token.'),
    tag: { type: 'string' },
    tokens: LIST({ type: 'object' }, 'The tokens the component reads, with their values.'),
  },
  requires: { capability: 'tokenUsage', what: "compiled CSS to read token usage from, or no tokens (set `tokens`, and build the `dist` output target)", option: 'tokens' },
  run(library, args) {
    const wanted = text(args.token);
    const tag = text(args.tag);

    if (tag) {
      const component = library.find(tag);

      if (!component) return library.unknown(tag);

      return { found: true, tag: component.tag, tokens: component.tokens.map((name) => ({ name, value: library.index.tokens.find((token) => token.name === name)?.value })) };
    }

    if (!wanted) return { message: 'Pass `token` or `tag`.' };
    const name = wanted.startsWith('--') ? wanted : `--${wanted.replace(/\./g, '-')}`;
    const token = library.index.tokens.find((candidate) => candidate.name === name || candidate.path === wanted);

    if (!token) {
      const near = library.index.tokens.filter((candidate) => candidate.name.includes(name.replace(/^--/, ''))).slice(0, 5);

      return { found: false, message: `${name} is not a token of ${library.label}.`, suggestions: near.map((candidate) => candidate.name) };
    }

    return {
      found: true,
      token: { name: token.name, path: token.path, value: token.value, category: token.category, description: token.description },
      usedBy: library.index.components.filter((component) => component.tokens.includes(token.name)).map((component) => component.tag),
    };
  },
};

export const getMigrationGuide: ToolDefinition = {
  name: 'get_migration_guide',
  title: 'Get the migration guide',
  description: 'What is deprecated or was removed, and what replaces it: tags, props, values and events, for one component or the whole library, with the changelog when the library ships one (pass `version` for one release).',
  input: { properties: { tag: TAG, version: { type: 'string', description: 'A changelog version, e.g. 2.0.0.' } } },
  output: {
    tags: LIST({ type: 'object' }, 'from, to, note, removed.'),
    props: LIST({ type: 'object' }, 'tag, from, to, note, removed.'),
    values: LIST({ type: 'object' }, 'tag, prop, from, to, note.'),
    events: LIST({ type: 'object' }),
    changelog: LIST({ type: 'object' }, 'version, date, body (Markdown).'),
  },
  requires: { capability: 'migrations', what: 'deprecations or migrations (nothing is deprecated)', option: 'migrations' },
  hint: 'Pass `tag` for one component, or `version` for one release.',
  run(library, args) {
    const given = text(args.tag);
    const component = given ? library.find(given) : undefined;
    const tag = component?.tag ?? given;
    const result = guideResult(migrationGuide(library, tag));
    const changelog = changelogFor(library, { version: text(args.version), tag, limit: 3 });

    if (library.index.capabilities.changelog) result.changelog = changelog.map((entry) => ({ ...entry }));

    if (tag) result.tag = tag;

    if (given && !component && Array.isArray(result.tags) && result.tags.length === 0) return library.unknown(given);

    return result;
  },
};

export const getBundleAnalysis: ToolDefinition = {
  name: 'get_bundle_analysis',
  title: 'Get bundle sizes',
  description: "What each component costs to load: its entry chunk, the shared chunks it imports, and bytes as built (before compression). For one component, or the largest. `source` says where the numbers came from: a Stencil stats file, or measured from the lazy build.",
  input: { properties: { tag: TAG, limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 } } },
  output: {
    source: { type: 'string', description: 'stats or measured.' },
    components: LIST({ type: 'object' }, 'tag, entry, entryBytes, totalBytes (entry plus shared chunks), shared.'),
    total: { type: 'integer' },
  },
  requires: { capability: 'sizes', what: 'bundle sizes (no lazy build and no stats file were found)', option: 'stats' },
  hint: 'Pass `tag`, or a smaller `limit`.',
  run(library, args) {
    const { source, components } = library.index.sizes;
    const given = text(args.tag);

    if (given) {
      const component = library.find(given);

      if (!component) return library.unknown(given);
      const size = components[component.tag];

      return size ? { found: true, source, components: [{ tag: component.tag, ...size }], total: 1 } : { found: true, source, components: [], total: 0, message: `No size was recorded for <${component.tag}>.` };
    }

    const sorted = Object.entries(components).sort(([, a], [, b]) => (b.totalBytes ?? b.entryBytes) - (a.totalBytes ?? a.entryBytes));

    return { source, total: sorted.length, components: sorted.slice(0, integer(args.limit, 20, 1, 200)).map(([tag, size]) => ({ tag, ...size })) };
  },
};

export const getAccessibilityInfo: ToolDefinition = {
  name: 'get_accessibility_info',
  title: 'Get accessibility notes',
  description: "A component's accessibility contract as its authors wrote it: its role, keyboard behaviour, the ARIA attributes it sets or needs, and notes. Without `tag`, the components that have notes.",
  input: { properties: { tag: TAG } },
  output: {
    tag: { type: 'string' },
    role: { type: 'string' },
    keyboard: LIST({ type: 'object' }, 'keys and what they do.'),
    aria: LIST({ type: 'string' }),
    notes: LIST({ type: 'string' }),
    labelProps: LIST({ type: 'string' }, 'Props of the component that label it.'),
    documented: LIST({ type: 'string' }, 'Without `tag`: the components with notes.'),
  },
  requires: { capability: 'accessibility', what: 'accessibility notes', option: 'accessibility' },
  run(library, args) {
    const given = text(args.tag);

    if (!given) return { documented: Object.keys(library.index.accessibility) };
    const component = library.find(given);

    if (!component) return library.unknown(given);
    const notes = library.index.accessibility[component.tag];
    const labelProps = component.props.flatMap((prop) => (/label|aria|alt\b|title/i.test(prop.name) ? [prop.attribute ?? prop.name] : []));

    if (!notes) return { found: true, tag: component.tag, labelProps, message: `No accessibility notes were written for <${component.tag}>.` };

    return { found: true, tag: component.tag, role: notes.role, keyboard: notes.keyboard?.map((entry) => ({ ...entry })), aria: notes.aria, notes: notes.notes, labelProps };
  },
};

import type { ChangelogEntry } from '../src/types.ts';
import type { Library } from './library.ts';
import type { Result } from './respond.ts';

// The migration guide: deprecated and removed tags, props and values with their replacements,
// and the changelog. The tool returns it as JSON, the resource as Markdown.

export interface MigrationGuide {
  tags: { from: string; to?: string; note?: string; removed: boolean }[];
  props: { tag: string; from: string; to?: string; note?: string; removed: boolean }[];
  values: { tag: string; prop: string; from: string; to: string; note?: string }[];
  events: { tag: string; name: string; note: string }[];
}

/** Everything deprecated or replaced, for one tag or the whole library. */
export function migrationGuide(library: Library, tag?: string): MigrationGuide {
  const { migrations, components } = library.index;
  const relevant = (candidate: string, other?: string) => !tag || candidate === tag || other === tag;
  const tags = new Map<string, MigrationGuide['tags'][number]>();
  const props = new Map<string, MigrationGuide['props'][number]>();

  for (const migration of migrations.tags) {
    if (relevant(migration.from, migration.to)) tags.set(migration.from, { ...migration, removed: !library.byTag.has(migration.from) });
  }

  for (const migration of migrations.props) {
    const component = library.byTag.get(migration.tag);

    if (relevant(migration.tag)) props.set(`${migration.tag} ${migration.from}`, { ...migration, removed: !component?.props.some((prop) => prop.name === migration.from || prop.attribute === migration.from) });
  }

  // Deprecations whose text names no replacement.
  for (const component of components) {
    if (!relevant(component.tag)) continue;

    if (component.deprecation && !tags.has(component.tag)) tags.set(component.tag, { from: component.tag, note: component.deprecation.text, removed: false });

    for (const prop of component.props) {
      if (prop.deprecation && !props.has(`${component.tag} ${prop.name}`)) props.set(`${component.tag} ${prop.name}`, { tag: component.tag, from: prop.name, note: prop.deprecation.text, removed: false });
    }
  }

  return {
    tags: [...tags.values()],
    props: [...props.values()],
    values: migrations.values.filter((migration) => relevant(migration.tag)),
    events: components.flatMap((component) => (relevant(component.tag) ? component.events.flatMap((event) => (event.deprecation ? [{ tag: component.tag, name: event.name, note: event.deprecation.text }] : [])) : [])),
  };
}

/** Changelog entries: one version, those mentioning a tag, or the newest few. */
export function changelogFor(library: Library, options: { version?: string; tag?: string; limit: number }): ChangelogEntry[] {
  const { changelog } = library.index;

  if (options.version) return changelog.filter((entry) => entry.version === options.version?.replace(/^v/, ''));

  return (options.tag ? changelog.filter((entry) => entry.body.includes(options.tag ?? '')) : changelog).slice(0, options.limit);
}

export const guideResult = (guide: MigrationGuide): Result => ({
  tags: guide.tags.map((entry) => ({ ...entry })),
  props: guide.props.map((entry) => ({ ...entry })),
  values: guide.values.map((entry) => ({ ...entry })),
  events: guide.events.map((entry) => ({ ...entry })),
});

export function guideMarkdown(library: Library): string {
  const guide = migrationGuide(library);
  const lines = [`# Migrating ${library.label}`, ''];
  const note = (text: string | undefined) => (text ? ` ${text.replace(/\s+/g, ' ')}` : '');

  if (guide.tags.length + guide.props.length + guide.values.length + guide.events.length === 0) lines.push('Nothing is deprecated.', '');

  if (guide.tags.length > 0) {
    lines.push('## Components', '');

    for (const entry of guide.tags) lines.push(`- \`<${entry.from}>\` ${entry.removed ? 'was removed' : 'is deprecated'}${entry.to ? `: use \`<${entry.to}>\`.` : '.'}${entry.to && entry.note?.includes(entry.to) ? '' : note(entry.note)}`);
    lines.push('');
  }

  if (guide.props.length > 0) {
    lines.push('## Props', '');

    for (const entry of guide.props) lines.push(`- \`<${entry.tag}>\` \`${entry.from}\` ${entry.removed ? 'was removed' : 'is deprecated'}${entry.to ? `: use \`${entry.to}\`.` : '.'}${entry.to && entry.note?.includes(entry.to) ? '' : note(entry.note)}`);
    lines.push('');
  }

  if (guide.values.length > 0) {
    lines.push('## Values', '');

    for (const entry of guide.values) lines.push(`- \`<${entry.tag} ${entry.prop}="${entry.from}">\`: use \`"${entry.to}"\`.${note(entry.note)}`);
    lines.push('');
  }

  if (guide.events.length > 0) {
    lines.push('## Events', '');

    for (const entry of guide.events) lines.push(`- \`<${entry.tag}>\` \`${entry.name}\` is deprecated.${note(entry.note)}`);
    lines.push('');
  }

  if (library.index.changelog.length > 0) {
    lines.push('## Changelog', '');

    for (const entry of library.index.changelog.slice(0, 5)) lines.push(`### ${entry.version}${entry.date ? ` (${entry.date})` : ''}`, '', entry.body, '');
  }

  return lines.join('\n');
}

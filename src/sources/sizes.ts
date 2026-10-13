import type { SizeEntry } from '../types.ts';

// Sizes per component, from one of two places:
//   - a Stencil stats file ({ type: 'stats' }): `formats.esmBrowser[]`, one row per entry chunk
//     with the tags it defines, its size and the chunks it imports;
//   - the lazy build itself (`dist/<namespace>/`): the loader's registry names each tag's entry
//     chunk, and each chunk's static imports are followed.

/** The lazy build's files the target could read: name → source. */
export type LazyFiles = Record<string, string>;

export interface LazyBuild {
  /** The loader, `<namespace>.esm.js`. */
  loader: string;
  files: LazyFiles;
}

const STATIC_IMPORT = /(?:^|[;}\s)])(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["'](\.\/[^"']+\.js)["']/g;

/** The `./x.js` files a module statically imports, in order, once each. */
export function staticImports(source: string): string[] {
  return [...new Set([...source.matchAll(STATIC_IMPORT)].map((match) => match[1].slice(2)))];
}

// The loader registers every bundle: `bootstrapLazy([["p-1a2b",[[769,"my-button",{…}],…]],…])`. A
// large registry is the same text inside `JSON.parse('…')`. Either way each bundle starts
// `["<id>",[[` and each of its components `[<flags>,"<tag>"`, so both are read as text.
const BUNDLE = /\["([\w.-]+)",\[\[/g;

const COMPONENT = /\[\d+,"([a-z][a-z0-9]*(?:-[a-z0-9]+)+)"/g;

/** Tag → entry chunk, from the loader's source. */
export function parseRegistry(loader: string): Record<string, string> {
  const bundles = [...loader.matchAll(BUNDLE)].map((match) => ({ id: match[1], at: match.index }));
  const entries: Record<string, string> = {};

  for (const match of loader.matchAll(COMPONENT)) {
    const bundle = bundles.findLast((candidate) => candidate.at < match.index);

    if (bundle) entries[match[1]] = `${bundle.id}.entry.js`;
  }

  return entries;
}

const bytes = (source: string) => Buffer.byteLength(source, 'utf8');

/** Each file, then what it imports, depth first, once each. */
function closure(start: string, files: LazyFiles): string[] {
  const seen: string[] = [];

  const visit = (file: string) => {
    if (seen.includes(file) || !(file in files)) return;
    seen.push(file);

    for (const next of staticImports(files[file])) visit(next);
  };

  visit(start);

  return seen;
}

export function measuredSizes(build: LazyBuild): Record<string, SizeEntry> {
  const entries = parseRegistry(build.files[build.loader] ?? '');
  const sizes: Record<string, SizeEntry> = {};

  for (const [tag, entry] of Object.entries(entries)) {
    if (!(entry in build.files)) continue;
    const [, ...shared] = closure(entry, build.files);
    const entryBytes = bytes(build.files[entry]);

    sizes[tag] = { entry, entryBytes, totalBytes: entryBytes + shared.reduce((sum, file) => sum + bytes(build.files[file]), 0), shared: shared.sort() };
  }

  return sizes;
}

/** One row of a stats file's `formats.esmBrowser`: an entry chunk. */
export interface StatsBundle {
  components: string[];
  fileName: string;
  imports: string[];
  originalByteSize: number;
}

interface Stats {
  formats: { esmBrowser: StatsBundle[] };
}

function isBundle(value: unknown): value is StatsBundle {
  if (typeof value !== 'object' || value === null) return false;

  return 'components' in value && Array.isArray(value.components) && 'fileName' in value && typeof value.fileName === 'string' && 'originalByteSize' in value && typeof value.originalByteSize === 'number';
}

function isStats(value: unknown): value is Stats {
  if (typeof value !== 'object' || value === null || !('formats' in value)) return false;
  const formats = value.formats;

  return typeof formats === 'object' && formats !== null && 'esmBrowser' in formats && Array.isArray(formats.esmBrowser) && formats.esmBrowser.every(isBundle);
}

/** The entry chunks a stats file lists. Undefined when the file isn't one. */
export function parseStats(json: string): StatsBundle[] | undefined {
  try {
    const parsed: unknown = JSON.parse(json);

    return isStats(parsed) ? parsed.formats.esmBrowser : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sizes from a stats file's rows: Stencil's own number for each entry chunk (the code before
 * minification, so larger than the file). The lazy build, when there is one, supplies the
 * shared chunks' sizes for the total.
 */
export function statsSizes(rows: StatsBundle[], build?: LazyBuild): Record<string, SizeEntry> {
  const sizes: Record<string, SizeEntry> = {};

  for (const bundle of rows) {
    for (const tag of bundle.components) {
      const size: SizeEntry = { entry: bundle.fileName, entryBytes: bundle.originalByteSize, shared: [...(bundle.imports ?? [])].sort() };

      if (build && bundle.fileName in build.files) {
        const [, ...shared] = closure(bundle.fileName, build.files);

        size.shared = shared.sort();
        size.totalBytes = size.entryBytes + shared.reduce((sum, file) => sum + bytes(build.files[file]), 0);
      }

      sizes[tag] = size;
    }
  }

  return sizes;
}

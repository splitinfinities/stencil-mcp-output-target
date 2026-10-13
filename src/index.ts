import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonDocs, OutputTargetCustom, OutputTargetDistCollection, OutputTargetDistLazy, OutputTargetStats } from '@stencil/core/internal';
import { checkOptions, checkPackageJson, installBin, isPackageJson, serverBin, unscoped, type PackageJson } from './check.ts';
import { DEFAULT_OUT_DIR, type McpOutputTargetOptions } from './options.ts';
import { readComponents, tagPrefix, type Message } from './reader.ts';
import { parseChangelog } from './sources/changelog.ts';
import { measuredSizes, parseStats, statsSizes, type LazyBuild, type StatsBundle } from './sources/sizes.ts';
import { categorize, cssTokens, dtcgTokens, tokensRead } from './sources/tokens.ts';
import { SCHEMA_VERSION, TOOL_NAMES, type McpIndex, type Migrations, type SizeEntry, type TokenEntry } from './types.ts';

export type { McpOutputTargetOptions, MigrationOptions } from './options.ts';

export type * from './types.ts';

export { SCHEMA_VERSION, TOOL_NAMES } from './types.ts';

export { checkPackageJson, binName, serverBin, installBin, type PackageJson } from './check.ts';

export type { Message } from './reader.ts';

export type { LazyBuild, StatsBundle } from './sources/sizes.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** This package's version, and the bundled server: dist/server.mjs, beside dist/index.js (from src/, one directory up). */
function ownFile(name: string): string | undefined {
  return [join(HERE, name), join(HERE, '..', name), join(HERE, '..', 'dist', name)].find((path) => existsSync(path));
}

function ownVersion(): string {
  const path = ownFile('package.json');
  const parsed: unknown = path ? JSON.parse(readFileSync(path, 'utf8')) : {};

  return (isPackageJson(parsed) && parsed.version) || '0.0.0';
}

/** The server as this release bundled it. It holds no library data, so every library gets the same bytes. */
export function serverBundle(): string {
  const path = ownFile('server.mjs');

  if (!path) throw new Error('stencil-mcp-output-target: dist/server.mjs is missing (run `pnpm build` in the package)');

  return readFileSync(path, 'utf8');
}

/** What the install script registers: the server's name, the package that ships it, and the `bin` that runs it. */
export interface InstallTarget {
  name: string;
  package: string;
  bin: string;
}

/** The line of dist/install.mjs that names the library. */
const INSTALL_LIBRARY = /^const LIBRARY = .*$/m;

/** The install script every library ships (dist/install.mjs), with this library's names filled in. */
export function installScript(library: InstallTarget): string {
  const path = ownFile('install.mjs');

  if (!path) throw new Error('stencil-mcp-output-target: dist/install.mjs is missing (run `pnpm build` in the package)');
  const template = readFileSync(path, 'utf8');

  if (!INSTALL_LIBRARY.test(template)) throw new Error(`stencil-mcp-output-target: ${path} has no \`const LIBRARY\` line to fill in`);

  // A function, so a `$` in a name is not read as a replacement pattern.
  return template.replace(INSTALL_LIBRARY, () => `const LIBRARY = ${JSON.stringify({ name: library.name, package: library.package, bin: library.bin })};`);
}

/** What the build knows beyond docs-json. Everything is optional: a section without its source is left empty. */
export interface BuildContext {
  /** The library's package.json. */
  packageJson?: PackageJson;
  /** The lazy build (`dist/<namespace>/`), for sizes. */
  lazy?: LazyBuild;
  /** Tag → the component's compiled CSS, for which tokens it reads. */
  styles?: Record<string, string>;
  /**
   * The rows Stencil is about to write to the stats file. Stencil writes that file after every
   * output target has run, so during a build the file on disk is the previous build's; the
   * output target passes this build's rows here instead. The CLI reads the file.
   */
  stats?: StatsBundle[];
  /** The bundled server's source. Default: this package's dist/server.mjs. */
  server?: string;
}

export interface GenerateResult {
  /** Paths relative to `outDir`. */
  files: Map<string, string>;
  index: McpIndex;
  warnings: Message[];
  /** Option entries that name something the library doesn't have. Nothing should be written when there are any. */
  errors: Message[];
}

const sortKeys = <T>(record: Record<string, T> | undefined): Record<string, T> => Object.fromEntries(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));

const target = (value: string | { to: string; note?: string }) => (typeof value === 'string' ? { to: value } : value);

/** Deprecations that name a replacement, then what the `migrations` option adds or overrides. */
function buildMigrations(index: Pick<McpIndex, 'components'>, options: McpOutputTargetOptions): Migrations {
  const tags = new Map<string, Migrations['tags'][number]>();
  const props = new Map<string, Migrations['props'][number]>();
  const values = new Map<string, Migrations['values'][number]>();

  for (const component of index.components) {
    if (component.deprecation?.replacement?.kind === 'tag') tags.set(component.tag, { from: component.tag, to: component.deprecation.replacement.name, note: component.deprecation.text });

    for (const prop of component.props) {
      if (prop.deprecation?.replacement) props.set(`${component.tag} ${prop.name}`, { tag: component.tag, from: prop.name, to: prop.deprecation.replacement.name, note: prop.deprecation.text });
    }
  }

  for (const [from, value] of Object.entries(options.migrations?.tags ?? {})) tags.set(from, { from, ...target(value) });

  for (const [tag, renamed] of Object.entries(options.migrations?.props ?? {})) {
    for (const [from, value] of Object.entries(renamed)) props.set(`${tag} ${from}`, { tag, from, ...target(value) });
  }

  for (const [tag, byProp] of Object.entries(options.migrations?.values ?? {})) {
    for (const [prop, renamed] of Object.entries(byProp)) {
      for (const [from, value] of Object.entries(renamed)) values.set(`${tag} ${prop} ${from}`, { tag, prop, from, ...target(value) });
    }
  }

  const sorted = <T>(map: Map<string, T>) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);

  return { tags: sorted(tags), props: sorted(props), values: sorted(values) };
}

function readme(index: McpIndex, bin: string, install: string, outDir: string): string {
  const pkg = index.library.package ?? index.library.name;
  const dir = outDir.replace(/^\.\//, '');
  const server = `${dir}/server.mjs`;

  return `# ${index.library.name} MCP server

Generated by ${index.generator.name}. Do not edit: it is rewritten by every production build.

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for ${pkg}${index.library.version ? ` ${index.library.version}` : ''}: ${index.components.length} components. It reads \`index.json\` beside it and nothing else: no other file, no network.

## Install it

In the project that uses ${pkg}:

\`\`\`sh
npx -y -p ${pkg} ${install}
\`\`\`

It adds the server to the project config of each MCP client the project uses, and to \`.mcp.json\` when it shows none:

| \`--client\` | File | Client |
|---|---|---|
| \`claude\` | \`.mcp.json\` | Claude Code |
| \`cursor\` | \`.cursor/mcp.json\` | Cursor |
| \`vscode\` | \`.vscode/mcp.json\` | VS Code |
| \`gemini\` | \`.gemini/settings.json\` | Gemini CLI |

\`--client <name>\` picks clients, \`--all\` takes every one, \`--dry-run\` writes nothing, \`--remove\` takes the entry out, and \`--print\` prints it for any other client. The script changes that one entry and nothing else in a file, writes only under the current directory, and is safe to run again. With ${pkg} installed, \`node node_modules/${pkg}/${dir}/install.mjs\` is the same script.

## Or register it by hand

In \`.mcp.json\`, or your client's equivalent:

\`\`\`json
{
  "mcpServers": {
    "${index.library.name}": { "command": "npx", "args": ["-y", "-p", "${pkg}", "${bin}"] }
  }
}
\`\`\`

From a checkout of the library: \`node ${server}\`.

## Transports

- stdio, by default.
- \`${bin} --http <port>\`: streamable HTTP on \`http://127.0.0.1:<port>/mcp\`. It listens on the loopback interface only and rejects requests whose \`Host\` or \`Origin\` is not local.

## Tools

${TOOL_NAMES.map((tool) => `- \`${tool}\`${index.disabledTools.includes(tool) ? ' (switched off)' : ''}`).join('\n')}

A tool whose data this library didn't configure stays listed and answers "not available", naming the option that enables it.

## Resources

- \`component://{tag}\`: a component's page, as Markdown
- \`component://{tag}/api.json\`: its API, as JSON
- \`tokens://all\`: the design tokens
- \`guide://migration\`: deprecations and their replacements

## Prompts (experimental)

- \`build-ui\`, \`migrate-deprecated\`, \`fix-component\`
`;
}

/** Pure: docs in, files out. The output target and the CLI both call this. */
export function generate(docs: JsonDocs, options: McpOutputTargetOptions = {}, readSource: (filePath: string) => string | undefined = () => undefined, build: BuildContext = {}): GenerateResult {
  const warnings: Message[] = [];
  const errors: Message[] = [];
  const warn = (message: Message) => warnings.push(message);
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const allTags = docs.components.map((component) => component.tag);

  const components = readComponents(docs, { exclude: options.exclude ?? [], categories: options.categories ?? {} }, readSource, warn);
  const prefix = options.prefix ?? tagPrefix(components.map((component) => component.tag));

  // Tokens, and which components read which.
  let tokens: TokenEntry[] = [];

  for (const file of [options.tokens ?? []].flat()) {
    const source = readSource(file);

    if (source === undefined) {
      errors.push({ where: 'tokens', message: `can't read ${file}` });
      continue;
    }

    try {
      tokens.push(...(file.endsWith('.json') ? dtcgTokens(source, file) : cssTokens(source, file)));
    } catch (error) {
      errors.push({ where: 'tokens', message: `${file}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  // A name declared in two files keeps its first declaration.
  tokens = categorize(
    tokens.filter((token, i) => tokens.findIndex((other) => other.name === token.name) === i),
    options.tokenCategories ?? {},
  ).sort((a, b) => a.name.localeCompare(b.name));

  const known = new Set(tokens.map((token) => token.name));

  if (tokens.length > 0 && !build.styles) warn({ where: 'tokens', message: "no compiled CSS to read (a dist output target writes it): get_token_usage won't know which components read which tokens" });

  for (const component of components) component.tokens = tokensRead(build.styles?.[component.tag] ?? '', known);

  // Sizes.
  let sizes: McpIndex['sizes'] = { source: null, components: {} };
  const kept = (all: Record<string, SizeEntry>) => sortKeys(Object.fromEntries(components.flatMap((component) => (all[component.tag] ? [[component.tag, all[component.tag]]] : []))));

  if (options.stats) {
    const source = build.stats ? undefined : readSource(options.stats);
    const rows = build.stats ?? (source === undefined ? undefined : parseStats(source));

    if (rows) sizes = { source: 'stats', components: kept(statsSizes(rows, build.lazy)) };
    else errors.push({ where: 'stats', message: `${options.stats} ${source === undefined ? "can't be read: add { type: 'stats', file } to outputTargets and build" : 'is not a Stencil stats file'}` });
  }

  if (sizes.source === null && build.lazy) {
    const measured = kept(measuredSizes(build.lazy));

    if (Object.keys(measured).length > 0) sizes = { source: 'measured', components: measured };
  }

  // The changelog.
  let changelog: McpIndex['changelog'] = [];

  if (options.changelog) {
    const source = readSource(options.changelog);

    if (source === undefined) errors.push({ where: 'changelog', message: `can't read ${options.changelog}` });
    else changelog = parseChangelog(source);
  }

  errors.push(...checkOptions(options, components, allTags, tokens, prefix));

  const pkg = build.packageJson ?? {};
  const migrations = buildMigrations({ components }, options);

  const index: McpIndex = {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'stencil-mcp-output-target', version: ownVersion() },
    library: { name: options.name ?? (unscoped(pkg.name) || 'components'), prefix },
    capabilities: {
      examples: components.some((component) => component.examples.length > 0),
      categories: components.some((component) => component.category !== undefined),
      guidance: Object.keys(options.guidance ?? {}).length > 0,
      accessibility: Object.keys(options.accessibility ?? {}).length > 0,
      intents: Object.keys(options.intents ?? {}).length > 0,
      rules: (options.rules ?? []).length > 0,
      tokens: tokens.length > 0,
      tokenUsage: components.some((component) => component.tokens.length > 0),
      frameworks: Object.keys(options.frameworks ?? {}).length > 0,
      migrations: migrations.tags.length + migrations.props.length + migrations.values.length > 0 || components.some((component) => component.deprecation || component.props.some((prop) => prop.deprecation)),
      changelog: changelog.length > 0,
      sizes: sizes.source !== null,
    },
    disabledTools: TOOL_NAMES.filter((tool) => options.tools?.[tool] === false),
    components,
    tokens,
    sizes,
    guidance: sortKeys(options.guidance),
    accessibility: sortKeys(options.accessibility),
    intents: sortKeys(options.intents),
    rules: options.rules ?? [],
    frameworks: sortKeys(options.frameworks),
    migrations,
    changelog,
  };

  if (pkg.name) index.library.package = pkg.name;

  if (pkg.version) index.library.version = pkg.version;

  const files = new Map<string, string>();

  files.set('index.json', `${JSON.stringify(index, null, 1)}\n`);
  files.set('server.mjs', build.server ?? serverBundle());
  files.set('install.mjs', installScript({ name: index.library.name, package: pkg.name ?? index.library.name, bin: serverBin(pkg, outDir) }));
  files.set('README.md', readme(index, serverBin(pkg, outDir), installBin(pkg, outDir), outDir));

  return { files, index, warnings, errors };
}

/** The generated files a run didn't write: `outDir` holds generated files only. Returns the paths removed. */
export function removeStale(outDir: string, paths: Iterable<string>): string[] {
  const written = new Set([...paths].map((path) => join(outDir, path)));
  let removed: string[] = [];

  try {
    removed = readdirSync(outDir, { withFileTypes: true }).flatMap((entry) => (entry.isFile() && !written.has(join(outDir, entry.name)) ? [join(outDir, entry.name)] : []));
  } catch {
    return [];
  }

  for (const stale of removed) rmSync(stale);

  return removed;
}

/** How the target reads the build's files: Stencil's in-memory file system during a build, the disk from the CLI. */
export interface BuildFs {
  readFile(path: string): Promise<string | undefined>;
  /** File names in a directory; `[]` when it isn't there. */
  readDir(path: string): Promise<string[]>;
}

export interface BuildDirs {
  /** The Stencil package. */
  rootDir: string;
  /** The lazy build, `dist/<namespace>/`. */
  lazyDir?: string;
  /** `dist/collection/`. */
  collectionDir?: string;
  /** `src/`. */
  srcDir?: string;
}

/** Reads what `generate()` needs from a build: package.json, the lazy build's files, each component's compiled CSS. */
export async function readBuildContext(docs: JsonDocs, dirs: BuildDirs, fs: BuildFs): Promise<BuildContext> {
  const context: BuildContext = {};
  const pkg = await fs.readFile(join(dirs.rootDir, 'package.json'));
  const parsed: unknown = pkg === undefined ? undefined : JSON.parse(pkg);

  if (isPackageJson(parsed)) context.packageJson = parsed;

  if (dirs.lazyDir) {
    const names = (await fs.readDir(dirs.lazyDir)).filter((name) => name.endsWith('.js')).sort();
    const loader = names.find((name) => name.endsWith('.esm.js') && name !== 'index.esm.js');

    if (loader) {
      const sources = await Promise.all(names.map((name) => fs.readFile(join(dirs.lazyDir ?? '', name))));

      context.lazy = { loader, files: Object.fromEntries(names.flatMap((name, i) => (sources[i] === undefined ? [] : [[name, sources[i]]]))) };
    }
  }

  // Each component's compiled stylesheets sit beside its module in the collection, at the path
  // its source has under src/.
  if (dirs.collectionDir && dirs.srcDir) {
    const styles: Record<string, string> = {};

    for (const component of docs.components) {
      if (!component.filePath) continue;
      const source = isAbsolute(component.filePath) ? component.filePath : resolve(dirs.rootDir, component.filePath);
      const dir = join(dirs.collectionDir, relative(dirs.srcDir, dirname(source)));
      const sheets = (await fs.readDir(dir)).filter((name) => name.endsWith('.css')).sort();
      const css = await Promise.all(sheets.map((name) => fs.readFile(join(dir, name))));

      if (sheets.length > 0) styles[component.tag] = css.join('\n');
    }

    if (Object.keys(styles).length > 0) context.styles = styles;
  }

  return context;
}

/**
 * Stencil custom output target. Runs after docs are generated, so it sees the same JsonDocs as
 * `docs-json`. Production builds write `mcp/`; a dev build only checks package.json.
 *
 *   outputTargets: [{ type: 'dist' }, mcpOutputTarget()]
 */
export function mcpOutputTarget(options: McpOutputTargetOptions = {}): OutputTargetCustom {
  return {
    type: 'custom',
    name: 'mcp',
    async generator(config, compilerCtx, buildCtx, docs) {
      const rootDir = config.rootDir ?? process.cwd();
      const relativeOut = options.outDir ?? DEFAULT_OUT_DIR;
      const outDir = isAbsolute(relativeOut) ? relativeOut : resolve(rootDir, relativeOut);
      const production = !config.devMode;
      const report = (level: 'warn' | 'error', header: string, messageText: string) => buildCtx.diagnostics.push({ level, type: 'build', header, messageText, lines: [] });

      const fs: BuildFs = {
        readFile: async (path) => {
          try {
            return await compilerCtx.fs.readFile(path);
          } catch {
            return undefined;
          }
        },
        // Only what this build wrote: the outputs are still in Stencil's in-memory file system,
        // and the disk may hold a previous build's chunks under other hashes.
        readDir: async (path) => {
          try {
            return (await compilerCtx.fs.readdir(path, { inMemoryOnly: true })).flatMap((item) => (item.isFile ? [item.relPath] : []));
          } catch {
            return [];
          }
        },
      };

      const context = await readBuildContext(
        docs,
        {
          rootDir,
          srcDir: config.srcDir,
          lazyDir: config.outputTargets?.find((candidate): candidate is OutputTargetDistLazy => candidate.type === 'dist-lazy')?.esmDir,
          collectionDir: config.outputTargets?.find((candidate): candidate is OutputTargetDistCollection => candidate.type === 'dist-collection')?.collectionDir,
        },
        fs,
      );

      // The stats file is written once every output target has run: read this build's rows from
      // where Stencil will, so a first build and a repeat build give the same index.
      if (options.stats) {
        const file = isAbsolute(options.stats) ? options.stats : resolve(rootDir, options.stats);
        const writes = config.outputTargets?.some((candidate): candidate is OutputTargetStats => candidate.type === 'stats' && candidate.file !== undefined && resolve(candidate.file) === file);

        if (!writes) report('error', 'mcp: stats', `no { type: 'stats', file: '${options.stats}' } output target writes ${options.stats}`);
        context.stats = buildCtx.esmBrowserComponentBundle.map((bundle) => ({
          components: bundle.cmps.map((component) => component.tagName),
          fileName: bundle.output.fileName,
          imports: bundle.rollupResult.imports,
          originalByteSize: Buffer.byteLength(bundle.rollupResult.code, 'utf8'),
        }));
      }

      // package.json is the library author's; say what to add, never write it.
      for (const problem of checkPackageJson(context.packageJson ?? {}, relative(rootDir, outDir)).problems) {
        report(production ? 'error' : 'warn', 'mcp: package.json', `${problem} (or run \`npx stencil-mcp-output-target init\`)`);
      }

      if (!production) return;

      const readSource = (filePath: string) => {
        try {
          return readFileSync(isAbsolute(filePath) ? filePath : resolve(rootDir, filePath), 'utf8');
        } catch {
          return undefined;
        }
      };

      const { files, warnings, errors } = generate(docs, options, readSource, context);

      for (const { where, message } of warnings) report('warn', `mcp: ${where}`, message);

      for (const { where, message } of errors) report('error', `mcp: ${where}`, message);

      if (errors.length > 0) return;

      await Promise.all([...files].map(([path, content]) => compilerCtx.fs.writeFile(join(outDir, path), content)));

      for (const stale of removeStale(outDir, files.keys())) report('warn', 'mcp: removed a stale generated file', stale);
    },
  };
}

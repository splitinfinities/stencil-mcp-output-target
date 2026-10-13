// The output target from the command line, without a Stencil build: it reads a built package
// (its docs-json and dist/) from disk.
//
//   stencil-mcp-output-target generate [--package <dir>] [--docs <file>] [--config <module>]
//   stencil-mcp-output-target check    [--package <dir>] [--docs <file>] [--config <module>]
//   stencil-mcp-output-target init     [--package <dir>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { JsonDocs } from '@stencil/core/internal';
import { checkPackageJson, isPackageJson } from './check.ts';
import { generate, readBuildContext, removeStale, type BuildFs, type GenerateResult } from './index.ts';
import { DEFAULT_OUT_DIR, type McpOutputTargetOptions } from './options.ts';

const USAGE = `stencil-mcp-output-target: a read-only MCP server inside your Stencil component library

  stencil-mcp-output-target generate   write mcp/ from a built package (as a production build does)
  stencil-mcp-output-target check      exit 1 when mcp/ or package.json is out of date (for CI)
  stencil-mcp-output-target init       add the "bin" and "files" entries to package.json, and say what to add to stencil.config.ts

  --package <dir>     the Stencil package (default: the current directory)
  --docs <file>       its docs-json file (default: found under the package)
  --config <module>   a module whose default export is the mcpOutputTarget() options
  -h, --help          this text`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { package: { type: 'string' }, docs: { type: 'string' }, config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});

const command = positionals[0];
const root = resolve(values.package ?? '.');

if (values.help || !command) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

function isOptions(value: unknown): value is McpOutputTargetOptions {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadOptions(): Promise<McpOutputTargetOptions> {
  if (!values.config) return {};
  const loaded: { default?: unknown } = await import(pathToFileURL(resolve(values.config)).href);

  if (!isOptions(loaded.default)) throw new Error(`${values.config}: the default export must be the mcpOutputTarget() options`);

  return loaded.default;
}

function isDocs(value: unknown): value is JsonDocs {
  return typeof value === 'object' && value !== null && 'components' in value && Array.isArray(value.components);
}

/** The package's docs-json: the file named, or the usual places. */
function findDocs(): string {
  const candidates = values.docs ? [resolve(values.docs)] : ['docs/documentation.json', 'docs.json', 'dist/docs.json', 'docs/docs.json'].map((path) => join(root, path));
  const found = candidates.find((path) => existsSync(path));

  if (!found) throw new Error(`No docs-json file in ${root}: add { type: 'docs-json', file: 'docs/documentation.json' } to outputTargets and build, or pass --docs <file>.`);

  return found;
}

const disk: BuildFs = {
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  readDir: async (path) => {
    try {
      return (await readdir(path, { withFileTypes: true })).flatMap((entry) => (entry.isFile() ? [entry.name] : []));
    } catch {
      return [];
    }
  },
};

/** The lazy build on disk: `dist/<namespace>/` holding `<namespace>.esm.js`. */
async function findLazyDir(): Promise<string | undefined> {
  const dist = join(root, 'dist');

  try {
    const dirs = (await readdir(dist, { withFileTypes: true })).filter((entry) => entry.isDirectory() && existsSync(join(dist, entry.name, `${entry.name}.esm.js`)));

    return dirs.map((entry) => join(dist, entry.name)).sort()[0];
  } catch {
    return undefined;
  }
}

async function run(options: McpOutputTargetOptions): Promise<GenerateResult> {
  const parsed: unknown = JSON.parse(readFileSync(findDocs(), 'utf8'));

  if (!isDocs(parsed)) throw new Error(`${findDocs()} is not a docs-json file`);
  const collectionDir = join(root, 'dist/collection');
  const context = await readBuildContext(parsed, { rootDir: root, lazyDir: await findLazyDir(), collectionDir: existsSync(collectionDir) ? collectionDir : undefined, srcDir: join(root, 'src') }, disk);

  const readSource = (filePath: string) => {
    try {
      return readFileSync(isAbsolute(filePath) ? filePath : resolve(root, filePath), 'utf8');
    } catch {
      return undefined;
    }
  };

  return generate(parsed, options, readSource, context);
}

function readPackage() {
  const path = join(root, 'package.json');
  const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;

  if (!isPackageJson(parsed)) throw new Error(`No package.json in ${root}`);

  return { path, pkg: parsed };
}

const options = await loadOptions();
const outDir = resolve(root, options.outDir ?? DEFAULT_OUT_DIR);
const outRelative = relative(root, outDir);

if (command === 'init') {
  const { path, pkg } = readPackage();
  const { problems, fixed } = checkPackageJson(pkg, outRelative);

  if (problems.length === 0) {
    console.log('package.json already runs and publishes the server and its install script.');
  } else {
    writeFileSync(path, `${JSON.stringify(fixed, null, 2)}\n`);
    console.log(`package.json: added ${[fixed.bin !== pkg.bin && '"bin"', fixed.files !== pkg.files && `"${outRelative}/" to "files"`].filter((part) => part).join(' and ')}.`);
  }

  console.log(`
Now add the target to stencil.config.ts and run a production build:

  import { mcpOutputTarget } from 'stencil-mcp-output-target';

  outputTargets: [{ type: 'dist' }, mcpOutputTarget()],

Commit ${outRelative}/ and run \`stencil-mcp-output-target check\` in CI.`);
} else if (command === 'generate' || command === 'check') {
  const result = await run(options);
  const problems = checkPackageJson(readPackage().pkg, outRelative).problems;

  for (const { where, message } of result.warnings) console.log(`warn  ${where}: ${message}`);

  for (const { where, message } of result.errors) console.error(`error ${where}: ${message}`);

  for (const problem of problems) console.error(`error package.json: ${problem}`);

  if (result.errors.length > 0 || problems.length > 0) {
    process.exitCode = 1;
  } else if (command === 'generate') {
    for (const [path, content] of result.files) {
      const file = join(outDir, path);

      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }

    const removed = removeStale(outDir, result.files.keys());

    if (removed.length > 0) console.log(`removed ${removed.length} stale generated file(s)`);
    console.log(`${result.index.components.length} components → ${outRelative}/ (${[...result.files.keys()].join(', ')})`);
  } else {
    const stale = [...result.files].flatMap(([path, content]) => (existsSync(join(outDir, path)) && readFileSync(join(outDir, path), 'utf8') === content ? [] : [path]));
    const extra = (await disk.readDir(outDir)).filter((name) => !result.files.has(name));

    if (stale.length > 0 || extra.length > 0) {
      console.error(`${outRelative}/ is out of date (${[...stale, ...extra.map((name) => `${name}: not generated`)].join(', ')}): run a production build, or \`stencil-mcp-output-target generate\`, and commit it.`);
      process.exitCode = 1;
    } else {
      console.log(`${outRelative}/ is current: ${result.index.components.length} components.`);
    }
  }
} else {
  console.error(`Unknown command ${command}.\n\n${USAGE}`);
  process.exitCode = 2;
}

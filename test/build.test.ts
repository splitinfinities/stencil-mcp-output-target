// What a production build of the fixture wrote, and the CLI over it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { SCHEMA_VERSION } from '../src/types.ts';
import { FIXTURE, readIndex, ROOT, serverPath } from './helpers.ts';

const cli = (args: string[], cwd = FIXTURE) => spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(ROOT, 'dist/cli.js'), ...args], { cwd, encoding: 'utf8' });

/** A copy of the fixture's built package, to change without touching the fixture. */
function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-fixture-'));

  for (const name of ['package.json', 'mcp.config.ts', 'CHANGELOG.md', 'stats.json', 'docs', 'dist', 'src', 'mcp']) cpSync(join(FIXTURE, name), join(dir, name), { recursive: true });

  return dir;
}

test('the build writes exactly index.json, server.mjs, install.mjs and README.md', () => {
  assert.deepEqual(readdirSync(join(FIXTURE, 'mcp')).sort(), ['README.md', 'index.json', 'install.mjs', 'server.mjs']);
  assert.deepEqual(readdirSync(join(FIXTURE, 'mcp-zero')).sort(), ['README.md', 'index.json', 'install.mjs', 'server.mjs']);
});

test('server.mjs is the output target\'s bundle, byte for byte, with a version header and notices', () => {
  const own = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const server = readFileSync(serverPath(), 'utf8');

  assert.equal(server, readFileSync(join(ROOT, 'dist/server.mjs'), 'utf8'));
  assert.equal(server, readFileSync(serverPath('mcp-zero'), 'utf8'));
  assert.ok(server.startsWith(`#!/usr/bin/env node\n// stencil-mcp-output-target server v${own.version}\n`));

  for (const notice of ['@modelcontextprotocol/server', 'Apache License', 'parse5', 'zod', '@cfworker/json-schema (MIT)', 'Permission is hereby granted, free of charge']) assert.ok(server.includes(notice), notice);
  // Ajv and its URI resolver stay out: the runtime brings its own validator.
  for (const absent of ['ajv', 'fast-uri']) assert.ok(!server.includes(`${absent} (`), absent);
  // It holds no library data.
  for (const data of ['@my/components', 'Cards do not nest', 'A button or a link']) assert.ok(!server.includes(data), data);
  assert.equal(execFileSync(process.execPath, [serverPath(), '--version'], { encoding: 'utf8' }).trim(), own.version);
});

test('both indexes match the published schema', () => {
  const schema = fromJsonSchema(JSON.parse(readFileSync(join(ROOT, 'schema/index.v1.json'), 'utf8')));

  for (const build of ['mcp', 'mcp-zero'] as const) {
    const result = schema['~standard'].validate(readIndex(build));

    assert.ok(!(result instanceof Promise));
    assert.deepEqual(result.issues, undefined, build);
  }

  const broken = schema['~standard'].validate({ ...readIndex(), schemaVersion: 2 });

  assert.ok(!(broken instanceof Promise) && broken.issues?.length);
});

test('the index is sorted, has no timestamps, and names its generator', () => {
  const text = readFileSync(join(FIXTURE, 'mcp/index.json'), 'utf8');
  const index = readIndex();
  const tags = index.components.map((component) => component.tag);

  assert.equal(index.schemaVersion, SCHEMA_VERSION);
  assert.equal(index.generator.name, 'stencil-mcp-output-target');
  assert.deepEqual(tags, [...tags].sort());
  assert.deepEqual(Object.keys(index.sizes.components), tags);
  assert.deepEqual(index.tokens.map((token) => token.name), index.tokens.map((token) => token.name).sort());
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:/);
  assert.ok(!text.includes(ROOT), 'no absolute paths');
});

test('determinism: regenerating from the built package gives the same bytes (`check` passes)', () => {
  const result = cli(['check', '--config', 'mcp.config.ts']);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^mcp\/ is current: 8 components\.$/m);
  // The build read Stencil's stats rows from memory, the CLI the file it then wrote: one index.
  assert.equal(readIndex().sizes.source, 'stats');
});

test('check fails when a file is stale, extra, or package.json is not wired', () => {
  const dir = copy();

  try {
    assert.equal(cli(['check', '--package', dir, '--config', join(dir, 'mcp.config.ts')]).status, 0);

    writeFileSync(join(dir, 'mcp/index.json'), '{}\n');
    writeFileSync(join(dir, 'mcp/notes.txt'), 'x');
    const stale = cli(['check', '--package', dir, '--config', join(dir, 'mcp.config.ts')]);

    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /mcp\/ is out of date \(index\.json, notes\.txt: not generated\)/);

    // generate rewrites it and removes the stray file.
    const generated = cli(['generate', '--package', dir, '--config', join(dir, 'mcp.config.ts')]);

    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /removed 1 stale generated file\(s\)\n8 components → mcp\/ \(index\.json, server\.mjs, install\.mjs, README\.md\)/);
    assert.equal(readFileSync(join(dir, 'mcp/index.json'), 'utf8'), readFileSync(join(FIXTURE, 'mcp/index.json'), 'utf8'));

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...pkg, bin: undefined, files: ['dist/'] }));
    const unwired = cli(['check', '--package', dir, '--config', join(dir, 'mcp.config.ts')]);

    assert.equal(unwired.status, 1);
    assert.match(unwired.stderr, /error package\.json: "bin" doesn't run the server\. Add: "bin": \{ "components-mcp": "mcp\/server\.mjs" \}/);
    assert.match(unwired.stderr, /error package\.json: "bin" doesn't run the install script\. Add: "bin": \{ "components-mcp-install": "mcp\/install\.mjs" \}/);
    assert.match(unwired.stderr, /error package\.json: "files" doesn't publish mcp\/\. Add "mcp\/" to it\./);

    // init adds both, once.
    assert.match(cli(['init', '--package', dir]).stdout, /package\.json: added "bin" and "mcp\/" to "files"\./);
    const wired = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

    assert.deepEqual([wired.bin, wired.files], [{ 'components-mcp': 'mcp/server.mjs', 'components-mcp-install': 'mcp/install.mjs' }, ['dist/', 'mcp/']]);
    assert.match(cli(['init', '--package', dir]).stdout, /package\.json already runs and publishes the server and its install script\./);
    assert.equal(cli(['check', '--package', dir, '--config', join(dir, 'mcp.config.ts')]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an option that names something the library lacks fails the CLI, and nothing is written', () => {
  const dir = copy();

  try {
    writeFileSync(join(dir, 'bad.config.ts'), "export default { intents: { modal: 'my-popover' }, rules: [{ id: 'r', tag: 'my-button', require: { attr: 'colour' }, message: 'm' }] };\n");
    const before = statSync(join(dir, 'mcp/index.json')).mtimeMs;
    const result = cli(['generate', '--package', dir, '--config', join(dir, 'bad.config.ts')]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /error intents\.modal: <my-popover> is not a component of this library/);
    assert.match(result.stderr, /error rules\[0\] \(r\)\.require: <my-button> has no attribute colour/);
    assert.equal(statSync(join(dir, 'mcp/index.json')).mtimeMs, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a server refuses an index from another schema version, naming both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-mismatch-'));

  try {
    cpSync(serverPath(), join(dir, 'server.mjs'));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ ...readIndex(), schemaVersion: 99 }));
    const mismatch = spawnSync(process.execPath, [join(dir, 'server.mjs')], { encoding: 'utf8', input: '' });

    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /index\.json has schemaVersion 99; this server \(stencil-mcp-output-target \d+\.\d+\.\d+\) reads schemaVersion 1\. Rebuild the library so both files come from the same release\./);

    rmSync(join(dir, 'index.json'));
    const missing = spawnSync(process.execPath, [join(dir, 'server.mjs')], { encoding: 'utf8', input: '' });

    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /index\.json is missing: build the library/);
    assert.equal(spawnSync(process.execPath, [join(dir, 'server.mjs'), '--port', '1'], { encoding: 'utf8' }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('budgets: the bundle\'s size, and the time to answer initialize', () => {
  const bytes = statSync(serverPath()).size;

  assert.ok(bytes < 1.6 * 1024 * 1024, `server.mjs is ${(bytes / 1024).toFixed(0)} KiB; the budget is 1638 KiB`);

  const initialize = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'budget', version: '0' } } })}\n`;
  const times = [1, 2, 3].map(() => {
    const start = performance.now();
    const result = spawnSync(process.execPath, [serverPath()], { input: initialize, encoding: 'utf8' });

    assert.match(result.stdout, /"serverInfo":\{"name":"components"/);

    return performance.now() - start;
  });

  // A whole process: start node, load 1.3 MB, read the index, answer, exit on EOF.
  assert.ok(Math.min(...times) < 1500, `initialize took ${Math.min(...times).toFixed(0)}ms; the budget is 1500ms`);
});

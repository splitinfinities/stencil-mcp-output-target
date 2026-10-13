// The output target's own logic, without a Stencil build.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonDocs, JsonDocsComponent, JsonDocsProp } from '@stencil/core/internal';
import { checkPackageJson } from '../src/check.ts';
import { generate } from '../src/index.ts';
import { sourceSlots, summarize, tagPrefix } from '../src/reader.ts';
import { parseChangelog } from '../src/sources/changelog.ts';
import { parseDeprecation } from '../src/sources/deprecated.ts';
import { measuredSizes, parseRegistry, parseStats, staticImports, statsSizes } from '../src/sources/sizes.ts';
import { categorize, cssTokens, dtcgTokens, tokensRead } from '../src/sources/tokens.ts';
import { capped, MAX_RESPONSE_CHARS } from '../runtime/respond.ts';

function prop(name: string, extra: Partial<JsonDocsProp> = {}): JsonDocsProp {
  return {
    name,
    attr: name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
    type: 'string',
    complexType: { original: 'string', resolved: 'string', references: {} },
    mutable: false,
    reflectToAttr: false,
    docs: '',
    docsTags: [],
    values: [{ type: 'string' }],
    optional: true,
    required: false,
    getter: false,
    setter: false,
    ...extra,
  };
}

function component(tag: string, extra: Partial<JsonDocsComponent> = {}): JsonDocsComponent {
  return {
    filePath: `src/${tag}.tsx`,
    encapsulation: 'shadow',
    tag,
    readme: '',
    docs: '',
    docsTags: [],
    usage: {},
    props: [],
    methods: [],
    events: [],
    listeners: [],
    styles: [],
    slots: [],
    parts: [],
    customStates: [],
    dependents: [],
    dependencies: [],
    dependencyGraph: {},
    ...extra,
  };
}

const docs = (...components: JsonDocsComponent[]): JsonDocs => ({ timestamp: '', compiler: { name: 'stencil', version: '0', typescriptVersion: '0' }, components, typeLibrary: {} });

const SERVER = '// server';

const run = (components: JsonDocsComponent[], options = {}, sources: Record<string, string> = {}, build = {}) => generate(docs(...components), options, (file) => sources[file], { server: SERVER, ...build });

test('@deprecated: the documented forms name a replacement; anything else is kept verbatim', () => {
  assert.deepEqual(parseDeprecation('Use <my-dialog> instead.', 'tag'), { text: 'Use <my-dialog> instead.', replacement: { kind: 'tag', name: 'my-dialog' } });
  assert.deepEqual(parseDeprecation('Use `<my-panorama media="video">`. It pans.', 'tag').replacement, { kind: 'tag', name: 'my-panorama' });
  assert.deepEqual(parseDeprecation('Use `size` instead', 'member').replacement, { kind: 'prop', name: 'size' });
  assert.equal(parseDeprecation('No longer needed.', 'member').replacement, undefined);
  // A tag isn't replaced by a prop, nor a prop by a tag.
  assert.equal(parseDeprecation('Use `size` instead', 'tag').replacement, undefined);
  assert.equal(parseDeprecation('Use <my-dialog> instead', 'member').replacement, undefined);
});

test('a deprecation without a readable replacement is a warning, and still in the index', () => {
  const { index, warnings } = run([component('my-a', { deprecation: 'Gone soon.', props: [prop('old', { deprecation: 'Use `fresh` instead' }), prop('fresh')] }), component('my-b')]);

  assert.deepEqual(warnings.map((warning) => warning.where), ['my-a']);
  assert.equal(index.components[0].deprecation?.text, 'Gone soon.');
  assert.deepEqual(index.migrations.props, [{ tag: 'my-a', from: 'old', to: 'fresh', note: 'Use `fresh` instead' }]);
  assert.equal(index.capabilities.migrations, true);
});

test('summaries, prefixes and light-DOM slots', () => {
  assert.equal(summarize('A button or a link. Give it an href.\n\nMore.'), 'A button or a link.');
  assert.equal(summarize('No full stop'), 'No full stop');
  assert.equal(tagPrefix(['my-a', 'my-b', 'x-legacy']), 'my-');
  assert.equal(tagPrefix([]), '');
  assert.deepEqual(sourceSlots('<slot name="header" /><slot/><slot name=\'footer\'></slot><slot />'), ['', 'footer', 'header']);
});

test('the reader: enum values, form association, @category, @mcpIgnore, exclude', () => {
  const variant = prop('variant', { type: '"a" | "b"', values: [{ type: 'string', value: 'a' }, { type: 'string', value: 'b' }] });
  const mixed = prop('width', { type: 'number | "auto"', values: [{ type: 'number' }, { type: 'string', value: 'auto' }] });

  const { index } = run(
    [
      component('my-field', { props: [variant, mixed], docsTags: [{ name: 'category', text: 'form' }, { name: 'slot', text: 'x' }, { name: 'since', text: '1.0' }], dependencies: ['my-hidden', 'my-light'] }),
      component('my-hidden', { docsTags: [{ name: 'mcpIgnore' }] }),
      component('my-skipped'),
      component('my-light', { encapsulation: 'none' }),
    ],
    { exclude: ['my-skipped'], categories: { 'my-light': 'layout' } },
    { 'src/my-field.tsx': '@Component({ tag: "my-field", formAssociated: true })', 'src/my-light.tsx': 'render() { return <slot name="aside" />; }' },
  );

  assert.deepEqual(index.components.map((entry) => entry.tag), ['my-field', 'my-light']);
  const [field, light] = index.components;

  assert.deepEqual(field.props[0].values, ['a', 'b']);
  assert.equal(field.props[1].values, undefined);
  assert.equal(field.formAssociated, true);
  assert.equal(field.category, 'form');
  assert.deepEqual(field.docsTags, [{ name: 'since', text: '1.0' }]);
  // A dependency that was left out isn't something an agent can look up.
  assert.deepEqual(field.dependencies, ['my-light']);
  assert.equal(light.category, 'layout');
  assert.deepEqual(light.slots, [{ name: 'aside', description: '' }]);
});

test('tokens: CSS custom properties, DTCG files, categories, and what a stylesheet reads', () => {
  const css = cssTokens(':root {\n  /* The brand. */\n  --my-color: red;\n  --my-space-1: 0.25rem; /* 4px */\n  --my-space-2: 0.5rem }\n@media (x) { :root { --my-color: blue; } }', 'a.css');

  // A comment after a declaration describes that one, never the next.
  assert.deepEqual(css, [
    { name: '--my-color', value: 'red', source: 'a.css', description: 'The brand.' },
    { name: '--my-space-1', value: '0.25rem', source: 'a.css', description: '4px' },
    { name: '--my-space-2', value: '0.5rem', source: 'a.css' },
  ]);

  const dtcg = dtcgTokens(JSON.stringify({ my: { $type: 'color', brand: { $value: '#fff', $description: 'Brand.' }, size: { $type: 'dimension', s: { $value: { value: 4, unit: 'px' } } } } }), 't.json');

  assert.deepEqual(dtcg, [
    { name: '--my-brand', path: 'my.brand', value: '#fff', source: 't.json', category: 'color', description: 'Brand.' },
    { name: '--my-size-s', path: 'my.size.s', value: '{"value":4,"unit":"px"}', source: 't.json', category: 'dimension' },
  ]);

  assert.deepEqual(categorize(css, { 'my-space': 'spacing', my: 'misc' }).map((token) => token.category), ['misc', 'spacing', 'spacing']);
  assert.deepEqual(tokensRead('a { color: var(--my-color, var(--other)); gap: var( --my-space-2 ) }', new Set(['--my-color', '--my-space-2', '--unused'])), ['--my-color', '--my-space-2']);
});

test('the lazy build: both forms of the loader registry, and sizes', () => {
  const inline = 'a([["p-1a2b",[[769,"my-button",{variant:[513]}],[1,"my-icon"]]],["p-3c4d",[[4,"my-card",{items:[16]}]]]],e)';
  const parsed = `bootstrapLazy(JSON.parse('[["p-1a2b",[[769,"my-button",{"variant":[513]}],[1,"my-icon"]]],["p-3c4d",[[4,"my-card"]]]]'),e)`;
  const expected = { 'my-button': 'p-1a2b.entry.js', 'my-icon': 'p-1a2b.entry.js', 'my-card': 'p-3c4d.entry.js' };

  assert.deepEqual(parseRegistry(inline), expected);
  assert.deepEqual(parseRegistry(parsed), expected);
  assert.deepEqual(staticImports('import{a}from"./p-x.js";export{b}from"./p-y.js";import("./lazy.js")'), ['p-x.js', 'p-y.js']);

  const build = { loader: 'my.esm.js', files: { 'my.esm.js': inline, 'p-1a2b.entry.js': 'import{a}from"./p-x.js";12345', 'p-3c4d.entry.js': '123', 'p-x.js': 'import"./p-y.js";1', 'p-y.js': '12' } };
  const sizes = measuredSizes(build);

  assert.deepEqual(sizes['my-button'], { entry: 'p-1a2b.entry.js', entryBytes: 29, totalBytes: 29 + 18 + 2, shared: ['p-x.js', 'p-y.js'] });
  assert.deepEqual(sizes['my-card'], { entry: 'p-3c4d.entry.js', entryBytes: 3, totalBytes: 3, shared: [] });

  const rows = parseStats(JSON.stringify({ formats: { esmBrowser: [{ components: ['my-card'], fileName: 'p-3c4d.entry.js', imports: [], originalByteSize: 99 }] } }));

  assert.deepEqual(statsSizes(rows ?? [], build)['my-card'], { entry: 'p-3c4d.entry.js', entryBytes: 99, totalBytes: 99, shared: [] });
  assert.equal(parseStats('{"formats":{}}'), undefined);
  assert.equal(parseStats('not json'), undefined);
});

test('sizes: the stats rows when configured, otherwise measured; the index says which', () => {
  const lazy = { loader: 'my.esm.js', files: { 'my.esm.js': '[["p-1",[[1,"my-a"]]]]', 'p-1.entry.js': '1234' } };
  const rows = [{ components: ['my-a'], fileName: 'p-1.entry.js', imports: [], originalByteSize: 50 }];

  assert.deepEqual(run([component('my-a')], {}, {}, { lazy }).index.sizes, { source: 'measured', components: { 'my-a': { entry: 'p-1.entry.js', entryBytes: 4, totalBytes: 4, shared: [] } } });
  assert.equal(run([component('my-a')], { stats: 'stats.json' }, {}, { lazy, stats: rows }).index.sizes.components['my-a'].entryBytes, 50);
  // The CLI reads the file; the build passes the rows. Both give the same index.
  assert.deepEqual(
    run([component('my-a')], { stats: 'stats.json' }, { 'stats.json': JSON.stringify({ formats: { esmBrowser: rows } }) }, { lazy }).index,
    run([component('my-a')], { stats: 'stats.json' }, {}, { lazy, stats: rows }).index,
  );
  assert.deepEqual(run([component('my-a')], { stats: 'missing.json' }).errors.map((error) => error.where), ['stats']);
  assert.deepEqual(run([component('my-a')]).index.sizes, { source: null, components: {} });
});

test('changelogs in both heading styles', () => {
  assert.deepEqual(parseChangelog('# Changelog\n\nIntro.\n\n## <small>1.2.1 (2026-01-09)</small>\n\n- p\n\n## [1.2.0] - 2026-01-05\n\n- a\n\n## [1.1.0](https://x/compare) (2025-12-01)\n\n### Fixes\n\n- b\n\n# 1.0.0\n\n- c\n'), [
    { version: '1.2.1', date: '2026-01-09', body: '- p' },
    { version: '1.2.0', date: '2026-01-05', body: '- a' },
    { version: '1.1.0', date: '2025-12-01', body: '### Fixes\n\n- b' },
    { version: '1.0.0', body: '- c' },
  ]);
});

test('every option is checked against real names', () => {
  const button = component('my-button', {
    props: [prop('variant', { values: [{ type: 'string', value: 'solid' }] }), prop('iconOnly')],
    events: [{ event: 'myClick', detail: 'void', bubbles: true, cancelable: true, composed: true, docs: '', docsTags: [], complexType: { original: 'void', resolved: 'void', references: {} } }],
    slots: [{ name: 'icon', docs: '' }],
  });

  const { errors } = run(
    [button, component('my-hidden', { docsTags: [{ name: 'mcpIgnore' }] })],
    {
      exclude: ['my-nope'],
      tools: { get_bundle_analysis: false, not_a_tool: false },
      categories: { 'my-gone': 'x' },
      guidance: { 'my-hidden': {} },
      intents: { modal: 'my-dialog' },
      rules: [
        { id: 'a', tag: 'my-button', when: { attr: 'icon-only' }, require: { attr: 'aria-label' }, message: 'ok' },
        { id: 'a', tag: 'my-button', require: { attr: 'nope' }, message: 'dup id, bad attr' },
        { id: 'b', tag: 'my-button', require: { attr: 'variant', equals: 'ghost' }, forbid: [{ slot: 'footer' }, { parent: 'my-missing' }, { parent: 'form' }], message: 'bad value, slot and parent' },
        { id: 'c', tag: 'my-button', message: 'nothing to check' },
      ],
      tokens: ['tokens.css', 'missing.css'],
      tokenCategories: { 'my-color': 'color', 'my-shadow': 'shadow' },
      frameworks: { react: { package: '@my/react', exclude: ['my-zzz'] }, vue: { package: '@my/vue', models: [{ elements: ['my-button'], event: 'update', targetAttr: 'value' }] }, svelte: { package: 'x' } },
      migrations: { tags: { 'my-old': 'my-newer' }, props: { 'my-button': { kind: 'flavour' } }, values: { 'my-button': { variant: { secondary: 'outline' } } } },
      changelog: 'NOPE.md',
    } as never,
    { 'tokens.css': ':root { --my-color-a: red }' },
  );

  assert.deepEqual(
    errors.map((error) => `${error.where}: ${error.message}`),
    [
      "tokens: can't read missing.css",
      "changelog: can't read NOPE.md",
      'exclude: <my-nope> is not a component of this library',
      `tools.not_a_tool: not a tool (the tools are ${['list_components', 'get_component_api', 'search_components', 'get_component_examples', 'validate_component_usage', 'suggest_components', 'get_component_relationships', 'get_design_tokens', 'get_token_usage', 'get_framework_usage', 'get_migration_guide', 'get_bundle_analysis', 'get_accessibility_info', 'diagnose_component', 'generate_snippet'].join(', ')})`,
      'categories.my-gone: <my-gone> is not a component of this library',
      'guidance.my-hidden: <my-hidden> is not a component of this library (it is excluded)',
      'intents.modal: <my-dialog> is not a component of this library',
      'rules[1] (a): the id a is used twice',
      'rules[1] (a).require: <my-button> has no attribute nope',
      'rules[2] (b).require: <my-button variant> doesn\'t take "ghost" (it takes solid)',
      'rules[2] (b).forbid: <my-button> has no slot "footer"',
      'rules[2] (b).forbid: <my-missing> is not a component of this library',
      'rules[3] (c): needs `require` or `forbid`',
      'tokenCategories.my-shadow: matches no token',
      'frameworks.react.exclude: <my-zzz> is not a component of this library',
      'frameworks.vue.models[0]: <my-button> has no event update',
      'frameworks.vue.models[0]: <my-button> has no prop value',
      'frameworks.svelte: not a framework (the frameworks are react, vue, angular)',
      'migrations.tags.my-old: <my-newer> is not a component of this library',
      'migrations.props.my-button.kind: <my-button> has no prop flavour',
      'migrations.values.my-button.variant.secondary: variant doesn\'t take "outline" (it takes solid)',
    ],
  );
});

test('package.json: bin and files are checked, and init says what to add', () => {
  const wired = { name: '@my/components', bin: { 'components-mcp': 'mcp/server.mjs', 'components-mcp-install': 'mcp/install.mjs' }, files: ['dist/', 'mcp/'] };

  assert.deepEqual(checkPackageJson(wired, './mcp').problems, []);
  // Without "files", npm publishes everything.
  // A string bin runs the server under the package's name; the install script's bin is named after it.
  const single = checkPackageJson({ name: 'x', bin: './mcp/server.mjs' }, 'mcp');

  assert.deepEqual(single.problems, ['"bin" doesn\'t run the install script. Add: "bin": { "x-install": "mcp/install.mjs" }']);
  assert.deepEqual(single.fixed.bin, { x: './mcp/server.mjs', 'x-install': 'mcp/install.mjs' });
  // A server bin of the library's choosing names the install script's.
  assert.deepEqual(checkPackageJson({ name: '@my/core', bin: { 'my-mcp': 'mcp/server.mjs' } }, 'mcp').fixed.bin, { 'my-mcp': 'mcp/server.mjs', 'my-mcp-install': 'mcp/install.mjs' });

  const bare = checkPackageJson({ name: '@my/components', bin: 'cli.js', files: ['dist/'] }, './mcp');

  assert.deepEqual(bare.problems, [
    '"bin" doesn\'t run the server. Add: "bin": { "components-mcp": "mcp/server.mjs" }',
    '"bin" doesn\'t run the install script. Add: "bin": { "components-mcp-install": "mcp/install.mjs" }',
    '"files" doesn\'t publish mcp/. Add "mcp/" to it.',
  ]);
  assert.deepEqual(bare.fixed, { name: '@my/components', bin: { components: 'cli.js', 'components-mcp': 'mcp/server.mjs', 'components-mcp-install': 'mcp/install.mjs' }, files: ['dist/', 'mcp/'] });
  assert.deepEqual(checkPackageJson(bare.fixed, 'mcp').problems, []);
});

test('generate: four files, sorted, no timestamps, and the same bytes twice', () => {
  const components = [component('my-b'), component('my-a', { usage: { z: 'z', a: 'a' } })];
  const options = { guidance: { 'my-b': {}, 'my-a': {} }, intents: { z: 'my-a', a: 'my-b' } };
  const first = run(components, options, {}, { packageJson: { name: '@my/lib', version: '1.0.0' } });
  const second = run([...components].reverse(), options, {}, { packageJson: { name: '@my/lib', version: '1.0.0' } });

  assert.deepEqual([...first.files.keys()], ['index.json', 'server.mjs', 'install.mjs', 'README.md']);
  assert.equal(first.files.get('server.mjs'), SERVER);
  assert.equal(first.files.get('index.json'), second.files.get('index.json'));
  assert.deepEqual(first.index.components.map((entry) => entry.tag), ['my-a', 'my-b']);
  assert.deepEqual(Object.keys(first.index.guidance), ['my-a', 'my-b']);
  assert.deepEqual(first.index.components[0].examples.map((example) => example.title), ['a', 'z']);
  assert.deepEqual(first.index.library, { name: 'lib', prefix: 'my-', package: '@my/lib', version: '1.0.0' });
  assert.doesNotMatch(first.files.get('index.json') ?? '', /timestamp|\d{4}-\d{2}-\d{2}T/);
  assert.match(first.files.get('README.md') ?? '', /"lib": \{ "command": "npx", "args": \["-y", "-p", "@my\/lib", "lib-mcp"\] \}/);
  assert.match(first.files.get('README.md') ?? '', /^npx -y -p @my\/lib lib-mcp-install$/m);
  assert.match(first.files.get('install.mjs') ?? '', /^const LIBRARY = \{"name":"lib","package":"@my\/lib","bin":"lib-mcp"\};$/m);

  // The library's own bin names are the ones the README and the install script use.
  const named = run(components, options, {}, { packageJson: { name: '@my/core', bin: { 'my-mcp': 'mcp/server.mjs', 'my-setup': 'mcp/install.mjs' } } });

  assert.match(named.files.get('README.md') ?? '', /"args": \["-y", "-p", "@my\/core", "my-mcp"\]/);
  assert.match(named.files.get('README.md') ?? '', /^npx -y -p @my\/core my-setup$/m);
  assert.match(named.files.get('install.mjs') ?? '', /"bin":"my-mcp"\};$/m);
});

test('a response over the cap is cut, and says what was dropped and how to ask for it', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ tag: `my-component-${i}`, summary: 'x'.repeat(120) }));
  const out = capped({ total: 400, components: rows }, 'Pass `category`.');

  assert.ok(JSON.stringify(out).length <= MAX_RESPONSE_CHARS);
  assert.equal(out.total, 400);
  // As many as fit: not a blind halving that leaves most of the cap unused.
  assert.ok(JSON.stringify(out).length > MAX_RESPONSE_CHARS * 0.8);
  assert.ok(Array.isArray(out.components) && out.components.length > 100 && out.components.length < 200);
  assert.deepEqual(out.truncated, { reason: `The full result is over ${MAX_RESPONSE_CHARS} characters.`, dropped: { components: { shown: Array.isArray(out.components) ? out.components.length : 0, total: 400 } }, hint: 'Pass `category`.' });

  const text = capped({ code: 'y'.repeat(50_000) }, 'h');

  assert.ok(JSON.stringify(text).length <= MAX_RESPONSE_CHARS);
  assert.equal(capped({ a: 1 }, 'h').truncated, undefined);
});

// The fixture built with mcpOutputTarget() and no options (fixture/mcp-zero): the tools that
// need only docs-json work, and every tool that needs configured data answers "not available".
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { TOOL_NAMES } from '../src/types.ts';
import { connect, readIndex, type Session } from './helpers.ts';

let session: Session;

before(async () => {
  session = await connect('mcp-zero');
});

after(() => session.close());

test('the index says which sections have data', () => {
  const index = readIndex('mcp-zero');

  assert.deepEqual(index.capabilities, {
    // usage/*.md, @category and @deprecated come with the components, not the options.
    examples: true,
    categories: true,
    migrations: true,
    // Measured from the lazy build.
    sizes: true,
    guidance: false,
    accessibility: false,
    intents: false,
    rules: false,
    tokens: false,
    tokenUsage: false,
    frameworks: false,
    changelog: false,
  });
  assert.equal(index.sizes.source, 'measured');
  assert.deepEqual(index.library, { name: 'components', prefix: 'my-', package: '@my/components', version: '1.2.0' });
});

test('every tool is still registered, and the unavailable ones say so up front', async () => {
  const { tools } = await session.client.listTools();
  const unavailable = tools.filter((tool) => tool.description?.startsWith('Not available')).map((tool) => tool.name);

  assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES]);
  assert.deepEqual(unavailable, ['get_design_tokens', 'get_token_usage', 'get_framework_usage', 'get_accessibility_info']);
  assert.match(tools.find((tool) => tool.name === 'get_design_tokens')?.description ?? '', /^Not available: this library configured no design tokens\. The library's design tokens/);
  assert.match(session.client.getInstructions() ?? '', /This library has no data for: get_design_tokens, get_token_usage, get_framework_usage, get_accessibility_info\.$/);
});

const UNAVAILABLE: [string, Record<string, string>, string, string][] = [
  ['get_design_tokens', {}, 'Not available: this library configured no design tokens.', 'The `tokens` option of mcpOutputTarget().'],
  ['get_token_usage', { token: '--my-color-primary' }, 'Not available: this library configured no compiled CSS to read token usage from, or no tokens (set `tokens`, and build the `dist` output target).', 'The `tokens` option of mcpOutputTarget().'],
  ['get_framework_usage', { framework: 'react' }, 'Not available: this library configured no framework wrappers; it is used as plain custom elements (generate_snippet writes HTML and JS).', 'The `frameworks` option of mcpOutputTarget().'],
  ['get_accessibility_info', { tag: 'my-dialog' }, 'Not available: this library configured no accessibility notes.', 'The `accessibility` option of mcpOutputTarget().'],
];

for (const [tool, args, reason, enableWith] of UNAVAILABLE) {
  test(`${tool} answers "not available", naming the option that enables it`, async () => {
    assert.deepEqual(await session.call(tool, args), { available: false, reason, enableWith });
  });
}

test('generate_snippet for a framework that was not configured says which targets are', async () => {
  assert.deepEqual(await session.call('generate_snippet', { tag: 'my-button', framework: 'react' }), {
    available: false,
    reason: 'Not available: this library configured no react wrappers.',
    enableWith: 'The `frameworks.react` option of mcpOutputTarget().',
    configured: ['html', 'js'],
  });
  assert.equal((await session.call('generate_snippet', { tag: 'my-button', slots: { default: 'Save' } })).code, '<my-button>Save</my-button>');
});

test('the tools that need only docs-json work with no options', async () => {
  assert.equal((await session.call('list_components')).total, 8);
  assert.equal((await session.call('get_component_api', { tag: 'my-button' })).props.length, 6);
  assert.equal((await session.call('search_components', { query: 'dialog' })).results[0].tag, 'my-dialog');
  assert.equal((await session.call('get_component_examples', { tag: 'my-input' })).total, 1);
  assert.deepEqual((await session.call('get_component_relationships', { tag: 'my-input' })).renders, ['my-label']);
  // No intents: suggestions come from search alone.
  assert.deepEqual((await session.call('suggest_components', { description: 'a dialog' })).suggestions[0].reason, 'Matches its tag, summary, description.');
  assert.equal((await session.call('diagnose_component', { tag: 'my-card', symptom: 'css' })).areas[0], 'styling');
  assert.equal((await session.call('get_bundle_analysis', { tag: 'my-button' })).source, 'measured');
});

test('the built-in validation rules need no options; library rules and wrapper names do', async () => {
  const result = await session.call('validate_component_usage', { code: '<my-button variant="loud" icon-only></my-button><my-modal></my-modal><my-select scale="small" name="s"></my-select>' });

  // No icon-only-label: that rule is the library's.
  assert.deepEqual(result.issues.map((issue: { rule: string }) => issue.rule), ['invalid-value', 'deprecated-tag', 'deprecated-prop']);

  const jsx = await session.call('validate_component_usage', { code: '<MyButton variant="loud" className="a" />', syntax: 'jsx' });

  assert.deepEqual(jsx.issues, []);
  assert.deepEqual(jsx.notChecked, ["<MyButton> looks like a wrapper for <my-button>, but `frameworks.react` isn't configured for this library: not checked."]);
});

test('the migration guide comes from @deprecated alone', async () => {
  const guide = await session.call('get_migration_guide');

  assert.deepEqual(guide.tags, [{ from: 'my-modal', to: 'my-dialog', note: 'Use <my-dialog> instead.', removed: false }]);
  assert.equal(guide.changelog, undefined);
});

test('resources without data are still served', async () => {
  assert.deepEqual(JSON.parse((await session.read('tokens://all')).text), { tokens: [] });
  assert.match((await session.read('guide://migration')).text, /`<my-modal>` is deprecated: use `<my-dialog>`\./);
});

// Every tool, resource and prompt of the written server (fixture/mcp/server.mjs), in process.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { TOOL_NAMES } from '../src/types.ts';
import { connect, readIndex, type Session } from './helpers.ts';

let session: Session;

before(async () => {
  session = await connect();
});

after(() => session.close());

test('it introduces itself: name, version, instructions', () => {
  assert.deepEqual(session.client.getServerVersion(), { name: 'components', version: '1.2.0' });
  assert.match(session.client.getInstructions() ?? '', /^@my\/components 1\.2\.0: 8 web components, tags starting with my-\. Read-only\. Start with list_components/);
});

test('all fifteen tools are listed, read-only, with input and output schemas', async () => {
  const { tools } = await session.client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES]);

  for (const tool of tools) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, tool.name);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.outputSchema?.type, 'object', tool.name);
    assert.ok(tool.title && tool.description && !tool.description.startsWith('Not available'), tool.name);
  }
});

test('an argument outside the schema is rejected before the tool runs', async () => {
  const result = await session.client.callTool({ name: 'get_component_api', arguments: { tag: 'my-button', detail: 'everything' } });

  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Input validation error/);
});

test('list_components: tag and summary, categories with counts, paging', async () => {
  const all = await session.call('list_components');

  assert.equal(all.total, 8);
  assert.deepEqual(all.components[0], { tag: 'my-button', summary: 'A button or a link.', category: 'action' });
  assert.deepEqual(all.components.find((entry: { tag: string }) => entry.tag === 'my-modal'), { tag: 'my-modal', summary: 'The old dialog.', deprecated: 'Deprecated: use <my-dialog>.' });
  assert.deepEqual(all.categories, [
    { name: '(none)', count: 3 },
    { name: 'action', count: 1 },
    { name: 'form', count: 3 },
    { name: 'overlay', count: 1 },
  ]);
  // @mcpIgnore keeps a component out.
  assert.ok(!all.components.some((entry: { tag: string }) => entry.tag === 'my-internal'));

  const form = await session.call('list_components', { category: 'Form' });

  assert.deepEqual(form.components.map((entry: { tag: string }) => entry.tag), ['my-input', 'my-label', 'my-select']);

  const page = await session.call('list_components', { limit: 3, offset: 3 });

  assert.deepEqual(page.components.map((entry: { tag: string }) => entry.tag), ['my-icon', 'my-input', 'my-label']);
  assert.equal(page.nextOffset, 6);
  assert.match((await session.call('list_components', { category: 'nope' })).message, /No category "nope"\. The categories: \(none\), action, form, overlay\./);
});

test('get_component_api: compact by default, sections, full detail, and "did you mean"', async () => {
  const api = await session.call('get_component_api', { tag: 'my-button' });

  assert.deepEqual(api.props.find((prop: { name: string }) => prop.name === 'variant'), { name: 'variant', attribute: 'variant', values: ['ghost', 'outline', 'solid'], default: "'solid'", description: 'How much emphasis it has.' });
  assert.deepEqual(api.props.find((prop: { name: string }) => prop.name === 'iconOnly'), { name: 'iconOnly', attribute: 'icon-only', type: 'boolean', default: 'false', description: 'Shows only the icon.' });
  assert.deepEqual(api.events, [{ name: 'myClick', detail: '{ href?: string; }', description: 'Fired when the button is activated.' }]);
  assert.deepEqual(api.slots, [{ name: '(default)', description: "The button's text." }, { name: 'icon', description: 'An icon shown before the text.' }]);
  assert.deepEqual(api.parts, [{ name: 'button', description: 'The rendered `<button>` or `<a>`.' }]);
  assert.deepEqual(api.cssProperties.map((property: { name: string }) => property.name), ['--my-button-background', '--my-button-color']);
  assert.deepEqual(api.dependencies, ['my-icon']);
  assert.equal(api.examples, 2);
  assert.equal(api.guidance, undefined);

  // The prefix may be left out; a wrapper's name works too.
  assert.equal((await session.call('get_component_api', { tag: 'button' })).tag, 'my-button');
  assert.equal((await session.call('get_component_api', { tag: 'MyButton' })).tag, 'my-button');

  const only = await session.call('get_component_api', { tag: 'my-input', sections: ['events', 'guidance'] });

  assert.deepEqual(Object.keys(only).sort(), ['category', 'encapsulation', 'events', 'examples', 'formAssociated', 'found', 'guidance', 'summary', 'tag']);
  assert.equal(only.formAssociated, true);

  const full = await session.call('get_component_api', { tag: 'my-button', detail: 'full' });

  assert.match(full.description, /It renders a `my-icon` when `icon` is set\./);
  assert.equal(full.props.find((prop: { name: string }) => prop.name === 'iconOnly').description, 'Shows only the icon. Needs an `aria-label`.');
  assert.equal(full.props.find((prop: { name: string }) => prop.name === 'variant').reflect, true);
  assert.equal(full.guidance.antiPatterns[0].title, "Don't wrap it in a link");

  // A light-DOM component's slots come from its source; a prop without an attribute has none.
  const card = await session.call('get_component_api', { tag: 'my-card' });

  assert.equal(card.encapsulation, 'none');
  assert.deepEqual(card.slots.map((slot: { name: string }) => slot.name), ['(default)', 'footer', 'header']);
  assert.equal(card.props.find((prop: { name: string }) => prop.name === 'items').attribute, undefined);

  assert.deepEqual(await session.call('get_component_api', { tag: 'my-buton' }), { found: false, tag: 'my-buton', message: '<my-buton> is not a component of @my/components. Did you mean <my-button>?', suggestions: ['my-button'] });
  assert.deepEqual((await session.call('get_component_api', { tag: 'my-popup' })).suggestions[0], 'my-dialog');
});

test('search_components: weighted keywords, with where they matched', async () => {
  const { results } = await session.call('search_components', { query: 'text field' });

  assert.equal(results[0].tag, 'my-input');
  // "text" is also a value of its `type` prop.
  assert.deepEqual(results[0].matched, ['summary', 'props', 'description']);
  // Guidance is searched too.
  assert.equal((await session.call('search_components', { query: 'primary action' })).results[0].tag, 'my-button');
  assert.match((await session.call('search_components', { query: 'carousel' })).message, /Nothing matches "carousel"/);
});

test('get_component_examples: the usage files, by title', async () => {
  const examples = await session.call('get_component_examples', { tag: 'my-button' });

  assert.equal(examples.total, 2);
  assert.deepEqual(examples.examples.map((example: { title: string }) => example.title), ['basic', 'link']);
  assert.match(examples.examples[1].markdown, /<my-button href="\/contact" icon="mail">Contact us<\/my-button>/);
  assert.equal((await session.call('get_component_examples', { tag: 'my-button', title: 'link' })).total, 1);
  assert.match((await session.call('get_component_examples', { tag: 'my-icon' })).message, /has no usage examples\. generate_snippet writes one/);
});

test('get_component_relationships: what it renders, what renders it, what replaces it', async () => {
  assert.deepEqual(await session.call('get_component_relationships', { tag: 'my-modal' }), {
    found: true,
    tag: 'my-modal',
    renders: ['my-dialog'],
    renderedBy: [],
    rendersTransitively: ['my-dialog'],
    sameCategory: [],
    replacedBy: 'my-dialog',
    replaces: [],
  });

  const dialog = await session.call('get_component_relationships', { tag: 'my-dialog' });

  assert.deepEqual(dialog.renderedBy, ['my-modal']);
  assert.deepEqual(dialog.replaces, ['my-modal', 'my-popup']);
  assert.deepEqual((await session.call('get_component_relationships', { tag: 'my-input' })).sameCategory, ['my-label', 'my-select']);
});

test('get_design_tokens: CSS and DTCG tokens, by category and query', async () => {
  const all = await session.call('get_design_tokens');

  assert.equal(all.total, 8);
  assert.deepEqual(all.categories, [
    { name: '(none)', count: 1 },
    { name: 'color', count: 3 },
    { name: 'duration', count: 1 },
    { name: 'fontFamily', count: 1 },
    { name: 'spacing', count: 2 },
  ]);

  const color = await session.call('get_design_tokens', { category: 'color' });

  // The first declaration wins: the dark-mode override isn't the token's value.
  assert.deepEqual(color.tokens, [
    { name: '--my-color-primary', value: '#2563eb', category: 'color', description: 'The brand color, for primary actions.' },
    { name: '--my-color-surface', value: '#ffffff', category: 'color' },
    { name: '--my-color-text', value: '#111827', category: 'color' },
  ]);
  assert.deepEqual((await session.call('get_design_tokens', { query: 'body' })).tokens, [{ name: '--my-font-body', path: 'my.font.body', value: 'system-ui, sans-serif', category: 'fontFamily', description: 'Body text.' }]);
});

test("get_token_usage: from each component's compiled CSS, both ways round", async () => {
  assert.deepEqual(await session.call('get_token_usage', { token: 'my-color-surface' }), { found: true, token: { name: '--my-color-surface', value: '#ffffff', category: 'color' }, usedBy: ['my-button', 'my-card'] });
  assert.deepEqual((await session.call('get_token_usage', { token: 'my.font.body' })).usedBy, ['my-button']);
  assert.deepEqual((await session.call('get_token_usage', { tag: 'my-input' })).tokens, [
    { name: '--my-color-text', value: '#111827' },
    { name: '--my-radius', value: '0.375rem' },
    { name: '--my-space-2', value: '0.5rem' },
  ]);
  assert.deepEqual(await session.call('get_token_usage', { token: '--my-colour' }), { found: false, message: '--my-colour is not a token of @my/components.', suggestions: [] });
  assert.deepEqual((await session.call('get_token_usage', { token: 'my-color' })).suggestions, ['--my-color-primary', '--my-color-surface', '--my-color-text']);
});

test('get_framework_usage: the wrapper, its import, and the value binding', async () => {
  const vue = await session.call('get_framework_usage', { framework: 'vue', tag: 'my-input' });

  assert.equal(vue.import, "import { MyInput } from '@my/vue';");
  assert.deepEqual(vue.model, { syntax: 'v-model', prop: 'value', event: 'myChange' });
  assert.match(vue.code, /<MyInput v-model="value" \/>/);

  const react = await session.call('get_framework_usage', { framework: 'react', tag: 'my-button' });

  assert.equal(react.component, 'MyButton');
  assert.match(react.code, /<MyButton onMyClick=\{\(event\) => console\.log\(event\.detail\)\} \/>/);

  const angular = await session.call('get_framework_usage', { framework: 'angular' });

  assert.equal(angular.package, '@my/angular');
  assert.deepEqual(angular.model, { 'ngModel / formControlName': [{ elements: ['my-input', 'my-select'], prop: 'value', event: 'myChange' }] });
});

test('get_migration_guide: deprecated and removed names with replacements, and the changelog', async () => {
  const guide = await session.call('get_migration_guide');

  assert.deepEqual(guide.tags, [
    { from: 'my-modal', to: 'my-dialog', note: 'Use <my-dialog> instead.', removed: false },
    { from: 'my-popup', to: 'my-dialog', note: 'Removed in 1.0.', removed: true },
  ]);
  assert.deepEqual(guide.props, [
    { tag: 'my-button', from: 'kind', to: 'variant', removed: true },
    { tag: 'my-select', from: 'scale', to: 'size', note: 'Use `size` instead.', removed: false },
    { tag: 'my-select', from: 'legacy', note: 'No longer needed.', removed: false },
  ]);
  assert.deepEqual(guide.values, [{ tag: 'my-button', prop: 'variant', from: 'secondary', to: 'outline' }]);
  assert.deepEqual(guide.changelog.map((entry: { version: string }) => entry.version), ['1.2.0', '1.1.0', '1.0.0']);

  const select = await session.call('get_migration_guide', { tag: 'select' });

  assert.equal(select.tag, 'my-select');
  assert.equal(select.props.length, 2);
  assert.deepEqual(select.tags, []);
  assert.deepEqual(select.changelog.map((entry: { version: string }) => entry.version), ['1.2.0']);
  // A removed tag is not a component, but the guide knows it.
  assert.equal((await session.call('get_migration_guide', { tag: 'my-popup' })).tags[0].to, 'my-dialog');
  assert.deepEqual((await session.call('get_migration_guide', { version: 'v1.0.0' })).changelog, [{ version: '1.0.0', date: '2026-03-02', body: '- `my-popup` was removed; use `my-dialog`.\n- `my-button`: `variant="secondary"` is now `variant="outline"`.' }]);
});

test('get_bundle_analysis: sizes, and where they came from', async () => {
  const index = readIndex();
  const all = await session.call('get_bundle_analysis', { limit: 3 });

  assert.equal(all.source, 'stats');
  assert.equal(all.total, 8);
  assert.equal(all.components.length, 3);
  assert.ok(all.components[0].totalBytes >= all.components[1].totalBytes);

  const one = await session.call('get_bundle_analysis', { tag: 'my-button' });

  assert.deepEqual(one.components, [{ tag: 'my-button', ...index.sizes.components['my-button'] }]);
  assert.match(one.components[0].entry, /^p-[0-9a-f]+\.entry\.js$/);
  assert.ok((one.components[0].totalBytes ?? 0) > one.components[0].entryBytes);
});

test('get_accessibility_info: the notes as written, and which components have them', async () => {
  const dialog = await session.call('get_accessibility_info', { tag: 'my-dialog' });

  assert.equal(dialog.role, 'dialog');
  assert.deepEqual(dialog.keyboard[0], { keys: 'Escape', does: 'Closes the dialog and returns focus to what opened it.' });
  assert.deepEqual(await session.call('get_accessibility_info'), { documented: ['my-dialog'] });

  const icon = await session.call('get_accessibility_info', { tag: 'my-icon' });

  assert.match(icon.message, /No accessibility notes were written for <my-icon>/);
  assert.deepEqual(icon.labelProps, ['label']);
});

test('generate_snippet: HTML, JS and each wrapper, checked against the API', async () => {
  const html = await session.call('generate_snippet', { tag: 'my-card', props: { items: [{ title: 'a' }], elevated: true, nope: 1 }, slots: { header: '<h2>Title</h2>', default: 'Body', aside: 'x' } });

  assert.equal(html.language, 'html');
  assert.equal(
    html.code,
    '<my-card id="example" elevated>\n  <h2 slot="header">Title</h2>\n  Body\n</my-card>\n\n<script type="module">\n  const element = document.getElementById(\'example\');\n  element.items = [{"title":"a"}];\n</script>',
  );
  assert.deepEqual(html.problems, ['<my-card> has no prop `nope`: left out.', '<my-card> has no slot "aside" (its slots: default, footer, header): left out.']);

  // Required props are filled in.
  assert.equal((await session.call('generate_snippet', { tag: 'my-icon' })).code, '<my-icon name="…"></my-icon>');

  const bad = await session.call('generate_snippet', { tag: 'my-button', props: { variant: 'loud' }, events: ['click'] });

  assert.deepEqual(bad.problems, ['`variant` doesn\'t take "loud" (it takes "ghost", "outline", "solid").', '<my-button> has no event `click` (its events: myClick): left out.']);

  const js = await session.call('generate_snippet', { tag: 'my-button', framework: 'js', props: { 'icon-only': true }, events: ['myClick'] });

  assert.equal(js.code, "const element = document.createElement('my-button');\nelement.iconOnly = true;\nelement.addEventListener('myClick', (event) => {\n  console.log(event.detail);\n});\ndocument.body.append(element);");

  const react = await session.call('generate_snippet', { tag: 'my-button', framework: 'react', props: { variant: 'outline', disabled: true }, slots: { default: 'Save' }, events: ['myClick'] });

  assert.equal(react.code, "import { MyButton } from '@my/react';\n\nexport function Example() {\n  return (\n    <MyButton variant=\"outline\" disabled onMyClick={(event) => console.log(event.detail)}>Save</MyButton>\n  );\n}");

  const angular = await session.call('generate_snippet', { tag: 'my-input', framework: 'angular', props: { label: 'Email' } });

  assert.match(angular.code, /imports: \[MyInput, FormsModule\]/);
  assert.match(angular.code, /<my-input \[\(ngModel\)\]="value" label="Email"><\/my-input>/);
  assert.match((await session.call('generate_snippet', { tag: 'my-modal' })).problems[0], /<my-modal> is deprecated\. Use <my-dialog>\./);
});

test('resources: a page and an API document per component, the tokens, the migration guide', async () => {
  const { resources } = await session.client.listResources();

  assert.deepEqual(resources.map((resource) => resource.uri).sort(), [...readIndex().components.map((component) => `component://${component.tag}`), 'guide://migration', 'tokens://all']);
  assert.deepEqual((await session.client.listResourceTemplates()).resourceTemplates.map((template) => template.uriTemplate), ['component://{tag}/api.json', 'component://{tag}']);

  const page = await session.read('component://my-button');

  assert.equal(page.mimeType, 'text/markdown');
  assert.match(page.text, /^# <my-button>\n\nA button or a link\./);
  assert.match(page.text, /\| `variant` \| `variant` \| `"ghost" \\\| "outline" \\\| "solid"` \| `'solid'` \| How much emphasis it has\. \|/);
  assert.match(page.text, /## Don't\n\n- \*\*Don't wrap it in a link\.\*\*/);
  assert.match(page.text, /## Example: link/);

  const api = await session.read('component://my-dialog/api.json');
  const parsed = JSON.parse(api.text);

  assert.equal(api.mimeType, 'application/json');
  assert.equal(parsed.tag, 'my-dialog');
  assert.equal(parsed.accessibility.role, 'dialog');
  assert.deepEqual(parsed.methods.map((method: { name: string }) => method.name), ['hide', 'show']);

  assert.equal(JSON.parse((await session.read('tokens://all')).text).tokens.length, 8);
  assert.match((await session.read('guide://migration')).text, /- `<my-popup>` was removed: use `<my-dialog>`\. Removed in 1\.0\./);
  await assert.rejects(session.client.readResource({ uri: 'component://my-nope' }), /is not a component of @my\/components/);
});

test('the tag in a resource URI completes', async () => {
  const { completion } = await session.client.complete({ ref: { type: 'ref/resource', uri: 'component://{tag}' }, argument: { name: 'tag', value: 'my-i' } });

  assert.deepEqual(completion.values, ['my-icon', 'my-input']);
  assert.deepEqual((await session.client.complete({ ref: { type: 'ref/resource', uri: 'component://{tag}' }, argument: { name: 'tag', value: 'dia' } })).completion.values, ['my-dialog']);
});

test('prompts: three, each a plan that names the tools', async () => {
  const { prompts } = await session.client.listPrompts();

  assert.deepEqual(prompts.map((prompt) => prompt.name), ['build-ui', 'migrate-deprecated', 'fix-component']);
  assert.deepEqual(prompts[0].arguments?.map((argument) => [argument.name, argument.required]), [['goal', true], ['framework', false]]);

  const text = async (name: string, args: Record<string, string>) => {
    const content = (await session.client.getPrompt({ name, arguments: args })).messages[0].content;

    return content.type === 'text' ? content.text : '';
  };

  assert.match(await text('build-ui', { goal: 'a login form', framework: 'react' }), /^Build this with @my\/components's components, in react: a login form\n\n1\. Call suggest_components/);
  assert.match(await text('migrate-deprecated', { code: '<my-modal></my-modal>' }), /get_migration_guide[\s\S]*```\n<my-modal><\/my-modal>\n```$/);
  assert.match(await text('fix-component', { tag: 'my-button', problem: 'no click' }), /^<my-button> isn't behaving: no click\n\n1\. Call diagnose_component with tag "my-button"/);
  await assert.rejects(session.client.getPrompt({ name: 'build-ui', arguments: {} }));
});

test('each request is logged on one line', async () => {
  session.log.length = 0;
  await session.call('list_components');
  await session.client.readResource({ uri: 'tokens://all' });
  await session.client.getPrompt({ name: 'build-ui', arguments: { goal: 'x' } });

  assert.deepEqual(session.log.map((line) => line.replace(/\d+ms$/, 'Nms')), ['tools/call list_components Nms', 'resources/read tokens://all Nms', 'prompts/get build-ui Nms']);
});

test('a tool switched off is not registered', async () => {
  const off = await connect('mcp', { ...readIndex(), disabledTools: ['get_bundle_analysis', 'diagnose_component'] });
  const names = (await off.client.listTools()).tools.map((tool) => tool.name);

  assert.equal(names.length, 13);
  assert.ok(!names.includes('get_bundle_analysis') && !names.includes('diagnose_component'));
  await off.close();
});

test('a result over the size cap is truncated, with a note on how to ask for less', async () => {
  const index = readIndex();
  const many = Array.from({ length: 600 }, (_, i) => ({ ...index.components[0], tag: `my-generated-${String(i).padStart(3, '0')}`, summary: 'A generated component with a long enough summary to fill the response.' }));
  const big = await connect('mcp', { ...index, components: many });
  const list = await big.call('list_components', { limit: 200 });

  assert.equal(list.total, 600);
  assert.ok(list.components.length < 200);
  assert.deepEqual(list.truncated.dropped.components, { shown: list.components.length, total: 200 });
  assert.equal(list.truncated.hint, 'Pass `category`, or a smaller `limit` with `offset`.');
  await big.close();
});

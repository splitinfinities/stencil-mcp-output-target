// What a caller can cost the server: input limits, the validator's running time, and that
// generated snippets stay well-formed whatever the values.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { connect, readIndex, serverModule, type Session } from './helpers.ts';

let session: Session;

before(async () => {
  session = await connect();
});

after(() => session.close());

/** The error text of a call the server refused. */
async function refused(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await session.client.callTool({ name, arguments: args });

  assert.equal(result.isError, true, `${name} accepted ${JSON.stringify(args).slice(0, 80)}`);

  return JSON.stringify(result.content);
}

test('every string, array and object a tool takes has a limit in its schema', async () => {
  const { tools } = await session.client.listTools();

  const unbounded = (schema: Record<string, any>, path: string): string[] => [
    ...(schema.type === 'string' && !schema.enum && schema.maxLength === undefined ? [path] : []),
    ...(schema.type === 'array' && schema.maxItems === undefined ? [path] : []),
    ...(schema.type === 'object' && path.includes('.') && schema.maxProperties === undefined ? [path] : []),
    ...Object.entries(schema.properties ?? {}).flatMap(([name, property]) => unbounded(property as Record<string, any>, `${path}.${name}`)),
    ...(schema.items ? unbounded(schema.items, `${path}[]`) : []),
    ...(typeof schema.additionalProperties === 'object' ? unbounded(schema.additionalProperties, `${path}.*`) : []),
  ];

  assert.deepEqual(tools.flatMap((tool) => unbounded(tool.inputSchema, tool.name)), []);
  assert.equal(tools.find((tool) => tool.name === 'validate_component_usage')?.inputSchema.properties?.code && (tools.find((tool) => tool.name === 'validate_component_usage')?.inputSchema.properties?.code as { maxLength: number }).maxLength, 200_000);
});

test('an input over a limit is refused before the tool runs', async () => {
  assert.match(await refused('validate_component_usage', { code: 'x'.repeat(200_001) }), /Input validation error/);
  assert.match(await refused('diagnose_component', { tag: 'my-button', code: 'x'.repeat(200_001) }), /Input validation error/);
  assert.match(await refused('search_components', { query: 'button '.repeat(200) }), /Input validation error/);
  assert.match(await refused('suggest_components', { description: 'x'.repeat(1_001) }), /Input validation error/);
  assert.match(await refused('get_component_api', { tag: 'x'.repeat(1_001) }), /Input validation error/);
  assert.match(await refused('generate_snippet', { tag: 'my-button', props: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`p${i}`, 1])) }), /Input validation error/);
  assert.match(await refused('generate_snippet', { tag: 'my-button', events: Array.from({ length: 101 }, () => 'myClick') }), /Input validation error/);
  assert.match(await refused('generate_snippet', { tag: 'my-button', slots: { default: 'x'.repeat(20_001) } }), /Input validation error/);

  // Depth and total size, whatever the shape.
  let deep: unknown = 1;

  for (let i = 0; i < 2_000; i++) deep = { a: deep };
  await refused('generate_snippet', { tag: 'my-button', props: { variant: deep } });
  await refused('generate_snippet', { tag: 'my-card', props: { items: Array.from({ length: 1_001 }, () => 1) } });

  // At the limit, it runs.
  assert.equal((await session.call('validate_component_usage', { code: 'x'.repeat(200_000) })).valid, true);
  assert.equal((await session.call('search_components', { query: 'x'.repeat(1_000) })).results.length, 0);
});

/** Milliseconds for one validation. */
async function timed(code: string, syntax: string): Promise<number> {
  const start = performance.now();

  await session.call('validate_component_usage', { code, syntax });

  return performance.now() - start;
}

test("the validator's time grows with the code, not with its square", async () => {
  const cases: [string, string, string][] = [
    ['jsx', 'tags with a bound attribute', '<MyButton variant={kind} onMyClick={() => go()} />\n'],
    ['jsx', 'bound attributes on one tag', ''],
    ['html', 'valid elements', '<my-button variant="outline">Save</my-button>\n'],
    ['html', 'unknown tags', '<my-nope></my-nope>\n'],
    ['html', 'unclosed block elements', '<div>'],
    ['html', 'attributes on one tag', ''],
    ['vue', 'bound attributes', '<MyInput :type="kind" @myChange="save" name="a" />\n'],
  ];

  for (const [syntax, name, unit] of cases) {
    const one = syntax === 'jsx' ? (chars: number) => `<MyButton ${'a={1} '.repeat(Math.floor(chars / 6) - 2)}/>` : (chars: number) => `<my-button ${Array.from({ length: Math.floor(chars / 12) }, (_, i) => `zz${i}="1"`).join(' ')}></my-button>`;
    const build = (chars: number) => (unit ? unit.repeat(Math.floor(chars / unit.length)) : one(chars));

    // Warm up, then an eighth of the largest input a call may carry, and all of it. The best of
    // three each: the other test files run at the same time.
    await timed(build(20_000), syntax);
    const best = async (chars: number) => Math.min(await timed(build(chars), syntax), await timed(build(chars), syntax), await timed(build(chars), syntax));
    const eighth = await best(25_000);
    const full = await best(200_000);

    assert.ok(full < 3_000, `${syntax}, ${name}: 200,000 characters took ${full.toFixed(0)}ms`);
    // Eight times the input: linear is 8x, quadratic 64x.
    assert.ok(full < Math.max(eighth, 2) * 24, `${syntax}, ${name}: ${eighth.toFixed(1)}ms for 25,000 characters, ${full.toFixed(1)}ms for 200,000`);

    if (process.env.MCP_TIMINGS) console.log(`${syntax}, ${name}: ${eighth.toFixed(1)}ms → ${full.toFixed(1)}ms`);
  }
});

test('markup nested deeper than any real page is cut off, and says so', async () => {
  const deep = await session.call('validate_component_usage', { code: `${'<div>'.repeat(30_000)}<my-buton></my-buton>` });

  assert.deepEqual(deep.notChecked, ['Elements nested more than 1,000 deep at line 1: the rest of the code was not checked.']);
  assert.deepEqual(deep.issues, []);

  // Closed, self-closed, void and optional-end elements don't count as depth.
  const flat = await session.call('validate_component_usage', { code: `<ul>${'<li>item'.repeat(3_000)}</ul>${'<div><br><my-icon name="x"></my-icon></div>'.repeat(2_000)}<my-buton></my-buton>` });

  assert.deepEqual(flat.notChecked, []);
  assert.deepEqual(flat.issues.map((issue: { rule: string }) => issue.rule).slice(-1), ['unknown-tag']);

  // Nor does an element that closes itself, where the syntax allows it.
  assert.deepEqual((await session.call('validate_component_usage', { syntax: 'vue', code: '<MyIcon name="x" />\n'.repeat(3_000) })).notChecked, []);

  // At the limit it is still read.
  const edge = await session.call('validate_component_usage', { code: `${'<div>'.repeat(999)}<my-buton></my-buton>` });

  assert.deepEqual(edge.issues.map((issue: { rule: string }) => issue.rule), ['unknown-tag']);
});

test('a long list of issues stops at 100, and says how many more there are', async () => {
  const result = await session.call('validate_component_usage', { code: '<my-icon></my-icon>\n'.repeat(1_000) });

  assert.equal(result.valid, false);
  assert.equal(result.issues.length, 100);
  assert.equal(result.issues[99].line, 100);
  assert.deepEqual(result.notChecked, ['900 more issues after line 100 are not listed: fix these and validate again.']);
  assert.equal(result.truncated, undefined);
});

test('a tag with more attributes than any real one is cut off, and says so', async () => {
  const attributes = (count: number) => Array.from({ length: count }, (_, i) => `data-a${i}="1"`).join(' ');
  const over = await session.call('validate_component_usage', { code: `<my-button variant="loud"\n ${attributes(600)}>x</my-button><my-buton></my-buton>` });

  assert.deepEqual(over.notChecked, ['More than 500 attributes on <my-button> at line 2: the rest of the code was not checked.']);
  // What was read before the limit is still checked.
  assert.deepEqual(over.issues.map((issue: { rule: string }) => issue.rule), ['invalid-value']);

  const under = await session.call('validate_component_usage', { code: `<my-button ${attributes(499)}>x</my-button><my-buton></my-buton>` });

  assert.deepEqual(under.notChecked, []);
  assert.deepEqual(under.issues.map((issue: { rule: string }) => issue.rule), ['unknown-tag']);

  // A long value is one attribute, however long.
  assert.deepEqual((await session.call('validate_component_usage', { code: `<my-button href="${'a b '.repeat(20_000)}">x</my-button>` })).notChecked, []);
});

test('jsx: a value is what follows `=`, however it is spaced; anything else in braces is a spread', async () => {
  const result = await session.call('validate_component_usage', { syntax: 'jsx', code: '<MyButton variant = {kind} size=\n  {size} href="/a" {...rest} {...more}>Go</MyButton>' });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.notChecked, [
    'Spread attributes ({...rest}) on <my-button>, line 2: required props and unknown names were not checked there.',
    'Spread attributes ({...more}) on <my-button>, line 2: required props and unknown names were not checked there.',
    '<my-button variant> is bound at runtime (dynamic, not checked).',
    '<my-button size> is bound at runtime (dynamic, not checked).',
    // icon-only might be in the spread.
    'Rule icon-only-label on <my-button>, line 1: depends on a value bound at runtime (not checked).',
  ]);

  // A brace after a quoted value is not that attribute's value.
  const after = await session.call('validate_component_usage', { syntax: 'jsx', code: '<MyIcon name="x" {...rest} />' });

  assert.deepEqual(after.notChecked, ['Spread attributes ({...rest}) on <my-icon>, line 1: required props and unknown names were not checked there.']);
});

test('a snippet stays well-formed whatever a value holds', async () => {
  const hostile = ["it's", '</script><img src=x onerror=alert(1)>', "x' (click)='alert(1)", 'a & b', '"quoted"'];
  const code = async (framework: string, props: Record<string, unknown>) => (await session.call('generate_snippet', { tag: 'my-card', framework, props })).code as string;

  const vue = await code('vue', { items: hostile });

  assert.match(vue, /<MyCard\n    :items='\[[^']*\]'\n  \/>/);
  assert.ok(vue.includes('it&#39;s') && vue.includes('a &amp; b') && !vue.includes("(click)='alert"));

  const angular = await code('angular', { items: hostile });

  assert.match(angular, /<my-card\n      \[items\]='\[[^']*\]'\n    ><\/my-card>/);
  assert.ok(!angular.includes("(click)='alert"));

  const html = await code('html', { items: hostile });
  const script = html.slice(html.indexOf('<script'));

  assert.equal(script.match(/<\/script>/g)?.length, 1);
  assert.ok(script.includes('\\u003c/script>\\u003cimg') && !script.includes('<img'));
  // The escapes are JavaScript's own: the script still sets the same value.
  assert.deepEqual(JSON.parse(script.match(/element\.items = (.*);/)?.[1] ?? ''), hostile);

  // A string value in an attribute, in every target.
  const button = async (framework: string) => (await session.call('generate_snippet', { tag: 'my-button', framework, props: { href: '"><script>alert(1)</script>' } })).code as string;

  for (const framework of ['html', 'react', 'vue', 'angular']) assert.ok((await button(framework)).includes('href="&quot;><script>alert(1)</script>"'), framework);
});

test('servers over one index share its lookups and compiled schemas, and stay independent', async () => {
  const module = await serverModule();
  const index = readIndex();
  const start = performance.now();
  const servers = Array.from({ length: 50 }, () => module.createServer(index));
  const each = (performance.now() - start) / servers.length;

  assert.ok(each < 3, `createServer took ${each.toFixed(2)}ms each`);

  // A tool switched off in one index is still on in another.
  const off = await connect('mcp', { ...index, disabledTools: ['generate_snippet'] });
  const on = await connect('mcp', index);

  assert.equal((await off.client.listTools()).tools.length, 14);
  assert.equal((await on.client.listTools()).tools.length, 15);
  assert.equal((await on.call('generate_snippet', { tag: 'my-icon' })).code, '<my-icon name="…"></my-icon>');
  await off.close();
  await on.close();
});

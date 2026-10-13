// Golden cases for the three tools that judge: validate_component_usage, suggest_components and
// diagnose_component. Each case is markup or a sentence, and exactly what the tool says of it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { connect, readIndex, type Session } from './helpers.ts';

let session: Session;

before(async () => {
  session = await connect();
});

after(() => session.close());

/** `rule@line tag[attribute]` per issue, in order. */
async function issues(code: string, syntax?: string): Promise<string[]> {
  const result = await session.call('validate_component_usage', syntax ? { code, syntax } : { code });

  return result.issues.map((issue: { rule: string; severity: string; line: number; tag: string; attribute?: string }) => `${issue.severity} ${issue.rule}@${issue.line} ${issue.tag}${issue.attribute ? `[${issue.attribute}]` : ''}`);
}

const VALID = [
  '<my-button variant="outline" size="small" disabled>Save</my-button>',
  '<my-button icon-only aria-label="Close"><my-icon slot="icon" name="x"></my-icon></my-button>',
  '<form><my-input name="email" type="email" label="Email" required></my-input><my-select name="plan" size="small"><option>A</option></my-select></form>',
  '<my-card class="wide" data-test="c" id="main"><h2 slot="header">T</h2><p>Body</p><div slot="footer">F</div></my-card>',
  '<my-dialog open><h2 slot="heading">Sure?</h2></my-dialog>',
  '<div><x-other foo="bar"></x-other><button onclick="go()">Native</button></div>',
];

for (const code of VALID) {
  test(`valid: ${code.slice(0, 60)}`, async () => {
    const result = await session.call('validate_component_usage', { code });

    assert.deepEqual(result.issues, []);
    assert.equal(result.valid, true);
    assert.equal(result.syntax, 'html');
  });
}

const HTML: [string, string, string[]][] = [
  ['an unknown tag within the prefix', '<my-buton>Save</my-buton>', ['error unknown-tag@1 my-buton']],
  ['a removed tag, with its replacement', '<my-popup></my-popup>', ['error removed-tag@1 my-popup']],
  ['a deprecated tag', '<my-modal open></my-modal>', ['warning deprecated-tag@1 my-modal']],
  ['an unknown attribute', '<my-button colour="red">x</my-button>', ['warning unknown-attribute@1 my-button[colour]']],
  ['the JS name written as an attribute', '<my-button iconOnly aria-label="x"></my-button>', ['error unknown-attribute@1 my-button[iconOnly]']],
  ['a prop that has no attribute', '<my-card items="[1]"></my-card>', ['error property-only@1 my-card[items]']],
  ['a value outside the enum', '<my-button variant="loud">x</my-button>', ['error invalid-value@1 my-button[variant]']],
  ['a replaced value', '<my-button variant="secondary">x</my-button>', ['error deprecated-value@1 my-button[variant]']],
  ['a removed prop', '<my-button kind="primary">x</my-button>', ['error removed-prop@1 my-button[kind]']],
  ['a deprecated prop', '<my-select name="a" scale="small"></my-select>', ['warning deprecated-prop@1 my-select[scale]']],
  ['a missing required prop', '<my-icon></my-icon>', ['error missing-required-prop@1 my-icon[name]']],
  ['a boolean attribute written "false"', '<my-button disabled="false">x</my-button>', ['error boolean-attribute-false@1 my-button[disabled]']],
  ['a form control without a name, in a form', '<form>\n<my-input label="Email"></my-input>\n</form>', ['warning form-control-without-name@2 my-input[name]']],
  ['a form control without a name, outside one', '<my-input></my-input>', ['info form-control-without-name@1 my-input[name]']],
  ['a slot the component does not have', '<my-button><span slot="prefix">a</span>x</my-button>', ['error unknown-slot@1 span[slot]']],
  ['wrapping a component in one it already renders', '<my-label>\n  <my-input name="a"></my-input>\n</my-label>', ['warning redundant-nesting@2 my-input']],
  ['a custom element that self-closes', '<my-icon name="x" />\n<p>after</p>', ['error self-closing-custom-element@1 my-icon']],
  ['a library rule: require', '<my-button icon-only></my-button>', ['error icon-only-label@1 my-button']],
  ['a library rule: forbid', '<my-card>\n<my-card></my-card>\n</my-card>', ['error no-card-in-card@2 my-card']],
  ['several, in line order', '<my-modal></my-modal>\n<my-icon></my-icon>\n<my-button variant="loud" disabled="false">x</my-button>', [
    'warning deprecated-tag@1 my-modal',
    'error missing-required-prop@2 my-icon[name]',
    'error invalid-value@3 my-button[variant]',
    'error boolean-attribute-false@3 my-button[disabled]',
  ]],
];

for (const [name, code, expected] of HTML) {
  test(`html: ${name}`, async () => assert.deepEqual(await issues(code), expected));
}

test('an issue says what to write instead', async () => {
  const { issues: found, valid } = await session.call('validate_component_usage', { code: '<my-button variant="secondary" iconOnly>x</my-button><my-buton></my-buton>' });

  assert.equal(valid, false);
  assert.deepEqual(found, [
    { rule: 'deprecated-value', severity: 'error', attribute: 'variant', message: 'variant="secondary" was replaced by "outline".', suggestion: 'variant="outline"', tag: 'my-button', line: 1 },
    { rule: 'unknown-attribute', severity: 'error', attribute: 'iconOnly', message: 'The attribute is `icon-only` (`iconOnly` is the JS property).', suggestion: 'icon-only', tag: 'my-button', line: 1 },
    { rule: 'unknown-tag', severity: 'error', message: '<my-buton> is not a component of @my/components. Did you mean <my-button>?', suggestion: '<my-button>', tag: 'my-buton', line: 1 },
  ]);
});

test('warnings and notes do not make markup invalid', async () => {
  const result = await session.call('validate_component_usage', { code: '<my-modal></my-modal><my-input></my-input>' });

  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 2);
});

test('code with none of the library\'s components says so', async () => {
  assert.equal((await session.call('validate_component_usage', { code: '<div>plain</div>' })).message, 'No @my/components components in this code (its tags start with my-).');
});

test('jsx: wrapper names, JS prop names, onEvent handlers; bound values are dynamic, never errors', async () => {
  const code = ['export const Form = ({ kind, rest }) => (', '  <>', '    <MyButton variant={kind} iconOnly onMyClick={() => (a > b ? go() : stop())} onMyClik={go} {...rest}>Go</MyButton>', '    <MyInput type="number" name="n" />', '    <my-button variant="loud" className="x" key="k">raw</my-button>', '  </>', ');'].join('\n');
  const result = await session.call('validate_component_usage', { code });

  assert.equal(result.syntax, 'jsx');
  assert.equal(result.syntaxGuessed, true);
  assert.deepEqual(result.components, ['my-button', 'my-input']);
  assert.deepEqual(
    result.issues.map((issue: { rule: string; line: number; attribute?: string }) => `${issue.rule}@${issue.line}[${issue.attribute ?? ''}]`),
    ['unknown-event@3[onMyClik]', 'invalid-value@4[type]', 'invalid-value@5[variant]'],
  );
  assert.deepEqual(result.notChecked, [
    'Spread attributes ({...rest}) on <my-button>, line 3: required props and unknown names were not checked there.',
    '<my-button variant> is bound at runtime (dynamic, not checked).',
    'Rule icon-only-label on <my-button>, line 3: depends on a value bound at runtime (not checked).',
  ]);
});

test('jsx: a multi-line expression keeps the line numbers after it', async () => {
  const code = '<MyButton\n  onMyClick={() => {\n    go();\n  }}\n  variant="loud"\n/>\n<MyIcon />';

  assert.deepEqual(await issues(code, 'jsx'), ['error invalid-value@1 my-button[variant]', 'error missing-required-prop@7 my-icon[name]']);
});

test('vue: bound props, @events, v-model, and slot directives', async () => {
  const code = ['<template>', '  <MyInput v-model="email" :type="kind" @myChange="save" @nope="x" />', '  <my-select :size="\'small\'" @my-change.once="save" name="s" />', '  <my-dialog><template #footer>F</template><template v-slot:heading>H</template></my-dialog>', '</template>'].join('\n');
  const result = await session.call('validate_component_usage', { code });

  assert.equal(result.syntax, 'vue');
  assert.deepEqual(
    result.issues.map((issue: { rule: string; line: number; tag: string; attribute?: string }) => `${issue.rule}@${issue.line} ${issue.tag}[${issue.attribute ?? ''}]`),
    ['unknown-event@2 my-input[@nope]', 'unknown-slot@4 template[slot]'],
  );
  assert.deepEqual(result.notChecked, ['<my-input :type> is bound at runtime (dynamic, not checked).', '<my-select :size> is bound at runtime (dynamic, not checked).']);
});

test('angular: [props], (events), [(ngModel)], [attr.x], and structural directives', async () => {
  const code = '<my-input *ngIf="show" #field [(ngModel)]="email" [type]="kind" (myChange)="save($event)" (nope)="x()" [bogus]="1" [attr.aria-label]="label"></my-input>\n<my-button [iconOnly]="true" (click)="go()">x</my-button>';
  const result = await session.call('validate_component_usage', { code });

  assert.equal(result.syntax, 'angular');
  assert.deepEqual(
    result.issues.map((issue: { rule: string; line: number; attribute?: string }) => `${issue.rule}@${issue.line}[${issue.attribute ?? ''}]`),
    ['unknown-event@1[(nope)]', 'unknown-prop@1[[bogus]]', 'icon-only-label@2[]'],
  );
});

test('the syntax can be given, and is otherwise guessed', async () => {
  const guess = async (code: string) => (await session.call('validate_component_usage', { code })).syntax;

  assert.equal(await guess('<my-button class="a">x</my-button>'), 'html');
  assert.equal(await guess('<MyButton className="a">x</MyButton>'), 'jsx');
  assert.equal(await guess('<my-button :variant="v">x</my-button>'), 'vue');
  assert.equal(await guess('<my-button [variant]="v">x</my-button>'), 'angular');

  const given = await session.call('validate_component_usage', { code: '<my-button variant="outline">x</my-button>', syntax: 'vue' });

  assert.equal(given.syntax, 'vue');
  assert.equal(given.syntaxGuessed, undefined);
});

test('an unclosed expression is reported, not silently passed', async () => {
  const result = await session.call('validate_component_usage', { code: '<MyButton onMyClick={() => {>x</MyButton>', syntax: 'jsx' });

  assert.deepEqual(result.notChecked, ['An unclosed { on line 1: the rest of the code was not checked.']);
});

const SUGGEST: [string, string[]][] = [
  ['a modal that confirms deleting a row', ['my-dialog', 'my-modal']],
  ['I need a dropdown to pick a plan', ['my-select']],
  ['replacement for the native <select>', ['my-select']],
  ['a text field for an email address', ['my-input']],
  ['a card with a header and footer', ['my-card']],
  ['primary action for the page', ['my-button']],
];

for (const [description, expected] of SUGGEST) {
  test(`suggest: ${description}`, async () => {
    const { suggestions } = await session.call('suggest_components', { description });

    assert.deepEqual(suggestions.slice(0, expected.length).map((suggestion: { tag: string }) => suggestion.tag), expected);
  });
}

test('suggest: an intent that is also an ordinary word counts only when written as a tag', async () => {
  const index = readIndex();
  const custom = await connect('mcp', { ...index, intents: { ...index.intents, a: 'my-button' } });
  const tags = async (description: string) => (await custom.call('suggest_components', { description })).suggestions.map((suggestion: { tag: string }) => suggestion.tag);

  assert.deepEqual(await tags('a text field'), ['my-input']);
  assert.deepEqual((await tags('instead of a native <a>'))[0], 'my-button');
  await custom.close();
});

test('suggest: the reason says why, and a deprecated component says so', async () => {
  const { suggestions } = await session.call('suggest_components', { description: 'a modal' });

  assert.deepEqual(suggestions, [
    { tag: 'my-dialog', summary: 'A modal dialog.', reason: '"modal" is <my-dialog> in this library.', category: 'overlay' },
    { tag: 'my-modal', summary: 'The old dialog.', reason: 'Matches its tag.', deprecated: 'Deprecated: use <my-dialog>.' },
  ]);
  assert.match((await session.call('suggest_components', { description: 'zzz qqq' })).message, /Nothing in @my\/components matches that/);
});

const DIAGNOSE: [string, string, string[], RegExp][] = [
  ['my-button', 'my click handler never fires', ['events'], /Its events are `myClick`, spelled exactly so/],
  ['my-dialog', 'the close event listener on the parent is never called', ['events'], /`myClose` don't bubble\./],
  ['my-card', 'the items attribute is ignored', ['props'], /`items` have no attribute/],
  ['my-button', 'disabled="false" still disables it', ['props'], /`disabled`, `icon-only` are boolean attributes/],
  ['my-button', "my css color doesn't apply", ['styling'], /It renders in a shadow root/],
  ['my-card', 'page styles leak into it', ['styling'], /It renders in the light DOM \(encapsulation: none\)/],
  ['my-input', "the value isn't in the form data on submit", ['forms'], /It is form-associated: it posts with its <form> like a native control, under its `name`\./],
  ['my-button', 'it is not submitted with the form', ['forms'], /<my-button> is not form-associated/],
  ['my-button', 'my icon child does not show up', ['slots'], /Its slots: the default slot, "icon"\./],
  ['my-icon', 'nothing renders, the element is blank', ['rendering'], /It has required props: `name`\./],
  ['my-dialog', 'keyboard focus escapes it', ['accessibility'], /Tab: Cycles through the dialog/],
];

for (const [tag, symptom, areas, cause] of DIAGNOSE) {
  test(`diagnose: <${tag}> ${symptom}`, async () => {
    const result = await session.call('diagnose_component', { tag, symptom });

    assert.deepEqual(result.areas, areas);
    assert.ok(result.causes.some((entry: { cause: string }) => cause.test(entry.cause)), JSON.stringify(result.causes, null, 1));
  });
}

test('diagnose: styling names the custom properties, parts and tokens to use', async () => {
  const { causes } = await session.call('diagnose_component', { tag: 'my-button', symptom: 'cannot change its background color' });

  assert.deepEqual(causes.map((entry: { fix: string }) => entry.fix), [
    'Use its CSS custom properties and ::part() names, below.',
    'Set on the element or an ancestor: `--my-button-background`, `--my-button-color`.',
    'my-button::part(button)',
    'Changing one changes it everywhere it is read: `--my-color-primary`, `--my-color-surface`, `--my-font-body`, `--my-radius`, `--my-space-2`, `--my-space-4`.',
  ]);
});

test("diagnose: the library's own guidance is a cause when it matches the symptom", async () => {
  const { causes } = await session.call('diagnose_component', { tag: 'my-button', symptom: 'wrapped in a link it navigates twice' });
  const guidance = causes.find((entry: { area: string }) => entry.area === 'guidance');

  assert.deepEqual(guidance, { area: 'guidance', cause: "Don't wrap it in a link: Give it an href instead: it renders the link itself.", fix: '<my-button href="/x">Go</my-button>', bad: '<a href="/x"><my-button>Go</my-button></a>' });
});

test('diagnose: a vague symptom covers every area; code is validated too; a deprecated tag leads', async () => {
  const vague = await session.call('diagnose_component', { tag: 'my-modal', symptom: 'broken', code: '<my-modal open="false"></my-modal>' });

  assert.deepEqual(vague.areas, ['rendering', 'events', 'props', 'styling', 'forms', 'slots', 'accessibility']);
  assert.deepEqual(vague.causes[0], { area: 'deprecation', cause: '<my-modal> is deprecated. Use <my-dialog> instead.', fix: 'Use <my-dialog>.' });
  assert.equal(vague.validation.valid, false);
  assert.deepEqual(vague.validation.issues.map((issue: { rule: string }) => issue.rule), ['boolean-attribute-false', 'deprecated-tag']);
});

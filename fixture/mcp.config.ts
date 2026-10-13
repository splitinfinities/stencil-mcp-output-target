// The fixture's options: one of everything, so every tool has data.
export default {
  categories: { 'my-input': 'form', 'my-select': 'form', 'my-label': 'form', 'my-button': 'action' },
  guidance: {
    'my-button': {
      antiPatterns: [{ title: "Don't wrap it in a link", description: 'Give it an href instead: it renders the link itself.', bad: '<a href="/x"><my-button>Go</my-button></a>', good: '<my-button href="/x">Go</my-button>' }],
      bestPractices: [{ title: 'One primary action per view', description: 'Use variant="outline" for the rest.', example: '<my-button>Save</my-button>\n<my-button variant="outline">Cancel</my-button>' }],
    },
  },
  accessibility: {
    'my-dialog': {
      role: 'dialog',
      keyboard: [
        { keys: 'Escape', does: 'Closes the dialog and returns focus to what opened it.' },
        { keys: 'Tab', does: 'Cycles through the dialog; focus never leaves it while open.' },
      ],
      aria: ['aria-modal="true" while open', 'aria-labelledby its heading'],
      notes: ['Give it a heading: it is the dialog\'s accessible name.'],
    },
  },
  intents: { modal: 'my-dialog', popup: 'my-dialog', select: 'my-select', dropdown: 'my-select', 'text field': 'my-input', input: 'my-input' },
  rules: [
    { id: 'icon-only-label', tag: 'my-button', when: { attr: 'icon-only' }, require: { attr: 'aria-label' }, message: 'An icon-only button needs aria-label.' },
    { id: 'no-card-in-card', tag: 'my-card', forbid: { parent: 'my-card' }, message: 'Cards do not nest.' },
  ],
  tokens: ['src/tokens.css', 'src/tokens.json'],
  tokenCategories: { 'my-color': 'color', 'my-space': 'spacing' },
  frameworks: {
    react: { package: '@my/react' },
    vue: { package: '@my/vue', models: [{ elements: ['my-input', 'my-select'], event: 'myChange', targetAttr: 'value' }] },
    angular: { package: '@my/angular', valueAccessors: [{ elements: ['my-input', 'my-select'], event: 'myChange', targetAttr: 'value', type: 'text' }] },
  },
  migrations: {
    tags: { 'my-popup': { to: 'my-dialog', note: 'Removed in 1.0.' } },
    props: { 'my-button': { kind: 'variant' } },
    values: { 'my-button': { variant: { secondary: 'outline' } } },
  },
  changelog: 'CHANGELOG.md',
  stats: 'stats.json',
};

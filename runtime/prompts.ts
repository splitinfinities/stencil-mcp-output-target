import type { Library } from './library.ts';

// Prompts are experimental until 0.1.0: they were written before the tools had real use.

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  text(library: Library, args: Record<string, string | undefined>): string;
}

export const PROMPTS: PromptDefinition[] = [
  {
    name: 'build-ui',
    title: 'Build UI with the library',
    description: "Build a piece of UI from this library's components, checked against their real API. (Experimental.)",
    arguments: [
      { name: 'goal', description: 'What to build.', required: true },
      { name: 'framework', description: 'html, js, react, vue or angular. Default: html.', required: false },
    ],
    text: (library, args) =>
      [
        `Build this with ${library.label}'s components${args.framework ? `, in ${args.framework}` : ''}: ${args.goal ?? ''}`,
        '',
        '1. Call suggest_components with the goal (and list_components if nothing fits) to choose components. Prefer a library component to a native element or hand-written markup, and never a deprecated one.',
        '2. Call get_component_api for each component you will use. Use only props, slots and events it lists.',
        `3. Write the markup${args.framework && args.framework !== 'html' ? ' (get_framework_usage shows the imports and binding syntax)' : ''}. Use design tokens (get_design_tokens) rather than hard-coded colors and spacing.`,
        '4. Call validate_component_usage on the result and fix every error and warning before answering.',
      ].join('\n'),
  },
  {
    name: 'migrate-deprecated',
    title: 'Migrate deprecated usage',
    description: 'Replace deprecated and removed tags, props and values in some code. (Experimental.)',
    arguments: [{ name: 'code', description: 'The code to migrate. Left out: the files you have open.', required: false }],
    text: (library, args) =>
      [
        `Migrate ${args.code ? 'this code' : 'the code at hand'} off everything ${library.label} has deprecated or removed.`,
        '',
        '1. Call get_migration_guide for the list of replacements.',
        '2. Call validate_component_usage on the code: it reports each deprecated tag, prop and value with its replacement and line.',
        '3. Apply the replacements. Where a replacement has a different API, call get_component_api for it rather than guessing.',
        '4. Validate again until no deprecation is reported. Say which deprecations have no automatic replacement.',
        ...(args.code ? ['', '```', args.code, '```'] : []),
      ].join('\n'),
  },
  {
    name: 'fix-component',
    title: 'Fix a component problem',
    description: "Find why a component isn't behaving and fix its usage. (Experimental.)",
    arguments: [
      { name: 'tag', description: 'The component.', required: true },
      { name: 'problem', description: 'What goes wrong.', required: true },
      { name: 'code', description: 'The markup that misbehaves.', required: false },
    ],
    text: (_library, args) =>
      [
        `<${args.tag ?? ''}> isn't behaving: ${args.problem ?? ''}`,
        '',
        `1. Call diagnose_component with tag "${args.tag ?? ''}", the problem as \`symptom\`${args.code ? ', and the code below as `code`' : ''}.`,
        '2. Check the causes against the code, most specific first. Call get_component_api to confirm names before changing them.',
        '3. Fix the usage, then call validate_component_usage on the result.',
        "4. If the usage is right and it still fails, say so: the cause is then in how the library is loaded, or in the component itself.",
        ...(args.code ? ['', '```', args.code, '```'] : []),
      ].join('\n'),
  },
];

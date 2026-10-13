import { FRAMEWORK_NAMES, type FrameworkName } from '../../src/types.ts';
import { diagnose } from '../diagnose.ts';
import { deprecationNote } from '../library.ts';
import type { Json, Result } from '../respond.ts';
import { notAvailable } from '../respond.ts';
import { suggest } from '../search.ts';
import { snippet, TARGETS, valueBinding, type PropValue, type SnippetRequest, type Target } from '../snippet.ts';
import { integer, LIST, MAX_CODE_CHARS, strings, TAG, text, type ToolDefinition } from '../tool.ts';
import { SYNTAXES, validate, type Syntax, type Validation } from '../validate.ts';

const isSyntax = (value: Json): value is Syntax => SYNTAXES.some((syntax) => syntax === value);

const isTarget = (value: Json): value is Target => TARGETS.some((target) => target === value);

const isFramework = (value: Json): value is FrameworkName => FRAMEWORK_NAMES.some((framework) => framework === value);

function isPropValue(value: Json): value is PropValue {
  return value !== undefined && (typeof value !== 'object' || value === null || (Array.isArray(value) ? value.every(isPropValue) : Object.values(value).every(isPropValue)));
}

const validation = (result: Validation): Result => ({
  valid: result.valid,
  syntax: result.syntax,
  syntaxGuessed: result.syntaxGuessed || undefined,
  components: result.components,
  issues: result.issues.map((issue) => ({ ...issue })),
  notChecked: result.notChecked,
});

export const validateComponentUsage: ToolDefinition = {
  name: 'validate_component_usage',
  title: 'Validate markup',
  description:
    "Checks markup that uses the library's components against their real API: unknown tags, attributes, slots and events; values outside an enum; missing required props; deprecated names with their replacements; boolean attributes written \"false\"; form controls without a name; redundant nesting; and the library's own rules. Reads HTML, JSX, Vue and Angular templates. Run it on markup before returning it. `valid` is false only for errors; values bound at runtime are listed in `notChecked`, never reported.",
  input: {
    properties: {
      code: { type: 'string', maxLength: MAX_CODE_CHARS, description: `The markup: a fragment, a template, or a component file. Up to ${MAX_CODE_CHARS.toLocaleString('en-US')} characters; validate a larger file in pieces.` },
      syntax: { type: 'string', enum: SYNTAXES, description: 'How attribute names are read. Guessed from the code when left out.' },
    },
    required: ['code'],
  },
  output: {
    valid: { type: 'boolean' },
    syntax: { type: 'string' },
    syntaxGuessed: { type: 'boolean' },
    components: LIST({ type: 'string' }, "The library's tags found in the code."),
    issues: LIST({ type: 'object' }, 'rule, severity (error, warning, info), message, tag, attribute, line, suggestion.'),
    notChecked: LIST({ type: 'string' }, 'What was bound at runtime or could not be read.'),
  },
  hint: 'Validate a smaller piece of the code.',
  run(library, args) {
    const code = typeof args.code === 'string' ? args.code : '';
    const result = validation(validate(library, code, isSyntax(args.syntax) ? args.syntax : undefined));

    if (Array.isArray(result.components) && result.components.length === 0 && Array.isArray(result.issues) && result.issues.length === 0) {
      result.message = `No ${library.label} components in this code${library.prefix ? ` (its tags start with ${library.prefix})` : ''}.`;
    }

    return result;
  },
};

export const suggestComponents: ToolDefinition = {
  name: 'suggest_components',
  title: 'Suggest components',
  description: 'Which components fit a described need ("a modal that confirms deleting a row", "a native <select> replacement"). Uses the names the library\'s authors mapped to components, then keyword search. Returns the best few with the reason for each.',
  input: {
    properties: { description: { type: 'string', description: 'What the UI should do, in plain words. A native tag name works too.' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 } },
    required: ['description'],
  },
  output: { suggestions: LIST({ type: 'object' }, 'tag, summary, reason, category, and `deprecated` when it is.') },
  run(library, args) {
    const description = text(args.description) ?? '';

    const suggestions = suggest(library, description, integer(args.limit, 5, 1, 20)).flatMap((suggestion): Result[] => {
      const component = library.byTag.get(suggestion.tag);

      return component ? [{ tag: component.tag, summary: component.summary, reason: suggestion.reason, category: component.category, deprecated: deprecationNote(component.deprecation) }] : [];
    });

    return suggestions.length > 0 ? { suggestions } : { suggestions, message: `Nothing in ${library.label} matches that. list_components shows everything it has.` };
  },
};

export const diagnoseComponent: ToolDefinition = {
  name: 'diagnose_component',
  title: 'Diagnose a problem',
  description:
    "Likely causes for a problem with one component (\"doesn't render\", \"click handler never fires\", \"my CSS doesn't apply\", \"value isn't posted\"), read from its own metadata: its event names, which props have no attribute, whether it has a shadow root, its slots, parts and custom properties, whether it takes part in forms. Pass `code` to have it validated too.",
  input: {
    properties: {
      tag: TAG,
      symptom: { type: 'string', description: "What goes wrong, in plain words. Left out, every area is covered." },
      code: { type: 'string', maxLength: MAX_CODE_CHARS, description: 'The markup that misbehaves. Validated as validate_component_usage does.' },
      syntax: { type: 'string', enum: SYNTAXES },
    },
    required: ['tag'],
  },
  output: {
    tag: { type: 'string' },
    areas: LIST({ type: 'string' }, 'The areas the symptom pointed at.'),
    causes: LIST({ type: 'object' }, 'area, cause, fix.'),
    validation: { type: 'object', description: 'The result of validating `code`, when given.' },
  },
  hint: 'Describe the symptom more specifically.',
  run(library, args) {
    const tag = text(args.tag) ?? '';
    const component = library.find(tag);

    if (!component) return library.unknown(tag);
    const { areas, causes } = diagnose(library, component, text(args.symptom) ?? '');
    const result: Result = { found: true, tag: component.tag, areas, causes };

    if (typeof args.code === 'string' && args.code.trim() !== '') result.validation = validation(validate(library, args.code, isSyntax(args.syntax) ? args.syntax : undefined));

    return result;
  },
};

function request(args: Record<string, Json>): SnippetRequest {
  const props: Record<string, PropValue> = {};
  const slots: Record<string, string> = {};

  if (typeof args.props === 'object' && args.props !== null && !Array.isArray(args.props)) {
    for (const [name, value] of Object.entries(args.props)) {
      if (isPropValue(value)) props[name] = value;
    }
  }

  if (typeof args.slots === 'object' && args.slots !== null && !Array.isArray(args.slots)) {
    for (const [name, value] of Object.entries(args.slots)) {
      if (typeof value === 'string') slots[name] = value;
    }
  }

  return { props, slots, events: strings(args.events) };
}

const frameworkUnavailable = (library: { index: { frameworks: object } }, framework: string): Result => ({
  ...notAvailable(`${framework} wrappers`, `frameworks.${framework}`),
  configured: ['html', 'js', ...Object.keys(library.index.frameworks)],
});

export const generateSnippet: ToolDefinition = {
  name: 'generate_snippet',
  title: 'Generate a snippet',
  description:
    "Code for one component with the props, slots and event listeners you name, checked against its API: HTML (the default), vanilla JS, or a framework's wrapper where the library configured one. Required props are filled in. Anything that isn't the component's is left out and listed in `problems`.",
  input: {
    properties: {
      tag: TAG,
      framework: { type: 'string', enum: TARGETS, default: 'html' },
      props: { type: 'object', description: 'Prop → value, by JS name or attribute.', additionalProperties: true },
      slots: { type: 'object', description: 'Slot name → its HTML. "default" is the default slot.', additionalProperties: { type: 'string', maxLength: 20_000 } },
      events: { type: 'array', items: { type: 'string' }, description: 'Events to add listeners for.' },
    },
    required: ['tag'],
  },
  output: { tag: { type: 'string' }, framework: { type: 'string' }, language: { type: 'string' }, code: { type: 'string' }, problems: LIST({ type: 'string' }) },
  run(library, args) {
    const tag = text(args.tag) ?? '';
    const component = library.find(tag);

    if (!component) return library.unknown(tag);
    const target = isTarget(args.framework) ? args.framework : 'html';
    const made = snippet(library, component, target, request(args));

    if (!made) {
      const configured = target !== 'html' && target !== 'js' && library.index.frameworks[target] !== undefined;

      return configured ? { found: true, tag: component.tag, framework: target, message: `The ${target} wrappers leave <${component.tag}> out. Use the element itself.` } : frameworkUnavailable(library, target);
    }

    return { found: true, tag: component.tag, framework: target, language: made.language, code: made.code, problems: made.problems };
  },
};

export const getFrameworkUsage: ToolDefinition = {
  name: 'get_framework_usage',
  title: 'Get framework usage',
  description: "How the library is used from React, Vue or Angular: the wrapper package, the import, how props and events are bound, and the value binding (v-model, ngModel) for form controls. With `tag`, for that component, with a snippet.",
  input: { properties: { framework: { type: 'string', enum: FRAMEWORK_NAMES }, tag: TAG }, required: ['framework'] },
  output: {
    framework: { type: 'string' },
    package: { type: 'string' },
    import: { type: 'string' },
    component: { type: 'string', description: "The wrapper's name." },
    binding: { type: 'object', description: 'How props, events and slots are written.' },
    model: { type: 'object', description: 'The two-way value binding, when the component has one.' },
    code: { type: 'string' },
    notWrapped: LIST({ type: 'string' }, 'Tags the wrapper package leaves out.'),
  },
  requires: { capability: 'frameworks', what: 'framework wrappers; it is used as plain custom elements (generate_snippet writes HTML and JS)', option: 'frameworks' },
  run(library, args) {
    if (!isFramework(args.framework)) return { message: `\`framework\` is one of ${FRAMEWORK_NAMES.join(', ')}.` };
    const framework = args.framework;
    const entry = library.index.frameworks[framework];

    if (!entry) return frameworkUnavailable(library, framework);

    const binding: Record<FrameworkName, Result> = {
      react: { props: 'propName={value} (camelCase JS names)', events: 'onEventName={(event) => event.detail}', slots: 'children; a named slot is a child with slot="name"' },
      vue: { props: 'prop-name="text" or :prop-name="value"', events: '@eventName="handler"', slots: 'children; a named slot is a child with slot="name" (not <template #name>)' },
      angular: { props: 'prop-name="text" or [propName]="value"', events: '(eventName)="handler($event)"', slots: 'children; a named slot is a child with slot="name"', standalone: 'Add the wrapper class to the component\'s `imports`.' },
    };

    const result: Result = { framework, package: entry.package, binding: binding[framework], notWrapped: entry.exclude ?? [] };
    const tag = text(args.tag);

    if (!tag) {
      const models = (framework === 'vue' ? entry.models : framework === 'angular' ? entry.valueAccessors : undefined) ?? [];

      result.import = `import { ${library.wrapperName(library.index.components[0]?.tag ?? 'my-component')} } from '${entry.package}';`;

      if (models.length > 0) result.model = { [framework === 'vue' ? 'v-model' : 'ngModel / formControlName']: models.map((model) => ({ elements: model.elements, prop: model.targetAttr, event: model.event })) };

      return result;
    }

    const component = library.find(tag);

    if (!component) return library.unknown(tag);
    result.found = true;
    result.tag = component.tag;

    if (entry.exclude?.includes(component.tag)) return { ...result, message: `The ${framework} wrappers leave <${component.tag}> out. Use the element itself.` };
    const model = valueBinding(library, component.tag, framework);

    result.component = library.wrapperName(component.tag);
    result.import = `import { ${result.component} } from '${entry.package}';`;

    if (model) result.model = { syntax: framework === 'vue' ? 'v-model' : '[(ngModel)] or formControlName', prop: model.targetAttr, event: model.event };
    result.code = snippet(library, component, framework, { events: model ? [] : component.events.slice(0, 1).map((event) => event.name) })?.code;

    return result;
  },
};

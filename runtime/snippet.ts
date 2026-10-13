import type { ComponentEntry, FrameworkName, PropEntry, ValueBinding } from '../src/types.ts';
import { closest, isBooleanProp, type Library } from './library.ts';
import { findProp } from './validate.ts';

// Code for one component in HTML, vanilla JS, or a configured framework's wrapper.

export type Target = 'html' | 'js' | FrameworkName;

export const TARGETS: readonly Target[] = ['html', 'js', 'react', 'vue', 'angular'];

export type PropValue = string | number | boolean | null | PropValue[] | { [key: string]: PropValue };

export interface SnippetRequest {
  props?: Record<string, PropValue>;
  /** Slot name → its HTML. `''` or `default` is the default slot. */
  slots?: Record<string, string>;
  events?: string[];
}

export interface Snippet {
  language: string;
  code: string;
  /** Names that aren't the component's, or values its props don't take. */
  problems: string[];
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const literal = (value: PropValue) => JSON.stringify(value);

/** A JSON value inside a single-quoted attribute (`:items='[…]'`): an apostrophe in it would end the attribute. Templates decode the entities. */
const boundLiteral = (value: PropValue) => literal(value).replace(/&/g, '&amp;').replace(/'/g, '&#39;');

/** A JSON value inside an HTML `<script>`: `</script>` in a string would end the element. */
const scriptLiteral = (value: PropValue) => literal(value).replace(/</g, '\\u003c');

const handlerName = (event: string) => `on${event[0].toUpperCase()}${event.slice(1)}`;

const indent = (text: string, by = '  ') =>
  text
    .split('\n')
    .map((line) => (line ? by + line : line))
    .join('\n');

interface Resolved {
  set: { prop: PropEntry; value: PropValue }[];
  slots: { name: string; html: string }[];
  events: string[];
  problems: string[];
}

/** A value to show for a required prop nobody gave. */
function placeholder(prop: PropEntry): PropValue {
  if (prop.values?.length) return prop.values[0];

  if (isBooleanProp(prop)) return true;

  return /\bnumber\b/.test(prop.type) ? 0 : '…';
}

function resolve(component: ComponentEntry, request: SnippetRequest): Resolved {
  const problems: string[] = [];
  const set: Resolved['set'] = [];

  for (const [name, value] of Object.entries(request.props ?? {})) {
    const prop = findProp(component, name);

    if (!prop) {
      const nearest = closest(name, component.props.map((candidate) => [candidate.name, candidate.name]), 1)[0];

      problems.push(`<${component.tag}> has no prop \`${name}\`${nearest ? ` (did you mean \`${nearest}\`?)` : ''}: left out.`);
      continue;
    }

    if (prop.values && typeof value === 'string' && !prop.values.includes(value)) problems.push(`\`${prop.name}\` doesn't take "${value}" (it takes ${prop.values.map((allowed) => `"${allowed}"`).join(', ')}).`);

    if (prop.deprecation) problems.push(`\`${prop.name}\` is deprecated.${prop.deprecation.replacement ? ` Use \`${prop.deprecation.replacement.name}\`.` : ''}`);
    set.push({ prop, value });
  }

  for (const prop of component.props) {
    if (prop.required && !set.some((entry) => entry.prop === prop)) set.push({ prop, value: placeholder(prop) });
  }

  const slots = Object.entries(request.slots ?? {}).flatMap(([given, html]) => {
    const name = given === 'default' ? '' : given;

    if (component.slots.length > 0 && !component.slots.some((slot) => slot.name === name)) {
      problems.push(`<${component.tag}> has no slot "${given}" (its slots: ${component.slots.map((slot) => slot.name || 'default').join(', ')}): left out.`);

      return [];
    }

    return [{ name, html }];
  });

  const events = (request.events ?? []).flatMap((given) => {
    const event = component.events.find((candidate) => candidate.name.toLowerCase() === given.toLowerCase());

    if (!event) problems.push(`<${component.tag}> has no event \`${given}\`${component.events.length ? ` (its events: ${component.events.map((candidate) => candidate.name).join(', ')})` : ''}: left out.`);

    return event ? [event.name] : [];
  });

  if (component.deprecation) problems.unshift(`<${component.tag}> is deprecated.${component.deprecation.replacement ? ` Use <${component.deprecation.replacement.name}>.` : ''}`);

  return { set, slots, events, problems };
}

/** A slot's HTML as a child: the default slot as is; a named slot with `slot="name"` on its element, or wrapped in a span. */
function slotted(name: string, html: string): string {
  if (name === '') return html;

  return /^\s*<[a-zA-Z][^>]*>/.test(html) ? html.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1 slot="${name}"`) : `<span slot="${name}">${html}</span>`;
}

function children(slots: Resolved['slots']): string {
  if (slots.length === 0) return '';
  const parts = slots.map((slot) => slotted(slot.name, slot.html));

  return parts.length === 1 && !parts[0].includes('\n') && parts[0].length < 60 ? parts[0] : `\n${indent(parts.join('\n'))}\n`;
}

const isScalar = (value: PropValue): value is string | number | boolean => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

function htmlAttributes(set: Resolved['set']): { attributes: string[]; properties: Resolved['set'] } {
  const attributes: string[] = [];
  const properties: Resolved['set'] = [];

  for (const entry of set) {
    const { prop, value } = entry;

    if (!prop.attribute || !isScalar(value)) properties.push(entry);
    else if (value === true) attributes.push(prop.attribute);
    else if (value !== false) attributes.push(`${prop.attribute}="${escapeAttr(String(value))}"`);
  }

  return { attributes, properties };
}

const open = (tag: string, attributes: string[]) => (attributes.join(' ').length > 80 ? `<${tag}\n${indent(attributes.join('\n'))}\n>` : `<${[tag, ...attributes].join(' ')}>`);

/** `<Name a="b" />`, or the wrapped form with `/>` on its own line. */
const selfClosing = (tag: string, attributes: string[]) => {
  const opening = open(tag, attributes).slice(0, -1);

  return opening.endsWith('\n') ? `${opening}/>` : `${opening} />`;
};

function html(component: ComponentEntry, resolved: Resolved): string {
  const { attributes, properties } = htmlAttributes(resolved.set);
  const needsScript = properties.length > 0 || resolved.events.length > 0;
  const markup = `${open(component.tag, needsScript ? ['id="example"', ...attributes] : attributes)}${children(resolved.slots)}</${component.tag}>`;

  if (!needsScript) return markup;

  const lines = [
    "const element = document.getElementById('example');",
    ...properties.map(({ prop, value }) => `element.${prop.name} = ${scriptLiteral(value)};`),
    ...resolved.events.map((event) => `element.addEventListener('${event}', (event) => {\n  console.log(event.detail);\n});`),
  ];

  return `${markup}\n\n<script type="module">\n${indent(lines.join('\n'))}\n</script>`;
}

function js(component: ComponentEntry, resolved: Resolved): string {
  const lines = [
    `const element = document.createElement('${component.tag}');`,
    ...resolved.set.map(({ prop, value }) => `element.${prop.name} = ${literal(value)};`),
    ...resolved.slots.map((slot) => (slot.name === '' ? `element.innerHTML = ${literal(slot.html)};` : `element.insertAdjacentHTML('beforeend', ${literal(slotted(slot.name, slot.html))});`)),
    ...resolved.events.map((event) => `element.addEventListener('${event}', (event) => {\n  console.log(event.detail);\n});`),
    'document.body.append(element);',
  ];

  return lines.join('\n');
}

function react(library: Library, component: ComponentEntry, resolved: Resolved, pkg: string): string {
  const name = library.wrapperName(component.tag);

  const attributes = [
    ...resolved.set.map(({ prop, value }) => (value === true ? prop.name : typeof value === 'string' ? `${prop.name}="${escapeAttr(value)}"` : `${prop.name}={${literal(value)}}`)),
    ...resolved.events.map((event) => `${handlerName(event)}={(event) => console.log(event.detail)}`),
  ];

  const body = children(resolved.slots);
  const element = body ? `${open(name, attributes)}${body}</${name}>` : selfClosing(name, attributes);

  return `import { ${name} } from '${pkg}';\n\nexport function Example() {\n  return (\n${indent(element, '    ')}\n  );\n}`;
}

function vue(library: Library, component: ComponentEntry, resolved: Resolved, pkg: string, model: ValueBinding | undefined): string {
  const name = library.wrapperName(component.tag);
  const modelled = model && !resolved.set.some(({ prop }) => prop.name === model.targetAttr || prop.attribute === model.targetAttr);

  const attributes = [
    ...(modelled ? ['v-model="value"'] : []),
    ...resolved.set.map(({ prop, value }) => (value === true ? prop.attribute ?? prop.name : typeof value === 'string' ? `${prop.attribute ?? prop.name}="${escapeAttr(value)}"` : `:${prop.attribute ?? prop.name}='${boundLiteral(value)}'`)),
    ...resolved.events.map((event) => `@${event}="${handlerName(event)}"`),
  ];

  const script = [
    ...(modelled ? ["import { ref } from 'vue';"] : []),
    `import { ${name} } from '${pkg}';`,
    ...(modelled ? ['', 'const value = ref();'] : []),
    ...resolved.events.map((event) => `\nfunction ${handlerName(event)}(event) {\n  console.log(event.detail);\n}`),
  ];

  const body = children(resolved.slots);
  const element = body ? `${open(name, attributes)}${body}</${name}>` : selfClosing(name, attributes);

  return `<script setup>\n${script.join('\n')}\n</script>\n\n<template>\n${indent(element)}\n</template>`;
}

function angular(library: Library, component: ComponentEntry, resolved: Resolved, pkg: string, accessor: ValueBinding | undefined): string {
  const name = library.wrapperName(component.tag);
  const modelled = accessor && !resolved.set.some(({ prop }) => prop.name === accessor.targetAttr || prop.attribute === accessor.targetAttr);

  const attributes = [
    ...(modelled ? ['[(ngModel)]="value"'] : []),
    ...resolved.set.map(({ prop, value }) => (value === true && prop.attribute ? prop.attribute : typeof value === 'string' && prop.attribute ? `${prop.attribute}="${escapeAttr(value)}"` : `[${prop.name}]='${boundLiteral(value)}'`)),
    ...resolved.events.map((event) => `(${event})="${handlerName(event)}($event)"`),
  ];

  const element = `${open(component.tag, attributes)}${children(resolved.slots)}</${component.tag}>`;

  const members = [...(modelled ? ['value: unknown;'] : []), ...resolved.events.map((event) => `${handlerName(event)}(event: CustomEvent) {\n  console.log(event.detail);\n}`)];

  return [
    "import { Component } from '@angular/core';",
    ...(modelled ? ["import { FormsModule } from '@angular/forms';"] : []),
    `import { ${name} } from '${pkg}';`,
    '',
    '@Component({',
    "  selector: 'app-example',",
    `  imports: [${[name, ...(modelled ? ['FormsModule'] : [])].join(', ')}],`,
    `  template: \`\n${indent(element, '    ')}\n  \`,`,
    '})',
    `export class ExampleComponent {${members.length ? `\n${indent(members.join('\n\n'))}\n` : ''}}`,
  ].join('\n');
}

/** The value binding (`v-model`, `ngModel`) a framework declares for a tag. */
export function valueBinding(library: Library, tag: string, framework: FrameworkName): ValueBinding | undefined {
  const entry = library.index.frameworks[framework];
  const list = framework === 'vue' ? entry?.models : framework === 'angular' ? entry?.valueAccessors : undefined;

  return list?.find((binding) => binding.elements.includes(tag));
}

/** Undefined when the target is a framework this library didn't configure, or one whose wrappers leave the tag out. */
export function snippet(library: Library, component: ComponentEntry, target: Target, request: SnippetRequest = {}): Snippet | undefined {
  const resolved = resolve(component, request);

  if (target === 'html') return { language: 'html', code: html(component, resolved), problems: resolved.problems };

  if (target === 'js') return { language: 'js', code: js(component, resolved), problems: resolved.problems };
  const framework = library.index.frameworks[target];

  if (!framework || framework.exclude?.includes(component.tag)) return undefined;

  if (target === 'react') return { language: 'tsx', code: react(library, component, resolved, framework.package), problems: resolved.problems };

  if (target === 'vue') return { language: 'vue', code: vue(library, component, resolved, framework.package, valueBinding(library, component.tag, 'vue')), problems: resolved.problems };

  return { language: 'ts', code: angular(library, component, resolved, framework.package, valueBinding(library, component.tag, 'angular')), problems: resolved.problems };
}

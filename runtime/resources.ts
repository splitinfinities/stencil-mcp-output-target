import type { ComponentEntry } from '../src/types.ts';
import { deprecationNote, type Library } from './library.ts';
import { guideMarkdown } from './migration.ts';
import { api } from './tools/lookup.ts';

// component://{tag}            a component's page, as Markdown
// component://{tag}/api.json   its API, as JSON
// tokens://all                 the design tokens, as JSON
// guide://migration            deprecations and their replacements, as Markdown

const cell = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|');

const code = (text: string | undefined) => (text ? `\`${cell(text)}\`` : '');

function table(headings: string[], rows: string[][]): string[] {
  return [`| ${headings.join(' | ')} |`, `| ${headings.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`), ''];
}

export function componentMarkdown(library: Library, component: ComponentEntry): string {
  const lines = [`# <${component.tag}>`, ''];
  const deprecated = deprecationNote(component.deprecation);

  if (deprecated) lines.push(`> ${deprecated}`, '');

  if (component.description) lines.push(component.description, '');

  const facts = [component.category && `Category: ${component.category}`, `Encapsulation: ${component.encapsulation}`, component.formAssociated && 'Form-associated'].filter((fact) => fact);

  lines.push(facts.join(' · '), '');

  if (component.props.length > 0) {
    lines.push('## Props', '');
    lines.push(
      ...table(
        ['Property', 'Attribute', 'Type', 'Default', 'Description'],
        component.props.map((prop) => [code(prop.name), code(prop.attribute), code(prop.values ? prop.values.map((value) => `"${value}"`).join(' | ') : prop.type), code(prop.default), cell([prop.required ? 'Required.' : '', deprecationNote(prop.deprecation) ?? '', prop.description].filter((part) => part).join(' '))]),
      ),
    );
  }

  if (component.events.length > 0) {
    lines.push('## Events', '');
    lines.push(...table(['Event', 'Detail', 'Description'], component.events.map((event) => [code(event.name), code(event.detail), cell(event.description)])));
  }

  if (component.methods.length > 0) {
    lines.push('## Methods', '');
    lines.push(...table(['Method', 'Description'], component.methods.map((method) => [code(method.signature), cell(method.description)])));
  }

  for (const [title, items, name] of [
    ['Slots', component.slots, (item: string) => (item ? `"${item}"` : '(default)')],
    ['Parts', component.parts, (item: string) => item],
    ['CSS custom properties', component.cssProperties, (item: string) => item],
  ] as const) {
    if (items.length === 0) continue;
    lines.push(`## ${title}`, '');
    lines.push(...table(['Name', 'Description'], items.map((item) => [code(name(item.name)), cell(item.description)])));
  }

  if (component.dependencies.length > 0) lines.push('## Renders', '', component.dependencies.map((tag) => `\`<${tag}>\``).join(', '), '');

  const guidance = library.index.guidance[component.tag];

  if (guidance?.bestPractices?.length) {
    lines.push('## Do', '');

    for (const entry of guidance.bestPractices) lines.push(`- **${entry.title}.** ${entry.description}`, ...(entry.example ? ['', '  ```html', ...entry.example.split('\n').map((line) => `  ${line}`), '  ```', ''] : []));
    lines.push('');
  }

  if (guidance?.antiPatterns?.length) {
    lines.push("## Don't", '');

    for (const entry of guidance.antiPatterns) {
      lines.push(`- **${entry.title}.** ${entry.description}`);

      if (entry.bad) lines.push('', '  Instead of:', '', '  ```html', ...entry.bad.split('\n').map((line) => `  ${line}`), '  ```');

      if (entry.good) lines.push('', '  Write:', '', '  ```html', ...entry.good.split('\n').map((line) => `  ${line}`), '  ```', '');
    }

    lines.push('');
  }

  const a11y = library.index.accessibility[component.tag];

  if (a11y) {
    lines.push('## Accessibility', '');

    if (a11y.role) lines.push(`Role: \`${a11y.role}\`.`, '');

    for (const entry of a11y.keyboard ?? []) lines.push(`- \`${entry.keys}\`: ${entry.does}`);

    for (const entry of [...(a11y.aria ?? []), ...(a11y.notes ?? [])]) lines.push(`- ${entry}`);
    lines.push('');
  }

  for (const example of component.examples) lines.push(`## Example: ${example.title}`, '', example.markdown, '');

  return `${lines.join('\n').trimEnd()}\n`;
}

export const componentJson = (library: Library, component: ComponentEntry) => JSON.stringify(api(library, component, [], true), null, 2);

export const tokensJson = (library: Library) => JSON.stringify({ tokens: library.index.tokens }, null, 2);

export { guideMarkdown };

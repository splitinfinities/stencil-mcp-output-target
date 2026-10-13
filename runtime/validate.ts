import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import type { ComponentEntry, FrameworkName, PropEntry, Rule, RuleCondition, RuleTest } from '../src/types.ts';
import { camelCase, closest, isBooleanProp, kebabCase, type Library } from './library.ts';

// One HTML parser (parse5) for every syntax. JSX, Vue and Angular markup is first cleaned into
// HTML parse5 can read (expression values become a placeholder, `<x />` becomes `<x></x>`, a
// wrapper name becomes its tag); `syntax` then only decides how an attribute's name is read.
// Anything the cleaning couldn't read is listed in `notChecked`, so a pass never hides a skipped
// region, and a bound value is "dynamic": never an error.

export type Syntax = 'html' | 'jsx' | 'vue' | 'angular';

export const SYNTAXES: readonly Syntax[] = ['html', 'jsx', 'vue', 'angular'];

export interface Issue {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  tag?: string;
  attribute?: string;
  /** 1-based, in the code as given. */
  line?: number;
  suggestion?: string;
}

export interface Validation {
  /** No errors. Warnings and notes don't fail it. */
  valid: boolean;
  syntax: Syntax;
  /** True when `syntax` was guessed from the code. */
  syntaxGuessed: boolean;
  /** The library's tags found in the code. */
  components: string[];
  issues: Issue[];
  /** What couldn't be read or was bound at runtime. */
  notChecked: string[];
}

type Element = DefaultTreeAdapterMap['element'];

type ChildNode = DefaultTreeAdapterMap['childNode'];

const DYNAMIC = '__dynamic__';

const SPREAD = 'data-mcp-spread';

/**
 * How deep elements may nest before the rest of the code is left unread. Real markup is nowhere
 * near it, and the HTML parser's work on each new block element grows with the depth it is at, so
 * 40,000 unclosed `<div>`s took seconds.
 */
export const MAX_DEPTH = 1_000;

/** The most issues one validation lists. A result is capped anyway; this keeps a hostile input from building a huge one first. */
export const MAX_ISSUES = 100;

/** How many attributes one tag may carry before the rest of the code is left unread: the parser checks each new one against all those before it. */
export const MAX_ATTRIBUTES = 500;

/** Elements whose end tag may be left out: a run of unclosed `<li>`s is a flat list, not a deep one. */
const OPTIONAL_END = new Set('caption colgroup dd dt li optgroup option p rp rt tbody td tfoot th thead tr'.split(' '));

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Attributes every element takes. */
const GLOBAL = new Set(
  'accesskey autocapitalize autofocus class contenteditable dir draggable enterkeyhint exportparts hidden id inert inputmode is itemid itemprop itemref itemscope itemtype lang nonce part popover role slot spellcheck style tabindex title translate'.split(
    ' ',
  ),
);

/** JS-side names frameworks take on any element. */
const FRAMEWORK_PROPS = new Set(['key', 'ref', 'children', 'className', 'htmlFor', 'dangerouslySetInnerHTML', 'suppressHydrationWarning', 'tabIndex', 'is']);

const NATIVE_EVENT =
  /^(click|dblclick|auxclick|input|beforeinput|change|focus|blur|focusin|focusout|submit|reset|invalid|select|key(down|up|press)|mouse\w+|pointer\w+|touch\w+|drag\w*|drop|scroll\w*|wheel|load|error|toggle|beforetoggle|close|cancel|contextmenu|copy|cut|paste|animation\w+|transition\w+|composition\w+)$/;

const FRAMEWORK_OF: Partial<Record<Syntax, FrameworkName>> = { jsx: 'react', vue: 'vue', angular: 'angular' };

export function guessSyntax(code: string): Syntax {
  if (/\bclassName=|=\{|\{\.\.\.|<>|\bon[A-Z]\w*=\{/.test(code)) return 'jsx';

  if (/\s(v-[a-z]+|:[\w-]+|@[\w.-]+|#[\w-]+)(=|\s|>)|<template[\s>]/.test(code) && !/\s\[[\w.]+\]=|\s\([\w.]+\)=/.test(code)) return 'vue';

  if (/\s(\[\(?[\w.-]+\)?\]|\([\w.-]+\))=|\s\*ng[A-Z]\w*=|@(if|for|switch)\s*\(/.test(code)) return 'angular';

  return 'html';
}

/** The index of the brace closing the one at `start`, skipping strings, template literals and comments. -1 when it never closes. */
function matchBrace(code: string, start: number): number {
  let depth = 0;

  for (let i = start; i < code.length; i++) {
    const c = code[i];

    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++;
    } else if (c === '/' && code[i + 1] === '*') {
      i = code.indexOf('*/', i + 2);

      if (i === -1) return -1;
      i++;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;

      if (depth === 0) return i;
    }
  }

  return -1;
}

interface Cleaned {
  html: string;
  /** In the order they were found, once each. */
  notChecked: Set<string>;
  /** Custom elements written `<x />`, with their line. */
  selfClosed: { tag: string; line: number }[];
}

/** Rewrites framework markup as HTML with the same line numbers. */
function clean(library: Library, code: string, syntax: Syntax): Cleaned {
  const notChecked = new Set<string>();
  const selfClosed: Cleaned['selfClosed'] = [];
  const framework = FRAMEWORK_OF[syntax];
  let html = '';
  let line = 1;
  let depth = 0;

  const note = (message: string) => {
    notChecked.add(message);
  };

  const resolve = (name: string) => {
    if (!/^[A-Z]/.test(name)) return name;
    const component = library.find(name);

    if (!component) return name;

    if (framework && framework !== 'angular' && library.index.frameworks[framework] && !library.index.frameworks[framework]?.exclude?.includes(component.tag)) return component.tag;
    note(`<${name}> looks like a wrapper for <${component.tag}>, but ${framework ? `\`frameworks.${framework}\` isn't configured for this library` : 'wrapper names are only read in JSX and Vue'}: not checked.`);

    return name;
  };

  // Sticky, so each tag is matched where it stands instead of on a copy of the rest of the code.
  const OPENING = /<(\/?)([A-Za-z][\w.:-]*)/y;

  scan: for (let i = 0; i < code.length; ) {
    OPENING.lastIndex = i;
    const opening = code[i] === '<' ? OPENING.exec(code) : null;

    if (!opening) {
      // Text, up to the next `<`.
      const next = code.indexOf('<', i + 1);
      const text = code.slice(i, next === -1 ? code.length : next);

      line += text.split('\n').length - 1;
      html += text;
      i += text.length;
      continue;
    }

    const name = resolve(opening[2]);

    const nests = !VOID.has(name.toLowerCase()) && !OPTIONAL_END.has(name.toLowerCase());

    if (nests) depth = opening[1] ? Math.max(0, depth - 1) : depth + 1;

    if (depth > MAX_DEPTH) {
      note(`Elements nested more than ${MAX_DEPTH.toLocaleString('en-US')} deep at line ${line}: the rest of the code was not checked.`);
      break;
    }

    html += `<${opening[1]}${name}`;
    i += opening[0].length;

    // The last character written inside this tag that isn't whitespace: `=` means a value comes next.
    let last = '';
    let attributes = 0;
    let spaced = false;

    // Attributes, up to the tag's end.
    while (i < code.length) {
      const c = code[i];

      if (c === '\n') line++;

      // An attribute starts at the first character after whitespace.
      if (c.trim() === '') {
        spaced = true;
      } else if (spaced) {
        spaced = false;

        if (c !== '/' && c !== '>' && ++attributes > MAX_ATTRIBUTES) {
          note(`More than ${MAX_ATTRIBUTES} attributes on <${name}> at line ${line}: the rest of the code was not checked.`);
          html += '>';
          break scan;
        }
      }

      if (c === '"' || c === "'") {
        const end = code.indexOf(c, i + 1);
        const stop = end === -1 ? code.length : end + 1;

        line += code.slice(i + 1, stop).split('\n').length - 1;
        html += code.slice(i, stop);
        last = c;
        i = stop;
      } else if (c === '{' && syntax === 'jsx') {
        const end = matchBrace(code, i);

        if (end === -1) {
          note(`An unclosed { on line ${line}: the rest of the code was not checked.`);
          i = code.length;
          break;
        }

        const expression = code.slice(i, end + 1);

        if (last === '=') {
          html += `"${DYNAMIC}"`;
        } else {
          html += ` ${SPREAD} `;
          note(`Spread attributes (${expression.replace(/\s+/g, ' ').slice(0, 40)}) on <${name}>, line ${line}: required props and unknown names were not checked there.`);
        }

        // Keep the line count.
        const newlines = expression.split('\n').length - 1;

        html += '\n'.repeat(newlines);
        line += newlines;
        last = '"';
        i = end + 1;
      } else if (c === '/' && code[i + 1] === '>') {
        if (VOID.has(name.toLowerCase())) {
          html += '/>';
        } else {
          html += `></${name}>`;

          if (nests) depth--;

          if (name.includes('-')) selfClosed.push({ tag: name, line });
        }

        i += 2;
        break;
      } else {
        html += c;
        i++;

        if (c.trim() !== '') last = c;

        if (c === '>') break;
      }
    }
  }

  return { html, notChecked, selfClosed };
}

type Binding =
  | { kind: 'attr'; name: string; raw: string; value: string; dynamic: boolean }
  | { kind: 'prop'; name: string; raw: string; value: string; dynamic: boolean }
  | { kind: 'event'; name: string; raw: string }
  | { kind: 'slot'; name: string }
  | { kind: 'model'; raw: string }
  | { kind: 'spread' }
  | { kind: 'skip' };

/** How an attribute's name is read in each syntax. */
function classify(syntax: Syntax, raw: string, value: string): Binding {
  if (raw.toLowerCase() === SPREAD) return { kind: 'spread' };
  const attr = (): Binding => ({ kind: 'attr', name: raw.toLowerCase(), raw, value, dynamic: false });

  if (syntax === 'html') return attr();

  if (syntax === 'jsx') {
    const dynamic = value === DYNAMIC;

    if (/^on[A-Z]/.test(raw)) return { kind: 'event', name: raw[2].toLowerCase() + raw.slice(3), raw };

    if (FRAMEWORK_PROPS.has(raw)) return raw === 'className' || raw === 'key' || raw === 'ref' || raw === 'children' || raw === 'dangerouslySetInnerHTML' || raw === 'suppressHydrationWarning' ? { kind: 'skip' } : attr();

    if (raw.includes('-')) return { kind: 'attr', name: raw.toLowerCase(), raw, value, dynamic };

    return { kind: 'prop', name: raw, raw, value, dynamic };
  }

  if (syntax === 'vue') {
    const slot = raw.match(/^(?:v-slot:|#)([\w-]+)/);

    if (slot) return { kind: 'slot', name: slot[1] === 'default' ? '' : slot[1] };

    if (/^v-model/.test(raw)) return { kind: 'model', raw };
    const bound = raw.match(/^(?:v-bind)?:([\w-]+)/);

    if (bound) return bound[1] === 'key' || bound[1] === 'ref' || bound[1] === 'class' || bound[1] === 'style' || bound[1] === 'is' ? { kind: 'skip' } : { kind: 'prop', name: bound[1], raw, value, dynamic: true };
    const listened = raw.match(/^(?:v-on:|@)([\w:-]+)/);

    if (listened) return { kind: 'event', name: listened[1], raw };

    if (/^v-|^(key|ref|is)$/.test(raw)) return { kind: 'skip' };

    return attr();
  }

  // Angular.
  const twoWay = raw.match(/^\[\(([\w.-]+)\)\]$/);

  if (twoWay) return twoWay[1] === 'ngModel' ? { kind: 'model', raw } : { kind: 'prop', name: twoWay[1], raw, value, dynamic: true };
  const bound = raw.match(/^\[([\w.-]+)\]$/);

  if (bound) {
    if (/^(class|style)(\.|$)|^ng[A-Z]/.test(bound[1])) return { kind: 'skip' };

    if (bound[1].startsWith('attr.')) return { kind: 'attr', name: bound[1].slice('attr.'.length).toLowerCase(), raw, value, dynamic: true };

    return bound[1] === 'formControl' || bound[1] === 'formGroup' ? { kind: 'model', raw } : { kind: 'prop', name: bound[1], raw, value, dynamic: true };
  }

  const listened = raw.match(/^\(([\w.:-]+)\)$/);

  if (listened) return { kind: 'event', name: listened[1], raw };

  if (/^(formControlName|ngModel)$/.test(raw)) return { kind: 'model', raw };

  if (/^[*#@]|^ng[A-Z]/.test(raw)) return { kind: 'skip' };

  return attr();
}

const isElement = (node: ChildNode): node is Element => 'tagName' in node;

const isTemplate = (node: Element): node is DefaultTreeAdapterMap['template'] => node.tagName === 'template' && 'content' in node;

const childrenOf = (node: Element): ChildNode[] => (isTemplate(node) ? node.content.childNodes : node.childNodes);

/** Compares event names loosely: `my-change`, `myChange` and `mychange` are one name. */
const eventKey = (name: string) => name.replace(/[-_.:]/g, '').toLowerCase();

/** What one element carries, in terms rules and the built-in checks share. */
interface Seen {
  /** Attribute name → its value. A prop bound by JS name is filed under its attribute. */
  present: Map<string, { value: string; dynamic: boolean }>;
  spread: boolean;
  model: boolean;
  /** The slot this element asks for, when it names one statically. */
  slot?: string;
}

export function validate(library: Library, code: string, requested?: Syntax): Validation {
  const syntax = requested ?? guessSyntax(code);
  const { html, notChecked, selfClosed } = clean(library, code, syntax);
  const issues: Issue[] = [];
  const components = new Set<string>();
  const seenOf = new Map<Element, Seen>();
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const framework = FRAMEWORK_OF[syntax];

  const note = (message: string) => {
    notChecked.add(message);
  };

  if (syntax === 'html') {
    for (const { tag, line } of selfClosed) {
      issues.push({ rule: 'self-closing-custom-element', severity: 'error', tag, line, message: `<${tag} /> doesn't close in HTML: the elements after it become its children.`, suggestion: `<${tag}></${tag}>` });
    }
  }

  /** The attribute's name as written (parse5 lowercases it). */
  const rawName = (element: Element, lower: string) => {
    const location = element.sourceCodeLocation?.attrs?.[lower];

    return location ? (html.slice(location.startOffset, location.endOffset).match(/^[^\s=]+/)?.[0] ?? lower) : lower;
  };

  const read = (element: Element): Seen => {
    const cached = seenOf.get(element);

    if (cached) return cached;
    const seen: Seen = { present: new Map(), spread: false, model: false };
    const component = library.byTag.get(element.tagName);

    for (const { name, value } of element.attrs) {
      const binding = classify(syntax, rawName(element, name), value);

      if (binding.kind === 'spread') seen.spread = true;
      else if (binding.kind === 'model') seen.model = true;
      else if (binding.kind === 'slot') seen.slot = binding.name;
      else if (binding.kind === 'attr') {
        seen.present.set(binding.name, { value: binding.value, dynamic: binding.dynamic });

        if (binding.name === 'slot' && !binding.dynamic) seen.slot = binding.value;
      } else if (binding.kind === 'prop') {
        const prop = component && findProp(component, binding.name);

        seen.present.set(prop?.attribute ?? kebabCase(binding.name), { value: binding.value, dynamic: binding.dynamic });
      }
    }

    seenOf.set(element, seen);

    return seen;
  };

  const check = (element: Element, parent: Element | undefined) => {
    const tag = element.tagName;
    const component = library.byTag.get(tag);
    const line = element.sourceCodeLocation?.startLine;
    const issue = (entry: Omit<Issue, 'tag' | 'line'>) => issues.push({ ...entry, tag, line });

    if (!component) {
      const moved = library.index.migrations.tags.find((migration) => migration.from === tag);

      if (moved) {
        issue({ rule: 'removed-tag', severity: 'error', message: `<${tag}> was replaced by <${moved.to}>.${moved.note ? ` ${moved.note}` : ''}`, suggestion: `<${moved.to}>` });
      } else if (library.prefix && tag.startsWith(library.prefix)) {
        const nearest = library.nearest(tag);

        issue({ rule: 'unknown-tag', severity: 'error', message: `<${tag}> is not a component of ${library.label}.${nearest.length ? ` Did you mean <${nearest[0]}>?` : ''}`, suggestion: nearest[0] && `<${nearest[0]}>` });
      }

      return;
    }

    components.add(tag);
    const seen = read(element);

    if (component.deprecation) {
      const to = component.deprecation.replacement?.name;

      issue({ rule: 'deprecated-tag', severity: 'warning', message: `<${tag}> is deprecated.${to ? ` Use <${to}>.` : ` ${component.deprecation.text}`}`, suggestion: to && `<${to}>` });
    }

    for (const { name, value } of element.attrs) {
      const raw = rawName(element, name);
      const binding = classify(syntax, raw, value);

      if (binding.kind === 'attr') checkAttribute(component, binding, issue);
      else if (binding.kind === 'prop') checkProp(component, binding, issue);
      else if (binding.kind === 'event') checkEvent(component, binding, issue);

      if ((binding.kind === 'attr' || binding.kind === 'prop') && binding.dynamic) note(`<${tag} ${raw}> is bound at runtime (dynamic, not checked).`);
    }

    // Required props.
    for (const prop of component.props) {
      if (!prop.required || seen.present.has(prop.attribute ?? kebabCase(prop.name))) continue;

      if (seen.spread) note(`<${tag}>: the required prop \`${prop.name}\` may come from the spread attributes.`);
      else issue({ rule: 'missing-required-prop', severity: 'error', attribute: prop.attribute ?? prop.name, message: `<${tag}> needs \`${prop.attribute ?? prop.name}\`.` });
    }

    // A form control posts under its name.
    if (component.formAssociated && component.props.some((prop) => prop.name === 'name') && !seen.present.has('name') && !seen.spread && !seen.model) {
      const inForm = ancestors(element).some((ancestor) => ancestor.tagName === 'form');

      issue({
        rule: 'form-control-without-name',
        severity: inForm ? 'warning' : 'info',
        attribute: 'name',
        message: `<${tag}> is a form control without \`name\`: its value won't be in the form's data.`,
      });
    }

    // Children ask for slots this component has.
    if (component.slots.length > 0) {
      for (const child of childrenOf(element).filter(isElement)) {
        const wanted = read(child).slot;

        if (wanted === undefined || wanted === '' || component.slots.some((slot) => slot.name === wanted)) continue;
        const names = component.slots.flatMap((slot) => (slot.name ? [slot.name] : []));

        issues.push({
          rule: 'unknown-slot',
          severity: 'error',
          tag: child.tagName,
          attribute: 'slot',
          line: child.sourceCodeLocation?.startLine,
          message: `<${tag}> has no slot "${wanted}".${names.length ? ` Its slots: ${names.join(', ')}${component.slots.some((slot) => slot.name === '') ? ', and the default slot' : ''}.` : ' It has only the default slot.'}`,
          suggestion: closest(wanted, names.map((slot) => [slot, slot]), 1)[0],
        });
      }
    }

    // Wrapping a component in one it already renders.
    if (parent && component.dependencies.includes(parent.tagName)) {
      issue({ rule: 'redundant-nesting', severity: 'warning', message: `<${tag}> already renders <${parent.tagName}> itself: the <${parent.tagName}> around it is redundant.` });
    }

    for (const rule of library.index.rules) {
      if (rule.tag === tag) applyRule(rule, element, parent, issue);
    }
  };

  const parents = new Map<Element, Element | undefined>();

  const ancestors = (element: Element): Element[] => {
    const up: Element[] = [];

    for (let current = parents.get(element); current; current = parents.get(current)) up.push(current);

    return up;
  };

  /** true, false, or undefined when the code doesn't say (a bound value, a spread). */
  const holds = (test: RuleTest, element: Element, parent: Element | undefined): boolean | undefined => {
    if ('attr' in test) {
      const seen = read(element);
      const entry = seen.present.get(test.attr);

      if (!entry) return seen.spread ? undefined : false;

      if (test.equals === undefined) return true;

      return entry.dynamic ? undefined : entry.value === test.equals;
    }

    if ('slot' in test) {
      return childrenOf(element).some((child) => (isElement(child) ? (read(child).slot ?? '') === test.slot : test.slot === '' && 'value' in child && child.nodeName === '#text' && child.value.trim() !== ''));
    }

    if ('parent' in test) return parent?.tagName === test.parent;

    return childrenOf(element).some((child) => isElement(child) && child.tagName === test.child);
  };

  /** Every test holds (true), one doesn't (false), or the code doesn't say (undefined). */
  const all = (condition: RuleCondition | undefined, element: Element, parent: Element | undefined): boolean | undefined => {
    const results = (condition === undefined ? [] : Array.isArray(condition) ? condition : [condition]).map((test) => holds(test, element, parent));

    if (results.includes(false)) return false;

    return results.includes(undefined) ? undefined : true;
  };

  const applyRule = (rule: Rule, element: Element, parent: Element | undefined, issue: (entry: Omit<Issue, 'tag' | 'line'>) => void) => {
    const applies = all(rule.when, element, parent);
    const required = rule.require === undefined ? true : all(rule.require, element, parent);
    const forbidden = rule.forbid === undefined ? false : all(rule.forbid, element, parent);

    if (applies === false) return;

    if (applies === undefined || (required === undefined && forbidden !== true) || (forbidden === undefined && required !== false)) {
      note(`Rule ${rule.id} on <${rule.tag}>, line ${element.sourceCodeLocation?.startLine ?? '?'}: depends on a value bound at runtime (not checked).`);

      return;
    }

    if (required === false || forbidden === true) issue({ rule: rule.id, severity: rule.severity ?? 'error', message: rule.message });
  };

  const checkValue = (component: ComponentEntry, prop: PropEntry, binding: { raw: string; value: string; dynamic: boolean }, issue: (entry: Omit<Issue, 'tag' | 'line'>) => void) => {
    const attribute = binding.raw;

    if (prop.deprecation) {
      const to = prop.deprecation.replacement?.name;

      issue({ rule: 'deprecated-prop', severity: 'warning', attribute, message: `\`${prop.attribute ?? prop.name}\` is deprecated.${to ? ` Use \`${to}\`.` : ` ${prop.deprecation.text}`}`, suggestion: to });
    }

    if (binding.dynamic) return;

    if (isBooleanProp(prop) && binding.value.toLowerCase() === 'false') {
      issue({ rule: 'boolean-attribute-false', severity: 'error', attribute, message: `${attribute}="false" still turns \`${prop.name}\` on: a boolean attribute is true whenever it is present. Leave it out.` });

      return;
    }

    const renamed = library.index.migrations.values.find((migration) => migration.tag === component.tag && (migration.prop === prop.name || migration.prop === prop.attribute) && migration.from === binding.value);

    if (renamed) {
      issue({ rule: 'deprecated-value', severity: prop.values?.includes(binding.value) ? 'warning' : 'error', attribute, message: `${attribute}="${binding.value}" was replaced by "${renamed.to}".${renamed.note ? ` ${renamed.note}` : ''}`, suggestion: `${attribute}="${renamed.to}"` });

      return;
    }

    if (prop.values && !prop.values.includes(binding.value)) {
      const nearest = closest(binding.value, prop.values.map((value) => [value, value]), 1)[0];

      issue({ rule: 'invalid-value', severity: 'error', attribute, message: `${attribute}="${binding.value}" is not one of ${prop.values.map((value) => `"${value}"`).join(', ')}.`, suggestion: nearest && `${attribute}="${nearest}"` });
    }
  };

  const renamedProp = (component: ComponentEntry, name: string) => library.index.migrations.props.find((migration) => migration.tag === component.tag && (migration.from === name || kebabCase(migration.from) === name));

  const checkAttribute = (component: ComponentEntry, binding: Extract<Binding, { kind: 'attr' }>, issue: (entry: Omit<Issue, 'tag' | 'line'>) => void) => {
    const prop = component.props.find((candidate) => candidate.attribute === binding.name);

    if (prop) return checkValue(component, prop, binding, issue);

    if (GLOBAL.has(binding.name) || /^(aria-|data-)/.test(binding.name) || /^on[a-z]+$/.test(binding.name)) return;
    const moved = renamedProp(component, binding.name);

    if (moved) return issue({ rule: 'removed-prop', severity: 'error', attribute: binding.raw, message: `\`${binding.raw}\` was replaced by \`${moved.to}\`.${moved.note ? ` ${moved.note}` : ''}`, suggestion: moved.to });

    // The JS name written as an attribute (`iconOnly` for `icon-only`), or a prop that has no attribute.
    const byName = component.props.find((candidate) => candidate.name.toLowerCase() === binding.name || candidate.name === camelCase(binding.name));

    if (byName?.attribute) return issue({ rule: 'unknown-attribute', severity: 'error', attribute: binding.raw, message: `The attribute is \`${byName.attribute}\` (\`${byName.name}\` is the JS property).`, suggestion: byName.attribute });

    if (byName) return issue({ rule: 'property-only', severity: 'error', attribute: binding.raw, message: `\`${byName.name}\` has no attribute (its type is ${byName.type}): set it as a JS property.` });
    const nearest = closest(binding.name, component.props.flatMap((candidate): [string, string][] => (candidate.attribute ? [[candidate.attribute, candidate.attribute]] : [])), 1)[0];

    issue({ rule: 'unknown-attribute', severity: 'warning', attribute: binding.raw, message: `<${component.tag}> has no attribute \`${binding.raw}\`.${nearest ? ` Did you mean \`${nearest}\`?` : ''}`, suggestion: nearest });
  };

  const checkProp = (component: ComponentEntry, binding: Extract<Binding, { kind: 'prop' }>, issue: (entry: Omit<Issue, 'tag' | 'line'>) => void) => {
    const prop = findProp(component, binding.name);

    if (prop) return checkValue(component, prop, binding, issue);

    if (FRAMEWORK_PROPS.has(binding.name) || GLOBAL.has(binding.name.toLowerCase()) || /^(aria|data)[A-Z-]/.test(binding.name)) return;
    const moved = renamedProp(component, binding.name) ?? renamedProp(component, kebabCase(binding.name));

    if (moved) return issue({ rule: 'removed-prop', severity: 'error', attribute: binding.raw, message: `\`${binding.name}\` was replaced by \`${moved.to}\`.${moved.note ? ` ${moved.note}` : ''}`, suggestion: moved.to });
    const nearest = closest(binding.name, component.props.map((candidate) => [candidate.name, candidate.name]), 1)[0];

    issue({ rule: 'unknown-prop', severity: 'warning', attribute: binding.raw, message: `<${component.tag}> has no prop \`${binding.name}\`.${nearest ? ` Did you mean \`${nearest}\`?` : ''}`, suggestion: nearest });
  };

  const checkEvent = (component: ComponentEntry, binding: Extract<Binding, { kind: 'event' }>, issue: (entry: Omit<Issue, 'tag' | 'line'>) => void) => {
    // Vue and Angular modifiers: @update.once, (keydown.enter).
    const name = binding.name.split('.')[0];
    const event = component.events.find((candidate) => eventKey(candidate.name) === eventKey(name));

    if (event?.deprecation) issue({ rule: 'deprecated-event', severity: 'warning', attribute: binding.raw, message: `The event \`${event.name}\` is deprecated. ${event.deprecation.text}` });

    if (event || NATIVE_EVENT.test(name.toLowerCase())) return;

    if (framework && !library.index.frameworks[framework] && syntax !== 'angular') note(`<${component.tag} ${binding.raw}>: without \`frameworks.${framework}\`, how this library's events are bound in ${syntax} isn't known.`);
    const nearest = closest(name, component.events.map((candidate) => [candidate.name, candidate.name]), 1)[0];

    issue({ rule: 'unknown-event', severity: 'warning', attribute: binding.raw, message: `<${component.tag}> has no event \`${name}\`.${component.events.length ? ` Its events: ${component.events.map((candidate) => candidate.name).join(', ')}.` : ' It emits no events.'}`, suggestion: nearest });
  };

  const walk = (nodes: ChildNode[], parent: Element | undefined) => {
    for (const node of nodes) {
      if (!isElement(node)) continue;
      parents.set(node, parent);
      check(node, parent);
      walk(childrenOf(node), node);
    }
  };

  walk(fragment.childNodes, undefined);

  const order = { error: 0, warning: 1, info: 2 };

  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || order[a.severity] - order[b.severity]);

  const valid = !issues.some((issue) => issue.severity === 'error');

  if (issues.length > MAX_ISSUES) {
    note(`${(issues.length - MAX_ISSUES).toLocaleString('en-US')} more issues after line ${issues[MAX_ISSUES - 1].line ?? '?'} are not listed: fix these and validate again.`);
    issues.length = MAX_ISSUES;
  }

  return { valid, syntax, syntaxGuessed: requested === undefined, components: [...components].sort(), issues, notChecked: [...notChecked] };
}

/** A prop by JS name, or by attribute (Vue takes either). */
export function findProp(component: ComponentEntry, name: string): PropEntry | undefined {
  return component.props.find((prop) => prop.name === name) ?? component.props.find((prop) => prop.attribute === name || prop.name === camelCase(name));
}

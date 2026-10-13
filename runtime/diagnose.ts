import type { ComponentEntry } from '../src/types.ts';
import { isBooleanProp, type Library } from './library.ts';
import type { Json } from './respond.ts';
import { words } from './search.ts';

// Likely causes for a described problem, read from the component's own metadata: what its
// events are called, which props have no attribute, whether outside CSS reaches inside it,
// whether it takes part in forms, which slots it has. The library's guidance adds its own.

export interface Cause {
  area: string;
  cause: string;
  fix: string;
  [key: string]: Json;
}

interface Area {
  name: string;
  /** Words in the symptom that point here. */
  matches: RegExp;
  causes(library: Library, component: ComponentEntry): Cause[];
}

const list = (names: string[]) => names.map((name) => `\`${name}\``).join(', ');

const AREAS: Area[] = [
  {
    name: 'rendering',
    matches: /render|display|appear|visible|blank|empty|nothing|invisible|undefined|not defined|unknown element|hydrat|upgrade|flash/,
    causes: (library, component) => [
      {
        area: 'rendering',
        cause: `<${component.tag}> isn't defined: the library's script hasn't loaded, so the browser shows an unknown element (its children, unstyled, or nothing).`,
        fix: `Load ${library.index.library.package ?? 'the library'} before using the tag, then check \`customElements.get('${component.tag}')\` in the console.`,
      },
      ...(component.dependencies.length > 0
        ? [{ area: 'rendering', cause: `It renders ${component.dependencies.map((tag) => `<${tag}>`).join(', ')} inside itself; those must be defined too.`, fix: 'Load the whole library, or each of those elements, not only this one.' }]
        : []),
      ...(component.props.some((prop) => prop.required)
        ? [{ area: 'rendering', cause: `It has required props: ${list(component.props.filter((prop) => prop.required).map((prop) => prop.attribute ?? prop.name))}.`, fix: 'Set every one of them.' }]
        : []),
    ],
  },
  {
    name: 'events',
    matches: /event|listener|handler|callback|fire|emit|trigger|click|onchange|oninput|\bon[a-z]+/,
    causes: (_library, component) =>
      component.events.length === 0
        ? [{ area: 'events', cause: `<${component.tag}> emits no events of its own.`, fix: 'Listen for the native event (click, input, change, …) on it instead.' }]
        : [
            {
              area: 'events',
              cause: `Its events are ${list(component.events.map((event) => event.name))}, spelled exactly so (event names are case-sensitive), each a CustomEvent with its data in \`event.detail\`.`,
              fix: `element.addEventListener('${component.events[0].name}', (event) => event.detail)`,
            },
            ...(component.events.some((event) => !event.bubbles)
              ? [{ area: 'events', cause: `${list(component.events.filter((event) => !event.bubbles).map((event) => event.name))} don't bubble.`, fix: 'Listen on the element itself, not on an ancestor.' }]
              : []),
            ...(component.events.some((event) => !event.composed)
              ? [{ area: 'events', cause: `${list(component.events.filter((event) => !event.composed).map((event) => event.name))} don't cross a shadow root.`, fix: 'Listen inside the same shadow root as the element.' }]
              : []),
          ],
  },
  {
    name: 'props',
    matches: /\bprops?\b|propert|attribute|ignored|object|array|json|boolean|\btrue\b|\bfalse\b/,
    causes: (_library, component) => {
      const propertyOnly = component.props.filter((prop) => !prop.attribute);
      const booleans = component.props.filter(isBooleanProp);
      const immutable = component.props.filter((prop) => !prop.mutable && !prop.reflect);

      return [
        ...(propertyOnly.length > 0
          ? [{ area: 'props', cause: `${list(propertyOnly.map((prop) => prop.name))} have no attribute (their types are objects, arrays or functions): written in HTML they are ignored.`, fix: `Set them as JS properties: element.${propertyOnly[0].name} = …` }]
          : []),
        ...(booleans.length > 0
          ? [{ area: 'props', cause: `${list(booleans.map((prop) => prop.attribute ?? prop.name))} are boolean attributes: any value, "false" included, turns them on.`, fix: 'Leave the attribute out for false.' }]
          : []),
        { area: 'props', cause: 'Attributes are kebab-case and properties camelCase; the wrong form is ignored silently.', fix: `Attributes: ${list(component.props.flatMap((prop) => (prop.attribute && prop.attribute !== prop.name ? [prop.attribute] : [])).slice(0, 8)) || 'the same as the property names here'}.` },
        ...(immutable.length > 0 && immutable.length < component.props.length
          ? [{ area: 'props', cause: `Only ${list(component.props.filter((prop) => prop.reflect).map((prop) => prop.attribute ?? prop.name)) || 'no props'} reflect to attributes, so reading an attribute (or a CSS attribute selector) won't see the others change.`, fix: 'Read the property, not the attribute.' }]
          : []),
      ];
    },
  },
  {
    name: 'styling',
    matches: /style|css|color|colour|theme|class|look|layout|shadow|font|spacing|size|width|height|margin|padding|dark|override/,
    causes: (_library, component) => {
      const shadow = component.encapsulation === 'shadow';

      return [
        {
          area: 'styling',
          cause: shadow ? "It renders in a shadow root: page CSS and utility classes style the host element, never what's inside." : `It renders in the light DOM (encapsulation: ${component.encapsulation}), so page CSS does reach inside it, and its own styles can be overridden by yours.`,
          fix: shadow ? 'Use its CSS custom properties and ::part() names, below.' : 'Check specificity and load order before reaching for !important.',
        },
        ...(component.cssProperties.length > 0 ? [{ area: 'styling', cause: 'It reads these custom properties.', fix: `Set on the element or an ancestor: ${list(component.cssProperties.map((property) => property.name))}.` }] : []),
        ...(component.parts.length > 0 ? [{ area: 'styling', cause: 'It exposes these parts.', fix: component.parts.map((part) => `${component.tag}::part(${part.name})`).join(', ') }] : []),
        ...(shadow && component.cssProperties.length === 0 && component.parts.length === 0 ? [{ area: 'styling', cause: 'It documents no custom properties and no parts.', fix: 'Only its props and the host element can be styled; anything else needs a change to the component.' }] : []),
        ...(component.tokens.length > 0 ? [{ area: 'styling', cause: 'Its styles read these design tokens.', fix: `Changing one changes it everywhere it is read: ${list(component.tokens.slice(0, 12))}${component.tokens.length > 12 ? ', …' : ''}.` }] : []),
      ];
    },
  },
  {
    name: 'forms',
    matches: /form|submit|\bpost|validat|\breset/,
    causes: (_library, component) =>
      component.formAssociated
        ? [
            { area: 'forms', cause: 'It is form-associated: it posts with its <form> like a native control, under its `name`.', fix: 'Give it a `name`; without one its value is left out of the form data.' },
            { area: 'forms', cause: "It must be a descendant of the <form> (or name it with a `form` attribute, where the component supports one).", fix: 'Check the markup: a control outside its form posts nothing.' },
          ]
        : [{ area: 'forms', cause: `<${component.tag}> is not form-associated: a <form> doesn't see its value.`, fix: 'Mirror its value into a hidden input, or read it in the submit handler.' }],
  },
  {
    name: 'slots',
    matches: /slot|child|content|nested|inside|text|label|icon|missing/,
    causes: (_library, component) =>
      component.slots.length === 0
        ? [{ area: 'slots', cause: `<${component.tag}> documents no slots: children placed in it aren't shown${component.encapsulation === 'shadow' ? '' : ' where you expect'}.`, fix: 'Pass content through its props instead.' }]
        : [
            {
              area: 'slots',
              cause: `Its slots: ${component.slots.map((slot) => (slot.name ? `"${slot.name}"` : 'the default slot')).join(', ')}. A child with any other \`slot\` value isn't rendered.`,
              fix: component.slots.some((slot) => slot.name) ? `<span slot="${component.slots.find((slot) => slot.name)?.name}">…</span> as a direct child` : 'Put the content directly inside the element.',
            },
            { area: 'slots', cause: 'A slotted element must be a direct child of the component, not nested in a wrapper.', fix: 'Move the `slot` attribute to the direct child.' },
          ],
  },
  {
    name: 'accessibility',
    matches: /aria|keyboard|focus|tab\b|screen ?reader|a11y|accessib|label|announce|contrast/,
    causes: (library, component) => {
      const notes = library.index.accessibility[component.tag];

      if (!notes) return [{ area: 'accessibility', cause: 'This library configured no accessibility notes for it.', fix: 'Check its props for a label (aria-label, label) and test it with the keyboard.' }];

      return [
        ...(notes.role ? [{ area: 'accessibility', cause: `Its role is ${notes.role}.`, fix: "Don't add another role on it." }] : []),
        ...(notes.keyboard ?? []).map((entry) => ({ area: 'accessibility', cause: `${entry.keys}: ${entry.does}`, fix: "That is its expected keyboard behaviour; a handler of yours that stops the event breaks it." })),
        ...(notes.notes ?? []).map((note) => ({ area: 'accessibility', cause: note, fix: 'See get_accessibility_info.' })),
      ];
    },
  },
];

export interface Diagnosis {
  /** The areas the symptom pointed at; every area when it pointed at none. */
  areas: string[];
  causes: Cause[];
}

export function diagnose(library: Library, component: ComponentEntry, symptom: string): Diagnosis {
  const lower = symptom.toLowerCase();
  const matched = AREAS.filter((area) => area.matches.test(lower));
  const chosen = matched.length > 0 ? matched : AREAS;
  const causes = chosen.flatMap((area) => area.causes(library, component));

  if (component.deprecation) {
    causes.unshift({ area: 'deprecation', cause: `<${component.tag}> is deprecated. ${component.deprecation.text}`, fix: component.deprecation.replacement ? `Use <${component.deprecation.replacement.name}>.` : 'See get_migration_guide.' });
  }

  // The library's own anti-patterns: those sharing a word with the symptom first, all of them when the symptom is vague.
  const terms = new Set(words(symptom));
  const guidance = library.index.guidance[component.tag]?.antiPatterns ?? [];
  const relevant = guidance.filter((entry) => words(`${entry.title} ${entry.description}`).some((word) => terms.has(word)));

  for (const entry of relevant.length > 0 ? relevant : matched.length === 0 ? guidance : []) {
    causes.push({ area: 'guidance', cause: `${entry.title}: ${entry.description}`, fix: entry.good ?? 'See the description.', bad: entry.bad });
  }

  return { areas: chosen.map((area) => area.name), causes };
}

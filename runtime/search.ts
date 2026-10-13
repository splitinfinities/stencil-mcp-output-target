import type { ComponentEntry } from '../src/types.ts';
import type { Library } from './library.ts';

// Weighted keyword search: the tag, then the summary and category, then the API's names, then
// the description and the library's guidance. No embeddings.

const STOP = new Set(
  'a all also an and any are as at be but by can component components do does element for from has have how i if in into is it its just me my need never no not of on one only or out show so still than that the their then there they this to up use want was what when which who why will with you your'.split(
    ' ',
  ),
);

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP.has(word));
}

/** A word and its plain singular, so "buttons" finds "button". */
const forms = (word: string) => (word.length > 3 && word.endsWith('s') ? [word, word.slice(0, -1)] : [word]);

export interface Hit {
  component: ComponentEntry;
  score: number;
  /** Where the query matched, strongest first. */
  matched: string[];
}

interface Field {
  name: string;
  weight: number;
  text: string;
}

function fields(library: Library, component: ComponentEntry): Field[] {
  const guidance = library.index.guidance[component.tag];
  const bare = library.prefix && component.tag.startsWith(library.prefix) ? component.tag.slice(library.prefix.length) : component.tag;

  return [
    { name: 'tag', weight: 10, text: bare.replace(/-/g, ' ') },
    { name: 'category', weight: 4, text: component.category ?? '' },
    { name: 'summary', weight: 4, text: component.summary },
    { name: 'props', weight: 2, text: component.props.map((prop) => `${prop.name} ${prop.attribute ?? ''} ${(prop.values ?? []).join(' ')}`).join(' ') },
    { name: 'slots', weight: 2, text: component.slots.map((slot) => slot.name).join(' ') },
    { name: 'events', weight: 2, text: component.events.map((event) => event.name).join(' ') },
    { name: 'description', weight: 1, text: component.description },
    {
      name: 'guidance',
      weight: 1,
      text: [...(guidance?.antiPatterns ?? []), ...(guidance?.bestPractices ?? [])].map((entry) => `${entry.title} ${entry.description}`).join(' '),
    },
  ];
}

export function search(library: Library, query: string, limit = 10): Hit[] {
  const terms = words(query);

  if (terms.length === 0) return [];

  const hits = library.index.components.flatMap((component): Hit[] => {
    let score = 0;
    const matched: string[] = [];

    for (const field of fields(library, component)) {
      const haystack = new Set(words(field.text).flatMap(forms));
      const found = terms.filter((term) => forms(term).some((form) => haystack.has(form)));

      if (found.length === 0) continue;
      score += field.weight * found.length;
      matched.push(field.name);
    }

    // The whole query as the tag ("date picker" → my-date-picker) outranks everything.
    if (component.tag.endsWith(terms.join('-'))) score += 20;

    // A deprecated component is a worse answer than its replacement.
    if (component.deprecation) score /= 2;

    return score > 0 ? [{ component, score, matched }] : [];
  });

  return hits.sort((a, b) => b.score - a.score || a.component.tag.localeCompare(b.component.tag)).slice(0, limit);
}

export interface Suggestion {
  tag: string;
  score: number;
  reason: string;
}

/** Components for a described need: the library's `intents` first, then search. */
export function suggest(library: Library, description: string, limit = 5): Suggestion[] {
  const lower = ` ${description.toLowerCase().replace(/[^a-z0-9<>-]+/g, ' ')} `;
  const found = new Map<string, Suggestion>();

  for (const [intent, tag] of Object.entries(library.index.intents)) {
    const phrase = intent.toLowerCase();
    const asTag = lower.includes(`<${phrase}>`);

    // A native tag's name can be an ordinary word ("a", "i", "p"): those count only written as a tag.
    if (!asTag && (phrase.length < 3 || (!lower.includes(` ${phrase} `) && !lower.includes(` ${phrase}s `)))) continue;
    const previous = found.get(tag);

    // A longer phrase is a more specific match.
    const score = 30 + phrase.length;

    if (!previous || previous.score < score) found.set(tag, { tag, score, reason: `"${intent}" is <${tag}> in this library.` });
  }

  for (const hit of search(library, description, limit * 2)) {
    const previous = found.get(hit.component.tag);

    if (previous) previous.score += hit.score;
    else found.set(hit.component.tag, { tag: hit.component.tag, score: hit.score, reason: `Matches its ${hit.matched.slice(0, 3).join(', ')}.` });
  }

  return [...found.values()].sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag)).slice(0, limit);
}

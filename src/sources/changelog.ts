import type { ChangelogEntry } from '../types.ts';

// A version heading, in the common styles:
//   ## [1.2.0] - 2026-01-05                        Keep a Changelog
//   ## [1.2.0](https://…/compare/…) (2026-01-05)   conventional-changelog
//   ## <small>1.2.1 (2026-01-09)</small>           conventional-changelog, a patch release
//   # 1.2.0 (2026-01-05)
const HEADING = /^#{1,3}\s+(?:<small>)?\[?v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\]?(?:\([^)]*\))?\s*(?:[-–—]\s*|\()?(\d{4}-\d{2}-\d{2})?\)?(?:<\/small>)?\s*$/;

/** The versions of a changelog, newest first as written. Text before the first version heading is dropped. */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: { entry: ChangelogEntry; lines: string[] } | undefined;

  const close = () => {
    if (!current) return;
    current.entry.body = current.lines.join('\n').trim();
    entries.push(current.entry);
  };

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(HEADING);

    if (!match) {
      current?.lines.push(line);
      continue;
    }

    close();
    const entry: ChangelogEntry = { version: match[1], body: '' };

    if (match[2]) entry.date = match[2];
    current = { entry, lines: [] };
  }

  close();

  return entries;
}

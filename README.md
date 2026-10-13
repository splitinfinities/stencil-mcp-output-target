# stencil-mcp-output-target

A [Stencil](https://stenciljs.com) output target that ships a **read-only MCP server inside your component library**. Add one entry to `outputTargets`, build, and `npx my-lib-mcp` gives a coding agent the library's real API: list, search, read, validate, suggest and diagnose.

```ts
// stencil.config.ts
import { mcpOutputTarget } from 'stencil-mcp-output-target';

export const config = {
  outputTargets: [
    { type: 'dist' },
    mcpOutputTarget(), // writes ./mcp/index.json, ./mcp/server.mjs, ./mcp/install.mjs and ./mcp/README.md
  ],
};
```

```json
// the library's package.json
{ "bin": { "my-lib-mcp": "mcp/server.mjs", "my-lib-mcp-install": "mcp/install.mjs" }, "files": ["dist/", "mcp/"] }
```

The people who use the library register the server with one command, `npx -y -p my-lib my-lib-mcp-install` ([below](#using-a-librarys-server)).

An agent that has the server stops guessing prop names. It asks which component fits, reads the API it was built with, and has its markup checked before it answers.

## Contents

- [Install](#install)
- [What the build writes](#what-the-build-writes)
- [Tools](#tools)
- [Options](#options)
- [What comes from the components](#what-comes-from-the-components)
- [Validation](#validation)
- [Resources and prompts](#resources-and-prompts)
- [Transports](#transports)
- [The CLI, and CI](#the-cli-and-ci)
- [Using a library's server](#using-a-librarys-server)
- [Limits](#limits)
- [Developing this package](#developing-this-package)

## Install

Node 22.18 or newer, for the build and for the server.

```sh
npm install --save-dev stencil-mcp-output-target
npx stencil-mcp-output-target init
```

`init` adds the `bin` and `files` entries to `package.json` and prints the config line. Then run a production build (`stencil build`) and commit `mcp/`.

The library gains two `bin` entries and **no dependencies**: `server.mjs` and `install.mjs` are self-contained, and the output target stays a devDependency.

## What the build writes

```
my-lib/
  package.json     bin + files (checked on every build, never written)
  mcp/
    index.json     everything the server knows; schemaVersion 1; sorted, no timestamps
    server.mjs     the server, copied from this package
    install.mjs    registers the server in a project's MCP client configs
    README.md      how to install and register the server
```

- **Production builds only.** A dev build (`--dev`, `--watch`) writes nothing; it only checks `package.json`.
- **`package.json` is yours.** The target never writes it. A missing `bin` or `files` entry is a warning in a dev build and an error in a production build, with the line to add.
- **Commit `mcp/`**, and check it in CI with `stencil-mcp-output-target check` ([below](#the-cli-and-ci)). Every file is deterministic: a second build writes the same bytes.
- **`server.mjs` holds no library data.** It is bundled once, in this package's release, and copied byte for byte, so it changes in your repository only when you upgrade this package. It is unminified, with a version header and the notices of what it bundles (the MCP SDK, zod and parse5).
- **`server.mjs` reads only `index.json` beside it.** It takes no path arguments, opens no other file and makes no network request.
- **`install.mjs` is the same script for every library**, with one line filled in: the server's name, the package, and the `bin` that runs the server (the one in your `package.json`, whatever you named it). It is plain JavaScript with no dependencies, and the only generated file that writes anything: one entry in a project's MCP client configs, when the person using the library runs it.
- **A schema mismatch is a startup error.** A server refuses an `index.json` from another schema version and names both, which catches a half-committed upgrade.
- **Stale files are removed.** `mcp/` holds generated files only.

The index's shape is published as [`schema/index.v1.json`](schema/index.v1.json).

## Tools

Fifteen tools, all read-only (`readOnlyHint`, `idempotentHint`, not `destructiveHint`, not `openWorldHint`), each with an output schema. A tag that isn't in the library returns "did you mean" suggestions.

| Tool | What it answers | Needs beyond the components |
|---|---|---|
| `list_components` | Every component, with categories and counts | nothing (`categories` improves it) |
| `get_component_api` | Props, events, methods, slots, parts, CSS custom properties | nothing |
| `search_components` | Keyword search over names, docs and guidance | nothing |
| `get_component_examples` | The usage examples its authors wrote | `usage/*.md` beside components |
| `validate_component_usage` | Markup checked against the real API | nothing (`rules`, `frameworks` extend it) |
| `suggest_components` | Which component fits a described need | nothing (`intents` improves it) |
| `get_component_relationships` | What renders what; what replaces what | nothing |
| `get_design_tokens` | The design tokens | `tokens` |
| `get_token_usage` | Which components read a token | `tokens`, and a `dist` output |
| `get_framework_usage` | Wrapper imports, binding syntax, `v-model` / `ngModel` | `frameworks` |
| `get_migration_guide` | Deprecated and removed names with replacements | `@deprecated`, `migrations`, `changelog` |
| `get_bundle_analysis` | What each component costs to load | a `dist` output, or `stats` |
| `get_accessibility_info` | Role, keyboard, ARIA, notes | `accessibility` |
| `diagnose_component` | Likely causes of a described problem | nothing (`guidance` adds the library's own) |
| `generate_snippet` | Code for one component, checked against its API | nothing (`frameworks` adds JSX, Vue, Angular) |

**A tool without data stays registered.** With no `tokens` configured, `get_design_tokens` is still listed; its description starts "Not available: this library configured no design tokens", and calling it returns:

```json
{ "available": false, "reason": "Not available: this library configured no design tokens.", "enableWith": "The `tokens` option of mcpOutputTarget()." }
```

Switch a tool off entirely with `tools: { get_design_tokens: false }`.

**Responses are compact.** `list_components` returns tag and summary, paged; `get_component_api` takes `sections` and `detail: 'full'`. A result over 24,000 characters of JSON is cut to what fits, and says what was dropped and how to ask for it:

```json
{ "truncated": { "reason": "The full result is over 24000 characters.", "dropped": { "components": { "shown": 147, "total": 200 } }, "hint": "Pass `category`, or a smaller `limit` with `offset`." } }
```

**Inputs are bounded.** Every tool's cost grows with what it is sent, and over HTTP one slow call holds up every client, so each string, list and object a tool takes has a limit in its input schema, and a call over one is refused before the tool runs:

| Input | Limit |
|---|---|
| `code` (`validate_component_usage`, `diagnose_component`) | 200,000 characters |
| a slot's HTML (`generate_snippet`) | 20,000 characters |
| any other string (a tag, a query, a description) | 1,000 characters |
| any list or object | 100 entries |
| all the lists and objects in one call's arguments, at any depth | 1,000 entries |

**Search is weighted keywords**: the tag, then the summary and category, then prop, slot and event names, then descriptions and guidance. No embeddings, no network.

## Options

Every option is optional. Every option is **checked at build** against the library's real names: a tag, prop, slot, event or token that doesn't exist is a build error naming the option and the entry, so curated data can't go stale quietly.

```ts
mcpOutputTarget({
  outDir: './mcp',              // default
  name: 'my-lib',               // the server's name; default: package.json name without its scope
  prefix: 'my-',                // default: the prefix most tags share
  exclude: ['my-internal'],     // or @mcpIgnore on the component
  tools: { get_bundle_analysis: false },

  categories: { 'my-input': 'form' },      // or @category on the component
  guidance,        // per tag: what to avoid and what to do
  accessibility,   // per tag: role, keyboard, ARIA, notes
  intents,         // a word, phrase or native tag → the component that does it
  rules,           // declarative validation rules

  tokens: ['src/css/tokens.css'],          // .css, or a W3C Design Tokens .json
  tokenCategories: { 'my-space': 'spacing' },
  frameworks: {
    react:   { package: '@my/react' },
    vue:     { package: '@my/vue', models: [...] },
    angular: { package: '@my/angular', valueAccessors: [...] },
  },
  migrations: { tags, props, values },     // what @deprecated can't express
  changelog: 'CHANGELOG.md',
  stats: 'stencil-stats.json',
})
```

Paths are relative to the Stencil package.

### `guidance`

```ts
guidance: {
  'my-button': {
    antiPatterns: [{
      title: "Don't wrap it in a link",
      description: 'Give it an href instead: it renders the link itself.',
      bad: '<a href="/x"><my-button>Go</my-button></a>',
      good: '<my-button href="/x">Go</my-button>',
    }],
    bestPractices: [{ title: 'One primary action per view', description: 'Use variant="outline" for the rest.', example: '…' }],
  },
}
```

Searched by `search_components`, returned by `get_component_api` (with `detail: 'full'` or `sections: ['guidance']`), printed on the component's page, and offered as a cause by `diagnose_component` when it shares a word with the symptom.

### `accessibility`

```ts
accessibility: {
  'my-dialog': {
    role: 'dialog',
    keyboard: [{ keys: 'Escape', does: 'Closes the dialog and returns focus to what opened it.' }],
    aria: ['aria-modal="true" while open'],
    notes: ['Give it a heading: it is the dialog\'s accessible name.'],
  },
}
```

### `intents`

```ts
intents: { modal: 'my-dialog', popup: 'my-dialog', select: 'my-select', 'text field': 'my-input' }
```

The names people use for what a component does, native tags included. `suggest_components` matches them as whole words ("a **modal** that confirms…", "replace the native **`<select>`**") ahead of keyword search.

### `rules`

See [Validation](#validation).

### `tokens` and `tokenCategories`

- A `.css` file is scanned for custom property declarations. The comment directly above one is its description. When a name is declared twice (a dark-mode override), the first declaration is the token's value.
- A `.json` file is read as a [W3C Design Tokens](https://www.designtokens.org/) (DTCG) document: every object with a `$value` is a token, named by its path (`my.color.brand` is `--my-color-brand`); `$type` is its category, inherited from its groups.
- `tokenCategories` maps a name's prefix to a category: `{ 'my-space': 'spacing' }` covers `--my-space-2`. The longest prefix wins.
- **Which components read which** comes from `var(--name)` in each component's compiled CSS (`dist/collection`), so it needs a `dist` output target.

### `frameworks`

Without it, the server speaks HTML and vanilla JS only. With it, `get_framework_usage` and `generate_snippet` write wrapper code, and the validator reads wrapper names (`<MyButton>`).

```ts
frameworks: {
  react: { package: '@my/react', exclude: ['my-plain'] },   // exclude: tags the wrappers leave out
  vue: { package: '@my/vue', models: [{ elements: ['my-input'], event: 'myChange', targetAttr: 'value' }] },
  angular: { package: '@my/angular', valueAccessors: [{ elements: ['my-input'], event: 'myChange', targetAttr: 'value', type: 'text' }] },
}
```

`models` and `valueAccessors` take the same objects as `@stencil/vue-output-target`'s `componentModels` and `@stencil/angular-output-target`'s `valueAccessorConfigs` (with `elementSelectors` named `elements`), so one list can feed both.

### `migrations` and `changelog`

`@deprecated` tags are read first ([below](#deprecations)). `migrations` adds what JSDoc can't say: tags that are gone, and renamed props and values.

```ts
migrations: {
  tags: { 'my-popup': { to: 'my-dialog', note: 'Removed in 1.0.' } },
  props: { 'my-button': { kind: 'variant' } },
  values: { 'my-button': { variant: { secondary: 'outline' } } },
}
```

A `from` name needn't exist any more; a `to` name must. `changelog` is a Markdown file with one heading per version, in the Keep a Changelog (`## [1.2.0] - 2026-01-05`) or conventional-changelog style (`## [1.2.0](…) (2026-01-05)`, `## <small>1.2.1 (2026-01-09)</small>`).

### `stats`

Sizes are measured from the lazy build (`dist/<namespace>/`): each component's entry chunk and the chunks it statically imports, in bytes as built. With `stats` naming the file a `{ type: 'stats', file }` output target writes, Stencil's own numbers are used for the entry chunks instead (the code before minification, so larger). The index records which (`sizes.source`: `stats` or `measured`) and `get_bundle_analysis` reports it.

## What comes from the components

Most of the index needs no options: it is read from the same docs Stencil's `docs-json` target writes.

| In the index | From |
|---|---|
| tag, summary, description | the component's JSDoc; the summary is its first sentence |
| props: attribute, type, allowed values, default, required, reflect, mutable | `@Prop()` |
| events, methods | `@Event()`, `@Method()` |
| slots, parts | `@slot`, `@part` JSDoc tags |
| CSS custom properties | `@prop --name: description` in the component's CSS |
| what it renders, what renders it | Stencil's dependency graph |
| examples | `usage/*.md` beside the component |
| category | `@category form` |
| left out | `@mcpIgnore` |
| deprecations | `@deprecated` on the component, a prop, an event or a method |
| form association | `formAssociated: true` in `@Component()` (read from the source) |
| a light-DOM component's slots | `<slot>` in its render function, when it has no `@slot` tags (read from the source) |

### Deprecations

Two forms name a replacement the tools can act on:

```ts
/** @deprecated Use <my-dialog> instead. */       // on a component: a replacement tag
/** @deprecated Use `size` instead. */            // on a prop, event or method: a replacement member
```

Text in any other form is kept verbatim and reported as a **build warning**, so you can see which deprecations have no machine-readable replacement.

## Validation

`validate_component_usage` takes markup and returns issues with a rule, a severity, a line and, where there is one, what to write instead. `valid` is false only for errors.

Built in, from metadata alone:

| Rule | Severity | Reports |
|---|---|---|
| `unknown-tag` | error | a tag within the library's prefix that isn't a component |
| `removed-tag` | error | a tag `migrations.tags` replaced |
| `deprecated-tag`, `deprecated-prop`, `deprecated-event` | warning | with the replacement |
| `removed-prop`, `deprecated-value` | error | a name `migrations` replaced (`deprecated-value` is a warning while the prop still takes the old value) |
| `unknown-attribute`, `unknown-prop`, `unknown-event` | warning | with the nearest real name |
| `unknown-attribute` | error | the JS name written as an attribute (`iconOnly` for `icon-only`) |
| `property-only` | error | a prop that has no attribute, written as one |
| `invalid-value` | error | a value outside the prop's union of literals |
| `missing-required-prop` | error | |
| `boolean-attribute-false` | error | `disabled="false"`, which is true |
| `form-control-without-name` | warning in a `<form>`, else info | a form-associated control without `name` |
| `unknown-slot` | error | a child asking for a slot the parent doesn't have |
| `redundant-nesting` | warning | a component wrapped in one it already renders |
| `self-closing-custom-element` | error | `<my-x />` in HTML |

Library rules are data, stored in the index and checked at build. No functions, no plugins.

```ts
rules: [
  { id: 'icon-only-label', tag: 'my-button', when: { attr: 'icon-only' }, require: { attr: 'aria-label' }, message: 'An icon-only button needs aria-label.' },
  { id: 'no-card-in-card', tag: 'my-card', forbid: { parent: 'my-card' }, message: 'Cards do not nest.' },
]
```

- `when`: the rule applies only to elements matching it. `require`: what such an element must have. `forbid`: what it must not have.
- A condition is one of `{ attr, equals? }` (present, or equal to a value), `{ slot }` (a child in that slot; `''` is the default slot), `{ parent }` and `{ child }` (the direct parent or a direct child's tag). A list of conditions must all hold.
- `severity` is `'error'` (the default) or `'warning'`.

**What it stops reading.** Three limits keep the validator's time proportional to the code, and each is reported in `notChecked` when it is reached, never silently:

- elements nested more than 1,000 deep (unclosed `<li>`, `<p>`, `<td>` and the like don't count as depth): the rest of the code is not read;
- more than 500 attributes on one tag: the rest of the code is not read;
- more than 100 issues: the first 100 by line are listed, with a count of the rest.

**Framework syntax.** There is one HTML parser (parse5). `syntax` is `html`, `jsx`, `vue` or `angular`, guessed when left out, and changes only how an attribute's name is read: `:size`, `[size]` and `size={x}` all check the prop `size`; `@myChange`, `(myChange)` and `onMyChange` check the event `myChange`. A bound value is listed in `notChecked` as "dynamic, not checked" and is never an error. Wrapper names (`<MyButton>`) resolve through `frameworks`; without it they are listed as not checked. Spread attributes, an unclosed expression and anything else the reader couldn't follow are listed there too, so a pass never hides a skipped region.

## Resources and prompts

Resources:

- `component://{tag}`: a component's page as Markdown (API tables, guidance, accessibility, examples). The tag completes.
- `component://{tag}/api.json`: its full API as JSON.
- `tokens://all`: the design tokens.
- `guide://migration`: deprecations and replacements, with the changelog.

Prompts, **experimental until 0.1.0** (they were written before the tools had real use, and may change):

- `build-ui` (`goal`, `framework?`): choose components, read their APIs, write, validate.
- `migrate-deprecated` (`code?`): replace everything deprecated or removed.
- `fix-component` (`tag`, `problem`, `code?`): diagnose, fix, validate.

The server's `instructions` are a generated summary: the library, the component count, which tool to start with, and which tools have no data.

## Transports

- **stdio**, by default.
- **`--http <port>`**: streamable HTTP at `http://127.0.0.1:<port>/mcp`. It listens on the loopback interface only; there is no host option. `Host` and `Origin` are checked on every request, against DNS rebinding: a request from another site's page is answered `403`.
- **Logging** goes to stderr, one line per request (`[mcp] tools/call get_component_api 1ms`). stdout carries only the protocol.

## The CLI, and CI

```sh
stencil-mcp-output-target init       # add the "bin" and "files" entries to package.json
stencil-mcp-output-target generate   # write mcp/ from a built package, as a production build does
stencil-mcp-output-target check      # exit 1 when mcp/ or package.json is out of date
```

`--package <dir>` names the Stencil package (default: the current directory), `--docs <file>` its docs-json file (default: `docs/documentation.json` and a few other usual places), and `--config <module>` a module whose default export is the options.

`generate` and `check` read a **built** package: its docs-json file (add `{ type: 'docs-json', file: 'docs/documentation.json' }` to `outputTargets`) and `dist/`. To give the CLI the same options as the build, keep them in a module both import:

```ts
// mcp.config.ts
import type { McpOutputTargetOptions } from 'stencil-mcp-output-target';

const options: McpOutputTargetOptions = { tokens: ['src/css/tokens.css'] };

export default options;
```

```ts
// stencil.config.ts
import options from './mcp.config';

outputTargets: [{ type: 'dist' }, { type: 'docs-json', file: 'docs/documentation.json' }, mcpOutputTarget(options)],
```

```yaml
# CI, after the build
- run: npx stencil-mcp-output-target check --config mcp.config.ts
```

## Using a library's server

In the project that uses the library, run its install script:

```sh
npx -y -p @my/lib my-lib-mcp-install
```

It adds the server to the project config of each MCP client the project uses (it looks for the client's directory or file), and to `.mcp.json` when the project shows none:

| `--client` | File | Client |
|---|---|---|
| `claude` | `.mcp.json` | Claude Code |
| `cursor` | `.cursor/mcp.json` | Cursor |
| `vscode` | `.vscode/mcp.json` | VS Code |
| `gemini` | `.gemini/settings.json` | Gemini CLI |

- `--client <name>` (repeated, or comma-separated) picks the clients; `--all` takes every one.
- `--dry-run` says what would change and writes nothing. `--remove` takes the entry out. `--print` prints the entry, for a client that isn't listed.
- It adds or updates that one entry and keeps everything else in the file, indentation included. Running it again changes nothing.
- It writes only under the current directory: project configs, never a user-wide one.
- A config it can't edit safely (JSON with comments, or a servers key that isn't an object) is left as it is; the script prints the entry to add by hand and exits 1.

The install script's `bin` is the server's with `-install`; `init` adds both, and the build fails without them. With the library installed, `node node_modules/@my/lib/mcp/install.mjs` runs the same script.

To register it by hand instead (`.mcp.json`, or your client's equivalent):

```json
{
  "mcpServers": {
    "my-lib": { "command": "npx", "args": ["-y", "-p", "@my/lib", "my-lib-mcp"] }
  }
}
```

Each library's generated `mcp/README.md` has its own names filled in.

## Limits

- **One Stencil package per server.** Merging several packages into one index is out of scope.
- **Examples come from `usage/*.md` only.** Story args are not read.
- **Tool names are unprefixed** (`list_components`). MCP clients already namespace tools by server name.
- **The index changes when a component's size does**, since sizes are in it; they sit in one sorted section so the diff stays local.
- **Snippets escape values, not slot content.** `generate_snippet` escapes every prop value for the place it lands (an attribute, a bound expression, a `<script>`). A slot's HTML is yours and goes in as written.
- **The JSX reader is not a JavaScript parser.** It cleans expressions out of markup well enough for parse5 to read the tags around them, and lists what it couldn't follow.

## Developing this package

```sh
pnpm install
pnpm typecheck
pnpm build            # dist/: the output target (ESM and CJS), the CLI, the types, server.mjs and install.mjs
pnpm build.fixture    # the same, then the fixture library with real Stencil, twice
pnpm test             # drives the server the fixture's build wrote
pnpm test.all         # build.fixture, then test
pnpm lint.licenses    # the licenses of what server.mjs bundles
node scripts/schema.mjs   # schema/index.v1.json
```

- `src/` is the output target: `reader.ts` (docs-json → index), `sources/` (tokens, sizes, changelog, `@deprecated`), `check.ts` (options and package.json), `index.ts` (`mcpOutputTarget()` and the pure `generate()`), `cli.ts`.
- `runtime/` is the server: it is bundled, with the MCP SDK and parse5, into `dist/server.mjs`. `runtime/install.mjs` is the install script: plain JavaScript, copied to `dist/install.mjs` as it is, with a `const LIBRARY` line that `installScript()` fills in for each library.
- `fixture/` is a library of eight `my-` components. The tests never mock the server: they import or spawn `fixture/mcp/server.mjs`, the file a real Stencil build wrote, and run `fixture/mcp/install.mjs` in scratch projects.
- The MCP SDK and parse5 are pinned exactly. An SDK upgrade rewrites `server.mjs` in every adopting library, so batch it into a release, and add any package the SDK newly bundles to `PREBUNDLED` in `scripts/bundle.mjs` (the build fails until you do).

## License

MIT. `server.mjs` bundles third-party software under the Apache-2.0, MIT, BSD-2-Clause and BSD-3-Clause licenses; their notices are in its header.

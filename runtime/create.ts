import { fromJsonSchema, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { SCHEMA_VERSION, type McpIndex } from '../src/types.ts';
import { Library } from './library.ts';
import { PROMPTS } from './prompts.ts';
import { componentJson, componentMarkdown, guideMarkdown, tokensJson } from './resources.ts';
import { notAvailable, respond } from './respond.ts';
import { bounded, MAX_INPUT_ELEMENTS, SHARED_OUTPUT, type Args, type ToolDefinition } from './tool.ts';
import { diagnoseComponent, generateSnippet, getFrameworkUsage, suggestComponents, validateComponentUsage } from './tools/advise.ts';
import { getAccessibilityInfo, getBundleAnalysis, getDesignTokens, getMigrationGuide, getTokenUsage } from './tools/data.ts';
import { getComponentApi, getComponentExamples, getComponentRelationships, listComponents, searchComponents } from './tools/lookup.ts';

declare const __SERVER_VERSION__: string | undefined;

/** The output target's version this server was bundled from. `dev` when run from source. */
export const SERVER_VERSION = typeof __SERVER_VERSION__ === 'string' ? __SERVER_VERSION__ : 'dev';

/** In the order TOOL_NAMES lists them. */
export const TOOLS: ToolDefinition[] = [
  listComponents,
  getComponentApi,
  searchComponents,
  getComponentExamples,
  validateComponentUsage,
  suggestComponents,
  getComponentRelationships,
  getDesignTokens,
  getTokenUsage,
  getFrameworkUsage,
  getMigrationGuide,
  getBundleAnalysis,
  getAccessibilityInfo,
  diagnoseComponent,
  generateSnippet,
];

function isIndexLike(value: unknown): value is { schemaVersion?: unknown } {
  return typeof value === 'object' && value !== null;
}

function isIndex(value: unknown): value is McpIndex {
  return isIndexLike(value) && value.schemaVersion === SCHEMA_VERSION;
}

/** The index, or an error naming both versions: a server and an index from different releases must not run together. */
export function checkIndex(value: unknown): McpIndex {
  if (isIndex(value)) return value;
  const found = isIndexLike(value) ? JSON.stringify(value.schemaVersion) : 'none';

  throw new Error(`index.json has schemaVersion ${found}; this server (stencil-mcp-output-target ${SERVER_VERSION}) reads schemaVersion ${SCHEMA_VERSION}. Rebuild the library so both files come from the same release.`);
}

export type Log = (line: string) => void;

function instructions(library: Library): string {
  const { index } = library;
  const unavailable = TOOLS.filter((tool) => tool.requires && !index.capabilities[tool.requires.capability] && !index.disabledTools.includes(tool.name)).map((tool) => tool.name);

  return [
    `${index.library.package ?? index.library.name}${index.library.version ? ` ${index.library.version}` : ''}: ${index.components.length} web components${index.library.prefix ? `, tags starting with ${index.library.prefix}` : ''}. Read-only.`,
    'Start with list_components, or suggest_components for "which component does X". Read get_component_api before writing a component, and run validate_component_usage on markup before returning it.',
    ...(unavailable.length > 0 ? [`This library has no data for: ${unavailable.join(', ')}.`] : []),
  ].join(' ');
}

// The HTTP transport asks for a server per request. What doesn't depend on the request is made
// once: the lookups over an index, and each tool's and prompt's compiled schemas (compiling a
// schema costs far more than answering a call).
const libraries = new WeakMap<McpIndex, Library>();

function libraryFor(index: McpIndex): Library {
  const cached = libraries.get(index);

  if (cached) return cached;
  const library = new Library(index);

  libraries.set(index, library);

  return library;
}

const TOOL_SCHEMAS = new Map(
  TOOLS.map((tool) => [
    tool.name,
    {
      input: fromJsonSchema<Args>({ ...bounded({ type: 'object', properties: tool.input.properties }), required: tool.input.required ?? [], additionalProperties: false }),
      output: fromJsonSchema({ type: 'object', properties: { ...SHARED_OUTPUT, ...tool.output } }),
    },
  ]),
);

const PROMPT_SCHEMAS = new Map(
  PROMPTS.map((prompt) => [
    prompt.name,
    fromJsonSchema<Record<string, string | undefined>>({
      type: 'object',
      properties: Object.fromEntries(prompt.arguments.map((argument) => [argument.name, { type: 'string', description: argument.description }])),
      required: prompt.arguments.flatMap((argument) => (argument.required ? [argument.name] : [])),
    }),
  ]),
);

/** A server over one index. `log` gets one line per request. */
export function createServer(indexJson: unknown, log: Log = () => {}): McpServer {
  const library = libraryFor(checkIndex(indexJson));
  const { index } = library;
  const server = new McpServer({ name: index.library.name, version: index.library.version ?? SERVER_VERSION }, { instructions: instructions(library), maxToolInputElements: MAX_INPUT_ELEMENTS });

  const timed = <T>(what: string, run: () => T): T => {
    const start = performance.now();

    try {
      const result = run();

      log(`${what} ${Math.round(performance.now() - start)}ms`);

      return result;
    } catch (error) {
      log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);

      throw error;
    }
  };

  for (const tool of TOOLS) {
    if (index.disabledTools.includes(tool.name)) continue;
    const missing = tool.requires && !index.capabilities[tool.requires.capability] ? tool.requires : undefined;
    const schemas = TOOL_SCHEMAS.get(tool.name);

    if (!schemas) continue;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        // Said up front, so an agent doesn't spend a call finding out.
        description: missing ? `Not available: this library configured no ${missing.what}. ${tool.description}` : tool.description,
        inputSchema: schemas.input,
        outputSchema: schemas.output,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      (args) => timed(`tools/call ${tool.name}`, () => respond(missing ? notAvailable(missing.what, missing.option) : tool.run(library, args), tool.hint)),
    );
  }

  const tags = () => index.components.map((component) => component.tag);
  const completeTag = (value: string) => tags().filter((tag) => tag.startsWith(value) || tag.startsWith(`${index.library.prefix}${value}`)).slice(0, 100);
  const one = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

  const component = (name: string) => {
    const found = library.find(decodeURIComponent(name));

    if (!found) throw new Error(library.unknown(name).message);

    return found;
  };

  // The more specific template first.
  server.registerResource(
    'component-api',
    new ResourceTemplate('component://{tag}/api.json', { list: undefined, complete: { tag: completeTag } }),
    { title: 'Component API (JSON)', description: "One component's full API as JSON.", mimeType: 'application/json' },
    (uri, variables) => timed(`resources/read ${uri.href}`, () => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: componentJson(library, component(one(variables.tag))) }] })),
  );

  server.registerResource(
    'component',
    new ResourceTemplate('component://{tag}', {
      list: () => ({ resources: index.components.map((entry) => ({ uri: `component://${entry.tag}`, name: entry.tag, description: entry.summary || undefined, mimeType: 'text/markdown' })) }),
      complete: { tag: completeTag },
    }),
    { title: 'Component page', description: "One component's documentation as Markdown: API tables, guidance, accessibility and examples.", mimeType: 'text/markdown' },
    (uri, variables) => timed(`resources/read ${uri.href}`, () => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: componentMarkdown(library, component(one(variables.tag))) }] })),
  );

  server.registerResource('tokens', 'tokens://all', { title: 'Design tokens', description: index.capabilities.tokens ? 'Every design token, as JSON.' : 'Not available: this library configured no tokens.', mimeType: 'application/json' }, (uri) =>
    timed(`resources/read ${uri.href}`, () => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: tokensJson(library) }] })),
  );

  server.registerResource('migration-guide', 'guide://migration', { title: 'Migration guide', description: 'Deprecated and removed tags, props and values with their replacements.', mimeType: 'text/markdown' }, (uri) =>
    timed(`resources/read ${uri.href}`, () => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guideMarkdown(library) }] })),
  );

  for (const prompt of PROMPTS) {
    const schema = PROMPT_SCHEMAS.get(prompt.name);

    if (!schema) continue;

    server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description, argsSchema: schema }, (args) =>
      timed(`prompts/get ${prompt.name}`, () => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.text(library, args) } }] })),
    );
  }

  return server;
}

// Writes schema/index.v1.json, the JSON Schema of mcp/index.json. Kept as a script so the
// shared pieces are written once; test/index.test.ts checks the fixture's index against it.
//   node scripts/schema.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './bundle.mjs';

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const integer = { type: 'integer', minimum: 0 };
const strings = { type: 'array', items: string };
const object = (properties, required = Object.keys(properties), extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const list = (items) => ({ type: 'array', items });
const record = (values) => ({ type: 'object', additionalProperties: values });
const ref = (name) => ({ $ref: `#/$defs/${name}` });

const TOOLS = ['list_components', 'get_component_api', 'search_components', 'get_component_examples', 'validate_component_usage', 'suggest_components', 'get_component_relationships', 'get_design_tokens', 'get_token_usage', 'get_framework_usage', 'get_migration_guide', 'get_bundle_analysis', 'get_accessibility_info', 'diagnose_component', 'generate_snippet'];

const named = object({ name: string, description: string });

const ruleTest = {
  oneOf: [
    object({ attr: string, equals: string }, ['attr']),
    object({ slot: string }),
    object({ parent: string }),
    object({ child: string }),
  ],
};

const condition = { oneOf: [ref('ruleTest'), list(ref('ruleTest'))] };

const binding = object({ elements: strings, event: string, targetAttr: string, type: string }, ['elements', 'event', 'targetAttr']);

const framework = object({ package: string, exclude: strings, models: list(binding), valueAccessors: list(binding) }, ['package']);

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://unpkg.com/stencil-mcp-output-target/schema/index.v1.json',
  title: 'stencil-mcp-output-target index, schema version 1',
  description: "Everything a library's MCP server knows: mcp/index.json, written by mcpOutputTarget() and read by mcp/server.mjs.",
  ...object({
    schemaVersion: { const: 1 },
    generator: object({ name: string, version: string }),
    library: object({ name: string, package: string, version: string, prefix: string }, ['name', 'prefix']),
    capabilities: object(Object.fromEntries(['examples', 'categories', 'guidance', 'accessibility', 'intents', 'rules', 'tokens', 'tokenUsage', 'frameworks', 'migrations', 'changelog', 'sizes'].map((name) => [name, boolean]))),
    disabledTools: list({ enum: TOOLS }),
    components: list(ref('component')),
    tokens: list(object({ name: string, path: string, value: string, category: string, description: string, source: string }, ['name', 'value', 'source'])),
    sizes: object({
      source: { enum: ['stats', 'measured', null] },
      components: record(object({ entry: string, entryBytes: integer, totalBytes: integer, shared: strings }, ['entry', 'entryBytes', 'shared'])),
    }),
    guidance: record(
      object(
        {
          antiPatterns: list(object({ title: string, description: string, bad: string, good: string }, ['title', 'description'])),
          bestPractices: list(object({ title: string, description: string, example: string }, ['title', 'description'])),
        },
        [],
      ),
    ),
    accessibility: record(object({ role: string, keyboard: list(object({ keys: string, does: string })), aria: strings, notes: strings }, [])),
    intents: record(string),
    rules: list(object({ id: string, tag: string, when: condition, require: condition, forbid: condition, message: string, severity: { enum: ['error', 'warning'] } }, ['id', 'tag', 'message'])),
    frameworks: object({ react: framework, vue: framework, angular: framework }, []),
    migrations: object({
      tags: list(object({ from: string, to: string, note: string }, ['from', 'to'])),
      props: list(object({ tag: string, from: string, to: string, note: string }, ['tag', 'from', 'to'])),
      values: list(object({ tag: string, prop: string, from: string, to: string, note: string }, ['tag', 'prop', 'from', 'to'])),
    }),
    changelog: list(object({ version: string, date: string, body: string }, ['version', 'body'])),
  }),
  $defs: {
    ruleTest,
    deprecation: object({ text: string, replacement: object({ kind: { enum: ['tag', 'prop', 'value'] }, name: string }) }, ['text']),
    component: object(
      {
        tag: string,
        summary: string,
        description: string,
        category: string,
        docsTags: list(object({ name: string, text: string })),
        encapsulation: { enum: ['shadow', 'scoped', 'none'] },
        formAssociated: boolean,
        deprecation: ref('deprecation'),
        props: list(
          object(
            { name: string, attribute: string, type: string, values: strings, default: string, required: boolean, reflect: boolean, mutable: boolean, description: string, deprecation: ref('deprecation') },
            ['name', 'type', 'required', 'reflect', 'mutable', 'description'],
          ),
        ),
        events: list(object({ name: string, detail: string, bubbles: boolean, cancelable: boolean, composed: boolean, description: string, deprecation: ref('deprecation') }, ['name', 'detail', 'bubbles', 'cancelable', 'composed', 'description'])),
        methods: list(object({ name: string, signature: string, description: string, deprecation: ref('deprecation') }, ['name', 'signature', 'description'])),
        slots: list(named),
        parts: list(named),
        cssProperties: list(named),
        dependencies: strings,
        dependents: strings,
        examples: list(object({ title: string, markdown: string })),
        tokens: strings,
      },
      ['tag', 'summary', 'description', 'docsTags', 'encapsulation', 'formAssociated', 'props', 'events', 'methods', 'slots', 'parts', 'cssProperties', 'dependencies', 'dependents', 'examples', 'tokens'],
    ),
  },
};

writeFileSync(join(ROOT, 'schema/index.v1.json'), `${JSON.stringify(schema, null, 2)}\n`);
console.log('schema/index.v1.json');

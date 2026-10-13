// The index: everything the server knows about a library, as `mcp/index.json`. The output target
// writes it and the runtime reads it, so both import these types. schema/index.v1.json is the
// same shape as JSON Schema.

/** Bumped when a server built for the previous shape could misread the file. */
export const SCHEMA_VERSION = 1;

/** Every tool the server registers, in the order they are listed. */
export const TOOL_NAMES = [
  'list_components',
  'get_component_api',
  'search_components',
  'get_component_examples',
  'validate_component_usage',
  'suggest_components',
  'get_component_relationships',
  'get_design_tokens',
  'get_token_usage',
  'get_framework_usage',
  'get_migration_guide',
  'get_bundle_analysis',
  'get_accessibility_info',
  'diagnose_component',
  'generate_snippet',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type FrameworkName = 'react' | 'vue' | 'angular';

export const FRAMEWORK_NAMES: readonly FrameworkName[] = ['react', 'vue', 'angular'];

/** What a deprecated tag, prop or value is replaced by. */
export interface Replacement {
  kind: 'tag' | 'prop' | 'value';
  name: string;
}

export interface Deprecation {
  /** The `@deprecated` text as written. */
  text: string;
  /** Present when the text follows the documented form, or `migrations` names one. */
  replacement?: Replacement;
}

export interface PropEntry {
  /** The JS property name. */
  name: string;
  /** The HTML attribute, when the prop has one. */
  attribute?: string;
  type: string;
  /** The string literals the type allows, when it is a union of them. */
  values?: string[];
  default?: string;
  required: boolean;
  reflect: boolean;
  mutable: boolean;
  description: string;
  deprecation?: Deprecation;
}

export interface EventEntry {
  name: string;
  detail: string;
  bubbles: boolean;
  cancelable: boolean;
  composed: boolean;
  description: string;
  deprecation?: Deprecation;
}

export interface MethodEntry {
  name: string;
  signature: string;
  description: string;
  deprecation?: Deprecation;
}

export interface NamedDoc {
  /** `''` is the default slot. */
  name: string;
  description: string;
}

export interface Example {
  title: string;
  /** Markdown, as written in `usage/<title>.md`. */
  markdown: string;
}

export interface ComponentEntry {
  tag: string;
  /** The first sentence of the description. */
  summary: string;
  description: string;
  category?: string;
  /** JSDoc tags this index doesn't otherwise read. */
  docsTags: { name: string; text: string }[];
  encapsulation: 'shadow' | 'scoped' | 'none';
  formAssociated: boolean;
  deprecation?: Deprecation;
  props: PropEntry[];
  events: EventEntry[];
  methods: MethodEntry[];
  slots: NamedDoc[];
  parts: NamedDoc[];
  cssProperties: NamedDoc[];
  /** Tags this component renders. */
  dependencies: string[];
  /** Tags that render this component. */
  dependents: string[];
  examples: Example[];
  /** Design tokens its compiled CSS reads through `var()`. */
  tokens: string[];
}

export interface TokenEntry {
  /** The CSS custom property, with its leading dashes. A DTCG token's is its path joined with dashes. */
  name: string;
  /** A DTCG token's dotted path. */
  path?: string;
  value: string;
  category?: string;
  description?: string;
  /** The file it was read from, as the option named it. */
  source: string;
}

export interface SizeEntry {
  /** The chunk that defines the component. */
  entry: string;
  entryBytes: number;
  /** The entry plus every chunk it statically imports, in bytes as built. Absent when only a stats file was read. */
  totalBytes?: number;
  /** Chunks it imports, shared with other components. */
  shared: string[];
}

export interface AntiPattern {
  title: string;
  description: string;
  bad?: string;
  good?: string;
}

export interface BestPractice {
  title: string;
  description: string;
  example?: string;
}

export interface Guidance {
  antiPatterns?: AntiPattern[];
  bestPractices?: BestPractice[];
}

export interface Accessibility {
  role?: string;
  keyboard?: { keys: string; does: string }[];
  aria?: string[];
  notes?: string[];
}

/** One condition, or several that must all hold. */
export type RuleCondition = RuleTest | RuleTest[];

export type RuleTest =
  | { attr: string; equals?: string }
  | { slot: string }
  | { parent: string }
  | { child: string };

export interface Rule {
  id: string;
  tag: string;
  /** The rule applies only to elements matching this. */
  when?: RuleCondition;
  /** What a matching element must have. */
  require?: RuleCondition;
  /** What a matching element must not have. */
  forbid?: RuleCondition;
  message: string;
  severity?: 'error' | 'warning';
}

export interface ValueBinding {
  /** Tags the binding applies to. */
  elements: string[];
  event: string;
  /** The prop the value lives in. */
  targetAttr: string;
  type?: string;
}

export interface FrameworkEntry {
  /** The wrapper package to import from. */
  package: string;
  /** Tags the wrapper package leaves out. */
  exclude?: string[];
  /** Vue `v-model` bindings. */
  models?: ValueBinding[];
  /** Angular value accessors (`ngModel`, `formControlName`). */
  valueAccessors?: ValueBinding[];
}

export interface TagMigration {
  from: string;
  to: string;
  note?: string;
}

export interface PropMigration {
  tag: string;
  from: string;
  to: string;
  note?: string;
}

export interface ValueMigration {
  tag: string;
  prop: string;
  from: string;
  to: string;
  note?: string;
}

export interface Migrations {
  tags: TagMigration[];
  props: PropMigration[];
  values: ValueMigration[];
}

export interface ChangelogEntry {
  version: string;
  date?: string;
  /** Markdown under the version's heading. */
  body: string;
}

/** Which sections hold data. A tool whose section is empty answers "not available". */
export interface Capabilities {
  examples: boolean;
  categories: boolean;
  guidance: boolean;
  accessibility: boolean;
  intents: boolean;
  rules: boolean;
  tokens: boolean;
  tokenUsage: boolean;
  frameworks: boolean;
  migrations: boolean;
  changelog: boolean;
  sizes: boolean;
}

export interface McpIndex {
  schemaVersion: typeof SCHEMA_VERSION;
  generator: { name: string; version: string };
  library: {
    /** The server's name. */
    name: string;
    /** The npm package, when the library has a package.json. */
    package?: string;
    version?: string;
    /** What every tag starts with (`my-`), or `''`. */
    prefix: string;
  };
  capabilities: Capabilities;
  /** Tools switched off with the `tools` option. */
  disabledTools: ToolName[];
  components: ComponentEntry[];
  tokens: TokenEntry[];
  sizes: { source: 'stats' | 'measured' | null; components: Record<string, SizeEntry> };
  guidance: Record<string, Guidance>;
  accessibility: Record<string, Accessibility>;
  /** A word, phrase or native tag → the component that does it. */
  intents: Record<string, string>;
  rules: Rule[];
  frameworks: Partial<Record<FrameworkName, FrameworkEntry>>;
  migrations: Migrations;
  changelog: ChangelogEntry[];
}

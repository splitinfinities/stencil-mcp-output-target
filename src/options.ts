import type { Accessibility, FrameworkEntry, FrameworkName, Guidance, Rule, ToolName } from './types.ts';

export interface MigrationOptions {
  /** A removed or renamed tag → its replacement. */
  tags?: Record<string, string | { to: string; note?: string }>;
  /** Per tag: a renamed prop → its replacement. */
  props?: Record<string, Record<string, string | { to: string; note?: string }>>;
  /** Per tag, per prop: a renamed value → its replacement. */
  values?: Record<string, Record<string, Record<string, string | { to: string; note?: string }>>>;
}

export interface McpOutputTargetOptions {
  /** Where `index.json`, `server.mjs`, `install.mjs` and `README.md` go, relative to the Stencil package. Default `./mcp`. */
  outDir?: string;
  /** The server's name. Default: the package.json name without its scope. */
  name?: string;
  /** What the library's tags start with (`my-`); the validator reports unknown tags that start with it. Default: the prefix most tags share. */
  prefix?: string;
  /** Tags to leave out. A component can also carry `@mcpIgnore`. */
  exclude?: string[];
  /** Switch a tool off by name: `{ get_bundle_analysis: false }`. */
  tools?: Partial<Record<ToolName, boolean>>;

  /** Tag → category. A component can also carry `@category`. */
  categories?: Record<string, string>;
  /** Per tag: what to avoid and what to do. */
  guidance?: Record<string, Guidance>;
  /** Per tag: role, keyboard, ARIA and notes. */
  accessibility?: Record<string, Accessibility>;
  /** A word, phrase or native tag → the component that does it: `{ modal: 'my-dialog', select: 'my-select' }`. */
  intents?: Record<string, string>;
  /** Declarative validation rules. */
  rules?: Rule[];

  /** Token files: `.css` is scanned for custom properties, `.json` is read as a W3C Design Tokens file. */
  tokens?: string | string[];
  /** A token name's prefix → category: `{ 'my-space': 'spacing' }`. */
  tokenCategories?: Record<string, string>;
  /** The wrapper packages. Without it the server speaks HTML and vanilla JS only. */
  frameworks?: Partial<Record<FrameworkName, FrameworkEntry>>;
  /** What `@deprecated` can't express. */
  migrations?: MigrationOptions;
  /** A changelog in the Keep a Changelog or conventional-changelog heading style. */
  changelog?: string;
  /** A Stencil stats file (`{ type: 'stats' }`). Without it, sizes are measured from the lazy build. */
  stats?: string;
}

export const DEFAULT_OUT_DIR = './mcp';

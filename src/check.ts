import { FRAMEWORK_NAMES, TOOL_NAMES, type ComponentEntry, type FrameworkName, type RuleCondition, type RuleTest, type TokenEntry, type ValueBinding } from './types.ts';
import type { McpOutputTargetOptions } from './options.ts';
import type { Message } from './reader.ts';

// Every option is checked against the library's real names, so curated data can't go stale
// quietly: a renamed prop breaks the build, not the agent.

/** Attributes any element takes, which a rule may name without the component declaring them. */
const GLOBAL_ATTRIBUTES = new Set(['class', 'dir', 'hidden', 'id', 'inert', 'lang', 'part', 'popover', 'role', 'slot', 'style', 'tabindex', 'title']);

export const isGlobalAttribute = (name: string) => GLOBAL_ATTRIBUTES.has(name) || name.startsWith('aria-') || name.startsWith('data-');

const tests = (condition: RuleCondition | undefined): RuleTest[] => (condition === undefined ? [] : Array.isArray(condition) ? condition : [condition]);

const isRecord = (value: object): value is Record<string, string | undefined> => !Array.isArray(value);

export function checkOptions(options: McpOutputTargetOptions, components: ComponentEntry[], allTags: string[], tokens: TokenEntry[], prefix: string): Message[] {
  const errors: Message[] = [];
  const byTag = new Map(components.map((component) => [component.tag, component]));
  const fail = (where: string, message: string) => errors.push({ where, message });

  const needTag = (where: string, tag: string) => {
    if (byTag.has(tag)) return true;
    fail(where, `<${tag}> is not a component of this library${allTags.includes(tag) ? ' (it is excluded)' : ''}`);

    return false;
  };

  for (const tag of options.exclude ?? []) {
    if (!allTags.includes(tag)) fail('exclude', `<${tag}> is not a component of this library`);
  }

  for (const name of Object.keys(options.tools ?? {})) {
    if (!TOOL_NAMES.some((tool) => tool === name)) fail(`tools.${name}`, `not a tool (the tools are ${TOOL_NAMES.join(', ')})`);
  }

  for (const option of ['categories', 'guidance', 'accessibility'] as const) {
    for (const tag of Object.keys(options[option] ?? {})) needTag(`${option}.${tag}`, tag);
  }

  for (const [intent, tag] of Object.entries(options.intents ?? {})) needTag(`intents.${intent}`, tag);

  // Rules.
  const ids = new Set<string>();

  (options.rules ?? []).forEach((rule, i) => {
    const where = `rules[${i}]${rule.id ? ` (${rule.id})` : ''}`;

    if (!rule.id) fail(where, 'needs an id');

    if (ids.has(rule.id)) fail(where, `the id ${rule.id} is used twice`);
    ids.add(rule.id);

    if (!rule.message) fail(where, 'needs a message');

    if (!rule.require && !rule.forbid) fail(where, 'needs `require` or `forbid`');

    if (!needTag(where, rule.tag)) return;
    const component = byTag.get(rule.tag);

    for (const [part, condition] of [['when', rule.when], ['require', rule.require], ['forbid', rule.forbid]] as const) {
      for (const test of tests(condition)) {
        if (!isRecord(test)) continue;

        if ('attr' in test && test.attr !== undefined) {
          const prop = component?.props.find((candidate) => candidate.attribute === test.attr);

          if (!prop && !isGlobalAttribute(test.attr)) fail(`${where}.${part}`, `<${rule.tag}> has no attribute ${test.attr}`);

          if (prop?.values && test.equals !== undefined && !prop.values.includes(test.equals)) {
            fail(`${where}.${part}`, `<${rule.tag} ${test.attr}> doesn't take "${test.equals}" (it takes ${prop.values.join(', ')})`);
          }
        } else if ('slot' in test && test.slot !== undefined) {
          if (!component?.slots.some((slot) => slot.name === test.slot)) fail(`${where}.${part}`, `<${rule.tag}> has no slot "${test.slot}"`);
        } else if ('parent' in test && test.parent !== undefined) {
          if (prefix && test.parent.startsWith(prefix)) needTag(`${where}.${part}`, test.parent);
        } else if ('child' in test && test.child !== undefined) {
          if (prefix && test.child.startsWith(prefix)) needTag(`${where}.${part}`, test.child);
        } else {
          fail(`${where}.${part}`, 'a condition is one of { attr, equals? }, { slot }, { parent }, { child }');
        }
      }
    }
  });

  // Tokens.
  for (const candidate of Object.keys(options.tokenCategories ?? {})) {
    const bare = candidate.replace(/^--/, '');

    if (!tokens.some((token) => token.name === `--${bare}` || token.name.startsWith(`--${bare}-`))) fail(`tokenCategories.${candidate}`, 'matches no token');
  }

  // Frameworks.
  for (const [name, framework] of Object.entries(options.frameworks ?? {})) {
    const where = `frameworks.${name}`;

    if (!FRAMEWORK_NAMES.some((known) => known === name)) {
      fail(where, `not a framework (the frameworks are ${FRAMEWORK_NAMES.join(', ')})`);
      continue;
    }

    if (!framework?.package) fail(where, 'needs the wrapper `package`');

    for (const tag of framework?.exclude ?? []) needTag(`${where}.exclude`, tag);

    const bindings: [string, ValueBinding[] | undefined][] = [['models', framework?.models], ['valueAccessors', framework?.valueAccessors]];

    for (const [key, list] of bindings) {
      (list ?? []).forEach((binding, i) => {
        for (const tag of binding.elements) {
          if (!needTag(`${where}.${key}[${i}]`, tag)) continue;
          const component = byTag.get(tag);

          if (!component?.events.some((event) => event.name === binding.event)) fail(`${where}.${key}[${i}]`, `<${tag}> has no event ${binding.event}`);

          if (!component?.props.some((prop) => prop.name === binding.targetAttr || prop.attribute === binding.targetAttr)) fail(`${where}.${key}[${i}]`, `<${tag}> has no prop ${binding.targetAttr}`);
        }
      });
    }
  }

  // Migrations. A `from` name needn't exist (it may be gone); a `to` name must.
  const to = (value: string | { to: string }) => (typeof value === 'string' ? value : value.to);

  for (const [from, value] of Object.entries(options.migrations?.tags ?? {})) needTag(`migrations.tags.${from}`, to(value));

  for (const [tag, props] of Object.entries(options.migrations?.props ?? {})) {
    if (!needTag(`migrations.props.${tag}`, tag)) continue;

    for (const [from, value] of Object.entries(props)) {
      if (!byTag.get(tag)?.props.some((prop) => prop.name === to(value) || prop.attribute === to(value))) fail(`migrations.props.${tag}.${from}`, `<${tag}> has no prop ${to(value)}`);
    }
  }

  for (const [tag, props] of Object.entries(options.migrations?.values ?? {})) {
    if (!needTag(`migrations.values.${tag}`, tag)) continue;

    for (const [name, values] of Object.entries(props)) {
      const prop = byTag.get(tag)?.props.find((candidate) => candidate.name === name || candidate.attribute === name);

      if (!prop) {
        fail(`migrations.values.${tag}.${name}`, `<${tag}> has no prop ${name}`);
        continue;
      }

      for (const [from, value] of Object.entries(values)) {
        if (prop.values && !prop.values.includes(to(value))) fail(`migrations.values.${tag}.${name}.${from}`, `${name} doesn't take "${to(value)}" (it takes ${prop.values.join(', ')})`);
      }
    }
  }

  return errors;
}

export interface PackageJson {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
  files?: string[];
}

export function isPackageJson(value: unknown): value is PackageJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** The name a package's server is run by: its name without the scope, plus `-mcp`. */
export const unscoped = (name: string | undefined) => (name ?? '').replace(/^@[^/]+\//, '');

export const binName = (pkg: PackageJson) => `${unscoped(pkg.name) || 'components'}-mcp`;

/** The `bin` name that runs a file of the package, when one does. A string `bin` is named after the package. */
function binFor(pkg: PackageJson, file: string): string | undefined {
  if (typeof pkg.bin === 'string') return normalize(pkg.bin) === file ? unscoped(pkg.name) : undefined;

  return Object.entries(pkg.bin ?? {}).find(([, path]) => normalize(path) === file)?.[0];
}

/** The name the server is run by: the `bin` that points at it, or the one `init` would add. `outDir` is relative to the package. */
export const serverBin = (pkg: PackageJson, outDir: string) => binFor(pkg, `${normalize(outDir)}/server.mjs`) ?? binName(pkg);

/** The name the install script is run by: the `bin` that points at it, or the server's with `-install`. */
export const installBin = (pkg: PackageJson, outDir: string) => binFor(pkg, `${normalize(outDir)}/install.mjs`) ?? `${serverBin(pkg, outDir)}-install`;

export interface PackageCheck {
  /** What's missing, each with the line to add. Empty when the package is wired. */
  problems: string[];
  /** The wired package.json. */
  fixed: PackageJson;
}

/** Whether package.json runs the server and its install script (`bin`) and publishes them (`files`). `outDir` is relative to the package. */
export function checkPackageJson(pkg: PackageJson, outDir: string): PackageCheck {
  const dir = normalize(outDir);
  const problems: string[] = [];
  const fixed: PackageJson = { ...pkg };
  const scripts = [
    { what: 'the server', file: `${dir}/server.mjs`, name: serverBin(pkg, dir) },
    { what: 'the install script', file: `${dir}/install.mjs`, name: installBin(pkg, dir) },
  ];

  for (const { what, file, name } of scripts) {
    if (binFor(pkg, file) !== undefined) continue;
    problems.push(`"bin" doesn't run ${what}. Add: "bin": { "${name}": "${file}" }`);
    // A string `bin` is named after the package; keep it under that name beside the new one.
    fixed.bin = { ...(typeof fixed.bin === 'string' ? { [unscoped(pkg.name)]: fixed.bin } : fixed.bin), [name]: file };
  }

  // Without "files", npm publishes everything.
  if (pkg.files && !pkg.files.some((entry) => [dir, `${dir}/**`, `${dir}/*`].includes(normalize(entry)))) {
    problems.push(`"files" doesn't publish ${dir}/. Add "${dir}/" to it.`);
    fixed.files = [...pkg.files, `${dir}/`];
  }

  return { problems, fixed };
}

export type { FrameworkName };

// Bundles the server every library ships (mcp/server.mjs) into one ESM file: the runtime, the
// MCP SDK, zod and parse5. It holds no library data, so it changes only with this package's
// version. Unminified, in esbuild's stable module order, so a version bump reads as a diff.
//
// The file is redistributed inside other people's packages, so the notices of everything in it
// go in its header: the packages esbuild bundled (read from node_modules), and the ones the SDK
// had already bundled into its own dist (PREBUNDLED, checked against the SDK's source maps).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Licenses a bundled package may carry. */
export const ALLOWED_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'];

/** Packages the MCP SDK ships inside its own dist files. Their LICENSE files aren't installed, so the notices are kept here. */
const PREBUNDLED = {
  ajv: { license: 'MIT', notice: 'Copyright (c) 2015-2021 Evgeny Poberezkin' },
  'ajv-formats': { license: 'MIT', notice: 'Copyright (c) 2020 Evgeny Poberezkin' },
  'fast-deep-equal': { license: 'MIT', notice: 'Copyright (c) 2017 Evgeny Poberezkin' },
  'json-schema-traverse': { license: 'MIT', notice: 'Copyright (c) 2017 Evgeny Poberezkin' },
  'fast-uri': { license: 'BSD-3-Clause', notice: 'Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae; Copyright (c) 2021-present The Fastify team. All rights reserved.' },
  'content-type': { license: 'MIT', notice: 'Copyright (c) 2015 Douglas Christopher Wilson' },
  '@cfworker/json-schema': { license: 'MIT', notice: 'Copyright (c) 2020 Jeremy Danyow' },
};

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const BSD3 = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

const TEXTS = { MIT, 'BSD-3-Clause': BSD3 };

/** The package directory a bundled file belongs to. */
function packageDir(input) {
  const at = input.lastIndexOf('node_modules/');

  if (at === -1) return undefined;
  const rest = input.slice(at + 'node_modules/'.length).split('/');

  return join(ROOT, input.slice(0, at), 'node_modules', ...(rest[0].startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1)));
}

/** The packages a prebuilt file was itself bundled from, by its source map. */
function prebundledIn(file) {
  if (!existsSync(`${file}.map`)) return [];
  const sources = JSON.parse(readFileSync(`${file}.map`, 'utf8')).sources ?? [];

  return sources.flatMap((source) => {
    const at = source.lastIndexOf('node_modules/');

    if (at === -1) return [];
    const rest = source.slice(at + 'node_modules/'.length).split('/');

    return [rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]];
  });
}

const comment = (text) =>
  text
    .split('\n')
    .map((line) => `// ${line}`.trimEnd())
    .join('\n');

/** Bundles runtime/server.ts. Returns the code (with its header) and what it holds. */
export async function bundleServer() {
  const own = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['runtime/server.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    write: false,
    metafile: true,
    legalComments: 'none',
    logLevel: 'warning',
    define: { __SERVER_VERSION__: JSON.stringify(own.version) },
  });

  const [output] = Object.values(result.metafile.outputs);
  const packages = new Map();
  const prebundled = new Set();

  for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
    const dir = bytesInOutput > 0 ? packageDir(input) : undefined;

    if (!dir) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const licenseFile = readdirSync(dir).find((name) => /^licen[sc]e(\.md|\.txt)?$/i.test(name));

    packages.set(pkg.name, { name: pkg.name, version: pkg.version, license: pkg.license, text: licenseFile ? readFileSync(join(dir, licenseFile), 'utf8').trim() : undefined });

    for (const name of prebundledIn(join(ROOT, input))) prebundled.add(name);
  }

  // A package the SDK bundled is not one we installed: its notice comes from the table.
  for (const name of packages.keys()) prebundled.delete(name);
  const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
  const inner = [...prebundled].sort().map((name) => ({ name, ...PREBUNDLED[name], known: name in PREBUNDLED }));

  const header = [
    `stencil-mcp-output-target server v${own.version}`,
    '',
    'Generated: copied byte for byte into every library built with this version of the output',
    'target. Do not edit. It reads index.json beside it and nothing else.',
    '',
    `Copyright (c) 2026 William M. Riley. MIT License (https://github.com/splitinfinities/stencil-mcp-output-target).`,
    '',
    'This file bundles the following third-party software.',
    '',
    ...sorted.map((pkg) => `  ${pkg.name} ${pkg.version} (${pkg.license})`),
    ...inner.map((pkg) => `  ${pkg.name} (${pkg.license}), inside @modelcontextprotocol/server. ${pkg.notice}`),
    '',
    ...sorted.flatMap((pkg) => ['-'.repeat(78), `${pkg.name} ${pkg.version}`, '', pkg.text ?? `(${pkg.license}; the package ships no license file)`, '']),
    ...Object.entries(TEXTS).flatMap(([license, text]) => (inner.some((pkg) => pkg.license === license) ? ['-'.repeat(78), `${license}, for ${inner.filter((pkg) => pkg.license === license).map((pkg) => pkg.name).join(', ')} (copyright lines above)`, '', text, ''] : [])),
    '-'.repeat(78),
  ].join('\n');

  const code = `#!/usr/bin/env node\n${comment(header)}\n\n${new TextDecoder().decode(result.outputFiles[0].contents)}`;

  return { code, packages: sorted, prebundled: inner };
}

/** Every bundled package whose license isn't allowed, or whose notice isn't known. */
export function licenseProblems({ packages, prebundled }) {
  return [
    ...packages.flatMap((pkg) => (ALLOWED_LICENSES.includes(pkg.license) ? [] : [`${pkg.name} ${pkg.version}: license ${pkg.license ?? 'unknown'} is not allowed (${ALLOWED_LICENSES.join(', ')})`])),
    ...packages.flatMap((pkg) => (pkg.text ? [] : [`${pkg.name} ${pkg.version}: ships no license file to put in the bundle's header`])),
    ...prebundled.flatMap((pkg) => (pkg.known ? (ALLOWED_LICENSES.includes(pkg.license) ? [] : [`${pkg.name}: license ${pkg.license} is not allowed`]) : [`${pkg.name}: the SDK now bundles it; add its notice to PREBUNDLED in scripts/bundle.mjs`])),
  ];
}

// Builds what the package ships (dist/): the output target as ESM and as CommonJS (Stencil's
// config loader requires it), the CLI, the type declarations, and the bundled server and the install
// script every library gets a copy of.
//   node scripts/build.mjs
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { bundleServer, licenseProblems, ROOT } from './bundle.mjs';

const shared = { absWorkingDir: ROOT, bundle: true, platform: 'node', target: 'node22', packages: 'external', logLevel: 'warning' };

rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
mkdirSync(join(ROOT, 'dist'));

await build({ ...shared, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/index.js' });

// CommonJS has no import.meta.url, which the target uses to find server.mjs.
await build({
  ...shared,
  entryPoints: ['src/index.ts'],
  format: 'cjs',
  outfile: 'dist/index.cjs',
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
});

await build({ ...shared, entryPoints: ['src/cli.ts'], format: 'esm', outfile: 'dist/cli.js', banner: { js: '#!/usr/bin/env node' } });
chmodSync(join(ROOT, 'dist/cli.js'), 0o755);

const server = await bundleServer();
const problems = licenseProblems(server);

if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}

writeFileSync(join(ROOT, 'dist/server.mjs'), server.code);
chmodSync(join(ROOT, 'dist/server.mjs'), 0o755);

// The install script every library gets beside its server: plain JavaScript, copied as it is.
// The target fills in the one line that names the library.
copyFileSync(join(ROOT, 'runtime/install.mjs'), join(ROOT, 'dist/install.mjs'));
chmodSync(join(ROOT, 'dist/install.mjs'), 0o755);

execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'inherit' });

// The sources import each other with .ts extensions (Node runs them as they are); a declaration
// file names its neighbours as .js, which resolves to their .d.ts for every consumer.
const declarations = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? declarations(join(dir, entry.name)) : [join(dir, entry.name)]));

for (const path of declarations(join(ROOT, 'dist/types'))) {
  writeFileSync(path, readFileSync(path, 'utf8').replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2'));
}

console.log(`dist/server.mjs: ${(statSync(join(ROOT, 'dist/server.mjs')).size / 1024).toFixed(0)} KiB, bundling ${server.packages.map((pkg) => pkg.name).join(', ')}`);

// Fails when server.mjs would bundle a package whose license isn't allowed, or whose notice
// can't go in its header. The bundle is redistributed in every library that uses the output
// target, and a library's own dependency checks don't see inside a committed file.
//   node scripts/check-licenses.mjs
import { bundleServer, licenseProblems } from './bundle.mjs';

const bundle = await bundleServer();
const problems = licenseProblems(bundle);

for (const pkg of bundle.packages) console.log(`${pkg.name} ${pkg.version}: ${pkg.license}`);

for (const pkg of bundle.prebundled) console.log(`${pkg.name} (inside the SDK): ${pkg.license ?? 'unknown'}`);

for (const problem of problems) console.error(`error: ${problem}`);

process.exitCode = problems.length > 0 ? 1 : 0;

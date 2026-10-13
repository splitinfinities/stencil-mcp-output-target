import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { checkIndex, createServer, SERVER_VERSION, type Log } from './create.ts';
import { HTTP_HOST, HTTP_PATH, serveHttp } from './http.ts';

// The server a library ships as mcp/server.mjs. It reads index.json beside it and nothing else:
// it takes no path arguments, opens no other file and makes no network request.

export { createServer, checkIndex, SERVER_VERSION } from './create.ts';

export { serveHttp } from './http.ts';

/** index.json beside this file. Throws when it is missing or from another schema version. */
export function loadIndex() {
  const path = fileURLToPath(new URL('./index.json', import.meta.url));
  let json: string;

  try {
    json = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${path} is missing: build the library (a production build writes it beside server.mjs).`);
  }

  return checkIndex(JSON.parse(json));
}

const USAGE = `A read-only MCP server for this component library (stencil-mcp-output-target ${SERVER_VERSION}).

  server.mjs                 serve over stdio
  server.mjs --http <port>   serve streamable HTTP on http://${HTTP_HOST}:<port>${HTTP_PATH}
  server.mjs --version
  server.mjs --help`;

const log: Log = (line) => process.stderr.write(`[mcp] ${line}\n`);

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);

    return;
  }

  if (argv.includes('--version')) {
    console.log(SERVER_VERSION);

    return;
  }

  const unknown = argv.find((arg, i) => arg !== '--http' && argv[i - 1] !== '--http');

  if (unknown) throw new Error(`Unknown argument ${unknown}.\n\n${USAGE}`);
  const index = loadIndex();

  if (argv.includes('--http')) {
    const port = Number(argv[argv.indexOf('--http') + 1]);

    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--http takes a port.\n\n${USAGE}`);
    const server = await serveHttp(() => createServer(index, log), port, log);
    const address = server.address();

    log(`${index.library.name}: listening on http://${HTTP_HOST}:${typeof address === 'object' && address ? address.port : port}${HTTP_PATH}`);

    return;
  }

  serveStdio(() => createServer(index, log), { onerror: (error) => log(`error: ${error.message}`) });
  log(`${index.library.name}: ${index.components.length} components, serving over stdio`);
}

/** True when this file is what `node` was asked to run (through a bin symlink too), not imported. */
function isMain(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

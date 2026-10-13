import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins, originValidationResponse, type McpServer } from '@modelcontextprotocol/server';
import type { Log } from './create.ts';

// Streamable HTTP on the loopback interface only. There is no host option: a server that
// answers on a public interface would hand the library's index to anyone who can reach it, and
// a browser page could drive it. Every request's Host and Origin are checked, against DNS
// rebinding (a page on evil.example that resolves to 127.0.0.1).

export const HTTP_HOST = '127.0.0.1';

export const HTTP_PATH = '/mcp';

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    for (const item of [value ?? []].flat()) headers.append(name, item);
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers };

  if (hasBody) {
    // INVARIANT: Readable.toWeb returns a web ReadableStream of the request's bytes, which is what a Request body takes.
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }

  return new Request(`http://${req.headers.host ?? HTTP_HOST}${req.url ?? '/'}`, init);
}

async function send(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));

  if (!response.body) {
    res.end();

    return;
  }

  const reader = response.body.getReader();

  res.on('close', () => void reader.cancel().catch(() => {}));

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    res.write(value);
  }

  res.end();
}

const plain = (status: number, message: string) => new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json' } });

/** Listens on 127.0.0.1:`port` (0 picks a free one). Resolves once it is listening. */
export function serveHttp(factory: () => McpServer, port: number, log: Log): Promise<Server> {
  const handler = createMcpHandler(factory, { onerror: (error) => log(`http error: ${error.message}`) });

  const server = createHttpServer((req, res) => {
    const start = performance.now();

    const answer = async (): Promise<Response> => {
      const request = toRequest(req);
      const rejected = hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins());

      if (rejected) return rejected;

      if (new URL(request.url).pathname !== HTTP_PATH) return plain(404, `The MCP endpoint is ${HTTP_PATH}.`);

      return handler.fetch(request);
    };

    answer()
      .catch((error: Error) => plain(500, error.message))
      .then((response) => {
        log(`http ${req.method} ${req.url} ${response.status} ${Math.round(performance.now() - start)}ms${req.headers.origin ? ` origin=${req.headers.origin}` : ''}`);

        return send(response, res);
      })
      .catch(() => res.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HTTP_HOST, () => resolve(server));
  });
}

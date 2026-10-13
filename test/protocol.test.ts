// The written server as a process: once over stdio, once over streamable HTTP.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { serverPath } from './helpers.ts';

test('stdio: initialize, list, call, read; requests are logged to stderr, never stdout', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath()], stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '0.0.0' });
  let stderr = '';

  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  await client.connect(transport);

  assert.deepEqual(client.getServerVersion(), { name: 'components', version: '1.2.0' });
  assert.equal((await client.listTools()).tools.length, 15);

  const result = await client.callTool({ name: 'get_component_api', arguments: { tag: 'my-icon' } });

  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].type === 'text' ? result.content[0].text : ''), result.structuredContent);
  const [page] = (await client.readResource({ uri: 'component://my-icon' })).contents;

  assert.match('text' in page ? page.text : '', /^# <my-icon>/);

  await client.close();
  assert.match(stderr, /^\[mcp\] components: 8 components, serving over stdio$/m);
  assert.match(stderr, /^\[mcp\] tools\/call get_component_api \d+ms$/m);
  assert.match(stderr, /^\[mcp\] resources\/read component:\/\/my-icon \d+ms$/m);
});

/** Starts `server.mjs --http 0` and resolves with the port it chose. */
function serveHttp(): Promise<{ child: ChildProcess; port: number; stderr: () => string }> {
  const child = spawn(process.execPath, [serverPath(), '--http', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';

  return new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const port = stderr.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/)?.[1];

      if (port) resolve({ child, port: Number(port), stderr: () => stderr });
    });
    child.once('exit', (code) => reject(new Error(`server.mjs --http exited with ${code}: ${stderr}`)));
  });
}

/** A raw request, so the test can send headers `fetch` forbids (Host). */
function raw(port: number, headers: Record<string, string>, path = '/mcp'): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });

  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      let text = '';

      res.on('data', (chunk: Buffer) => {
        text += chunk.toString();
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });

    req.on('error', reject);
    req.end(body);
  });
}

test('http: streamable HTTP on 127.0.0.1; a foreign Origin or Host is refused', async () => {
  const { child, port, stderr } = await serveHttp();

  try {
    const client = new Client({ name: 'test', version: '0.0.0' });

    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    assert.deepEqual(client.getServerVersion(), { name: 'components', version: '1.2.0' });
    assert.equal((await client.listTools()).tools.length, 15);

    const result = await client.callTool({ name: 'validate_component_usage', arguments: { code: '<my-icon></my-icon>' } });

    assert.match(JSON.stringify(result.structuredContent), /"valid":false/);
    await client.close();

    // A page on another site, however it reached the port.
    const foreign = await raw(port, { origin: 'https://evil.example' });

    assert.equal(foreign.status, 403);
    assert.doesNotMatch(foreign.body, /serverInfo/);

    // DNS rebinding: the browser thinks it is talking to evil.example.
    const rebound = await raw(port, { host: 'evil.example' });

    assert.equal(rebound.status, 403);
    assert.doesNotMatch(rebound.body, /serverInfo/);

    // A local page, and a client that sends no Origin, are served.
    assert.equal((await raw(port, { origin: `http://localhost:${port}` })).status, 200);
    assert.equal((await raw(port, {})).status, 200);
    assert.equal((await raw(port, {}, '/other')).status, 404);

    assert.match(stderr(), /^\[mcp\] http POST \/mcp 403 \d+ms origin=https:\/\/evil\.example$/m);
    assert.match(stderr(), /^\[mcp\] http POST \/mcp 200 \d+ms$/m);
  } finally {
    child.kill();
  }
});

test('http: it listens on the loopback interface only', async () => {
  const { child, port } = await serveHttp();

  try {
    const { networkInterfaces } = await import('node:os');
    const external = Object.values(networkInterfaces()).flatMap((list) => list ?? []).find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;

    if (external) {
      await assert.rejects(
        new Promise((resolve, reject) => {
          const req = request({ host: external, port, path: '/mcp', method: 'POST', timeout: 1500 }, resolve);

          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('timeout')));
          req.end('{}');
        }),
      );
    }
  } finally {
    child.kill();
  }
});

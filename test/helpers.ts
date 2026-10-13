// The tests drive the server a library ships: fixture/mcp/server.mjs, written by a real Stencil
// build of the fixture (`pnpm build.fixture`), through the SDK's client.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpIndex } from '../src/types.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const FIXTURE = join(ROOT, 'fixture');

/** The fixture built with every option (`mcp`) or with none (`mcp-zero`). */
export type Build = 'mcp' | 'mcp-zero';

export function serverPath(build: Build = 'mcp'): string {
  const path = join(FIXTURE, build, 'server.mjs');

  if (!existsSync(path)) throw new Error(`${path} is missing: run \`pnpm build.fixture\` first.`);

  return path;
}

export function readIndex(build: Build = 'mcp'): McpIndex {
  return JSON.parse(readFileSync(join(FIXTURE, build, 'index.json'), 'utf8'));
}

interface ServerModule {
  createServer(index: McpIndex, log?: (line: string) => void): { connect(transport: InMemoryTransport): Promise<void>; close(): Promise<void> };
  loadIndex(): McpIndex;
  SERVER_VERSION: string;
}

export async function serverModule(build: Build = 'mcp'): Promise<ServerModule> {
  return import(pathToFileURL(serverPath(build)).href);
}

export interface Session {
  client: Client;
  /** One line per request the server logged. */
  log: string[];
  /** A text resource. */
  read(uri: string): Promise<{ mimeType?: string; text: string }>;
  /** A tool's structured result. */
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
  close(): Promise<void>;
}

/** A client connected in process to the written server. `index` replaces the one beside it. */
export async function connect(build: Build = 'mcp', index?: McpIndex): Promise<Session> {
  const module = await serverModule(build);
  const log: string[] = [];
  const server = module.createServer(index ?? module.loadIndex(), (line) => log.push(line));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });

  await server.connect(serverSide);
  await client.connect(clientSide);

  return {
    client,
    log,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });

      if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);

      return result.structuredContent as Record<string, any>;
    },
    async read(uri) {
      const [content] = (await client.readResource({ uri })).contents;

      return { mimeType: content.mimeType, text: 'text' in content ? content.text : '' };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

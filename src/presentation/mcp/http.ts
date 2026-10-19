import crypto from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface HttpOptions {
  port: number;
  /** Only loopback addresses are accepted: the server controls a physical device. */
  host: '127.0.0.1' | '::1' | 'localhost';
  token: string;
  createServer: () => McpServer;
  log?: (line: string) => void;
}

const MAX_BODY = 4 * 1024 * 1024;

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(/^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function reject(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Streamable HTTP transport, stateless: each POST gets a fresh server and
 * transport. Security follows the MCP spec: loopback bind, Host and Origin
 * validation against DNS rebinding, and a bearer token on every request.
 */
export function startHttpServer(options: HttpOptions): Promise<http.Server> {
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`, `[::1]:${options.port}`]);
  const allowedOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

  const server = http.createServer(async (req, res) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') return reject(res, 404, 'Not found; the endpoint is /mcp');
    if (!allowedHosts.has(req.headers.host ?? '')) return reject(res, 403, 'Host not allowed');
    if (req.headers.origin && !allowedOrigin.test(req.headers.origin)) return reject(res, 403, 'Origin not allowed');
    if (!tokenMatches(req.headers.authorization, options.token)) return reject(res, 401, 'Missing or invalid bearer token');
    if (req.method !== 'POST') return reject(res, 405, 'Stateless server: only POST is supported');

    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return reject(res, 413, 'Request body too large');
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(res, 400, 'Body must be JSON'); }

    const mcp = options.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      options.log?.(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) reject(res, 500, 'Internal error');
    }
  });

  return new Promise((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port, options.host, () => resolve(server));
  });
}

// test/bench/fixture-server.ts — Static fixture server for conformance tests.
// Serves captured fixtures on localhost so BrowserSurface can load them like real sites.
// No mock-console imports. Test-side only.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = resolve(__dirname, '../fixtures');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://localhost`);
  let filePath = join(FIXTURES_DIR, url.pathname);

  // If path points to a directory, serve index.html
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }

  // If no extension, try .html
  if (!extname(filePath) && !existsSync(filePath)) {
    filePath += '.html';
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + url.pathname);
    return;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(content);
}

export interface FixtureServer {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      const actualPort = addr.port;
      resolve({
        port: actualPort,
        baseUrl: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

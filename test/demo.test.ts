// test/demo.test.ts — Demo launcher smoke test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = 3469;
const BASE = `http://localhost:${PORT}`;
let server: ChildProcess;

async function waitForServer(maxMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { await fetch(`${BASE}/t/cascade-cu/login`); return; }
    catch { await new Promise(r => setTimeout(r, 150)); }
  }
  throw new Error('Mock console did not start');
}

beforeAll(async () => {
  server = spawn('node', ['mock-console/server.js'], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe', cwd: process.cwd(),
  });
  await waitForServer();
}, 30000);

afterAll(() => { server?.kill(); });

describe('Demo Launcher', () => {

  it('demo.html exists', () => {
    expect(existsSync(resolve('demo.html'))).toBe(true);
  });

  it('demo.html contains tenant links', () => {
    const html = readFileSync(resolve('demo.html'), 'utf8');
    expect(html).toContain('/t/cascade-cu/login');
    expect(html).toContain('/t/harborview/login');
    expect(html).toContain('ParaBank');
  });

  it('all live tenant hrefs return 200', async () => {
    const html = readFileSync(resolve('demo.html'), 'utf8');
    const hrefs = [...html.matchAll(/href="(http:\/\/localhost:3000\/t\/[^"]+)"/g)].map(m => m[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(2);

    for (const href of hrefs) {
      const url = href.replace('localhost:3000', `localhost:${PORT}`);
      const res = await fetch(url);
      expect(res.status).toBe(200);
    }
  });
});

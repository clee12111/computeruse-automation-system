// test/smoke/tsx-observe.test.ts — Production-loader smoke test.
// Spawns the CLI through tsx (exactly as npm run cli does) and asserts
// observe() works: elements > 0, ≥1 non-empty accessible name, ≥1 options[].
// This closes the "green under vitest, blind under tsx" class permanently.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { startFixtureServer, type FixtureServer } from '../bench/fixture-server.js';

let fixtureServer: FixtureServer;

describe('tsx production-loader smoke test', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
  });
  afterAll(async () => {
    await fixtureServer?.close();
  });

  it('observe() through tsx returns elements with names and options', async () => {
    // Write a temp script, then run it through tsx
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const scriptPath = resolve('test/smoke/_tsx_probe.ts');
    const baseUrl = fixtureServer.baseUrl;
    writeFileSync(scriptPath, `
import { BrowserSurface } from '../../src/surface/browser-surface.js';
const surface = new BrowserSurface({
  baseUrl: '${baseUrl}', tenantPrefix: '', headed: false,
  policy: { allowedOrigins: ['${baseUrl}'], allowedRoutes: ['/*'], allowedVerbs: ['click','type','select','read','navigate'] },
});
await surface.launch();
await surface.navigate('/parabank/bill-pay/');
await new Promise(r => setTimeout(r, 1500));
const obs = await surface.observe();
const r = {
  elementCount: obs.elements.length,
  hasNonEmptyName: obs.elements.some(e => e.name && e.name.trim().length > 0),
  hasOptions: obs.elements.some(e => e.options && e.options.length > 0),
  optionsSample: obs.elements.find(e => e.options && e.options.length > 0)?.options?.slice(0, 3),
  namedSample: obs.elements.filter(e => e.name && e.name.trim().length > 0).slice(0, 3).map(e => e.name.substring(0, 30)),
};
console.log('TSX_RESULT:' + JSON.stringify(r));
await surface.close();
`);

    const result = await new Promise<string>((res, reject) => {
      const child = spawn('npx', ['tsx', scriptPath], {
        cwd: process.cwd(), shell: true,
        env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code) => {
        try { unlinkSync(scriptPath); } catch {}
        if (code !== 0) reject(new Error(`tsx exited ${code}: ${stderr.substring(0, 500)}`));
        else res(stdout);
      });
    });

    // Parse the result
    const line = result.split('\n').find(l => l.startsWith('TSX_RESULT:'));
    expect(line).toBeDefined();
    const data = JSON.parse(line!.replace('TSX_RESULT:', ''));

    console.log('TSX smoke result:', JSON.stringify(data, null, 2));

    expect(data.elementCount).toBeGreaterThan(0);
    expect(data.hasNonEmptyName).toBe(true);
    expect(data.hasOptions).toBe(true);
    expect(data.optionsSample.length).toBeGreaterThan(0);
  });
});

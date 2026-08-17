// test/console-ui.test.ts — Console UI tests: ASK, SITES, RUNS, approve/revoke.

import './helpers/trust-sandbox.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { saveTrust, loadTrust, approveCapability, trustKey } from '../src/guardrails/trust.js';

const PORT = 4100 + Math.floor(Math.random() * 900); // random port to avoid parallel conflicts
let server: ChildProcess;

async function waitFor(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Console did not start');
}

describe('Console UI', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    // Ensure port is free before spawning
    try { const r = await fetch(`http://localhost:${PORT}/`); } catch { /* expected — port is free */ }
    server = spawn('npx', ['tsx', 'src/console-ui/server.ts'], {
      cwd: process.cwd(), shell: true,
      env: { ...process.env, CONSOLE_UI_PORT: String(PORT), CONSOLE_USER: 'operator', CONSOLE_PASS: 'demo123' },
      stdio: 'pipe',
    });
    await waitFor();
  });

  afterAll(() => { server?.kill(); saveTrust({}); });
  beforeEach(() => { saveTrust({}); });

  it('ASK page renders with search box', async () => {
    const res = await fetch(`http://localhost:${PORT}/`);
    expect(res.ok).toBe(true);
    const html = await res.text();
    expect(html).toContain('What do you need');
    expect(html).toContain('ask-input');
  });

  it('ASK with query matches a capability', async () => {
    approveCapability('lookup-dense-savings', '1.1.0', 'test');
    const res = await fetch(`http://localhost:${PORT}/?q=savings+balance+member+60020`);
    const html = await res.text();
    expect(html).toContain('lookup-dense-savings');
    expect(html).toContain('interpreting');
    expect(html).toContain('no AI');
    saveTrust({});
  });

  it('SITES page renders site cards', async () => {
    const res = await fetch(`http://localhost:${PORT}/sites`);
    const html = await res.text();
    expect(html).toContain('What we automate');
  });

  it('approve writes who/when; revoke removes', async () => {
    // Approve without note
    const r1 = await fetch(`http://localhost:${PORT}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=lookup-dense-savings&version=1.1.0', redirect: 'manual',
    });
    expect(r1.status).toBe(302);
    let trust = loadTrust();
    const key = trustKey('lookup-dense-savings', '1.1.0');
    expect(trust[key]?.status).toBe('approved');
    expect(trust[key]?.approvedBy).toBeDefined();

    // Revoke
    const r2 = await fetch(`http://localhost:${PORT}/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=lookup-dense-savings&version=1.1.0', redirect: 'manual',
    });
    expect(r2.status).toBe(302);
    trust = loadTrust();
    expect(trust[key]).toBeUndefined();
  });

  it('RUNS page renders', async () => {
    const res = await fetch(`http://localhost:${PORT}/runs`);
    const html = await res.text();
    expect(html).toContain('What happened');
  });

  it('TOOL page renders from artifact file', async () => {
    const res = await fetch(`http://localhost:${PORT}/tool/lookup-dense-savings.v1.json`);
    expect(res.ok).toBe(true);
    const html = await res.text();
    expect(html).toContain('lookup-dense-savings');
    expect(html).toContain('The script');
  });
});

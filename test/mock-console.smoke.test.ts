// Smoke tests for the mock console — HTTP only, no imports from mock-console/.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';

const PORT = 3456;
const BASE = `http://localhost:${PORT}/t/cascade-cu`;
let server: ChildProcess;

async function waitForServer(maxMs = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await fetch(`${BASE}/login`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error('Mock console did not start in time');
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'f1=operator&f2=demo123',
    redirect: 'manual',
  });
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(';')[0]; // "sid=<token>"
}

async function authedGet(path: string, cookie: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: { cookie },
    redirect: 'manual',
  });
}

beforeAll(async () => {
  server = spawn('node', ['mock-console/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
    cwd: process.cwd(),
  });
  await waitForServer();
});

afterAll(() => {
  server?.kill();
});

describe('mock-console smoke', () => {
  it('login page is up', async () => {
    const res = await fetch(`${BASE}/login`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Sign In');
  });

  it('bad credentials rejected', async () => {
    const res = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'f1=operator&f2=wrong',
      redirect: 'manual',
    });
    // Should re-render login page with error, not redirect
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Invalid credentials');
  });

  it('unauthenticated request redirects to login', async () => {
    const res = await fetch(`${BASE}/search`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('search finds member 12345', async () => {
    const cookie = await login();
    // POST search
    const searchRes = await fetch(`${BASE}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: 'f1=12345',
      redirect: 'manual',
    });
    expect(searchRes.status).toBe(302);
    const loc = searchRes.headers.get('location')!;
    // Follow redirect to member detail
    const detailRes = await fetch(`http://localhost:${PORT}${loc}`, {
      headers: { cookie },
    });
    const body = await detailRes.text();
    expect(body).toContain('Member Details');
    expect(body).toContain('Jane Thompson');
  });

  it('member detail page contains accounts iframe', async () => {
    const cookie = await login();
    const res = await authedGet('/member?q=12345', cookie);
    const body = await res.text();
    expect(body).toContain('<iframe');
    expect(body).toContain('/accounts');
  });

  it('accounts iframe content has the table', async () => {
    const cookie = await login();
    const res = await authedGet('/member/12345/accounts', cookie);
    const body = await res.text();
    expect(body).toContain('$4,320.10');
    expect(body).toContain('Savings');
  });

  it('search for 99999 yields "No member matches"', async () => {
    const cookie = await login();
    const res = await authedGet('/member?q=99999', cookie);
    const body = await res.text();
    expect(body).toContain('No member matches');
  });

  it('open sub-account flow reaches confirmation', async () => {
    const cookie = await login();
    // GET the form
    const formRes = await authedGet('/member/12345/open-sub-account', cookie);
    expect(formRes.status).toBe(200);
    const formBody = await formRes.text();
    expect(formBody).toContain('Open Account');

    // POST the form
    const postRes = await fetch(`${BASE}/member/12345/open-sub-account`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: 'f1=holiday-club',
      redirect: 'manual',
    });
    expect(postRes.status).toBe(302);
    const loc = postRes.headers.get('location')!;

    // Follow redirect to confirmation
    const confirmRes = await fetch(`http://localhost:${PORT}${loc}`, {
      headers: { cookie },
    });
    const confirmBody = await confirmRes.text();
    expect(confirmBody).toContain('Account Opened');
    expect(confirmBody).toContain('Holiday Club');
  });
});

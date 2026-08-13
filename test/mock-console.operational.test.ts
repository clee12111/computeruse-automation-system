// Operational tests for Phase 1.5 — HTTP only, no imports from mock-console/.
// Tests real state mutation, session mechanics, roles, compliance, fault injection.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';

const PORT = 3457;
const BASE = `http://localhost:${PORT}/t/cascade-cu`;
let server: ChildProcess;

async function waitForServer(maxMs = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { await fetch(`${BASE}/login`); return; }
    catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error('Mock console did not start in time');
}

async function loginAs(user: string, pass: string): Promise<string> {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `f1=${user}&f2=${pass}`,
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

function login(): Promise<string> { return loginAs('operator', 'demo123'); }

async function get(path: string, cookie: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers: { cookie }, redirect: 'manual' });
}

async function post(path: string, cookie: string, body: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body,
    redirect: 'manual',
  });
}

async function followRedirect(res: Response, cookie: string): Promise<Response> {
  const loc = res.headers.get('location')!;
  const url = loc.startsWith('http') ? loc : `http://localhost:${PORT}${loc}`;
  return fetch(url, { headers: { cookie } });
}

beforeAll(async () => {
  server = spawn('node', ['mock-console/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
    cwd: process.cwd(),
  });
  await waitForServer();
});

afterAll(() => { server?.kill(); });

describe('Phase 1.5 operational', () => {

  it('dashboard renders after login', async () => {
    const cookie = await login();
    const res = await get('/dashboard', cookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Dashboard');
    expect(body).toContain('Welcome');
    // Nav sidebar present
    expect(body).toContain('Member Search');
    expect(body).toContain('Reports');
  });

  it('transactions page renders for member 12345', async () => {
    const cookie = await login();
    const res = await get('/member/12345/account/12345-S1/transactions', cookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Transaction History');
    expect(body).toContain('Opening Deposit');
    expect(body).toContain('Payroll Direct Deposit');
    // Structurally different table (dotted borders, dark header)
    expect(body).toContain('dotted');
  });

  it('transfer happy path: confirmation + exact balance change + ledger rows', async () => {
    const cookie = await login();

    // Verify initial balances via accounts iframe
    const before = await get('/member/12345/accounts', cookie);
    const beforeBody = await before.text();
    expect(beforeBody).toContain('$4,320.10'); // Savings
    expect(beforeBody).toContain('$1,205.63'); // Checking

    // POST transfer form: Savings → Checking, $100.00
    const formRes = await post('/member/12345/transfer', cookie,
      'f1=12345-S1&f2=12345-C1&f3=100.00');
    expect(formRes.status).toBe(302);

    // Follow redirect to review page
    const reviewRes = await followRedirect(formRes, cookie);
    const reviewBody = await reviewRes.text();
    expect(reviewBody).toContain('Review Transfer');
    expect(reviewBody).toContain('Execute Transfer');
    expect(reviewBody).toContain('$100.00');

    // POST review to execute
    const execRes = await post('/member/12345/transfer/review', cookie,
      'f1=12345-S1&f2=12345-C1&f3=100');
    expect(execRes.status).toBe(302);

    // Follow redirect to confirmation
    const confirmRes = await followRedirect(execRes, cookie);
    const confirmBody = await confirmRes.text();
    expect(confirmBody).toContain('Transfer Complete');
    expect(confirmBody).toContain('REF-');

    // Verify balances changed by exact amounts
    const after = await get('/member/12345/accounts', cookie);
    const afterBody = await after.text();
    expect(afterBody).toContain('$4,220.10'); // Savings: 4320.10 - 100
    expect(afterBody).toContain('$1,305.63'); // Checking: 1205.63 + 100

    // Verify ledger rows appended to both accounts
    const savingsTx = await get('/member/12345/account/12345-S1/transactions', cookie);
    expect(await savingsTx.text()).toContain('Transfer to Checking (12345-C1)');

    const checkingTx = await get('/member/12345/account/12345-C1/transactions', cookie);
    expect(await checkingTx.text()).toContain('Transfer from Savings (12345-S1)');
  });

  it('overdraft rejected with error text', async () => {
    const cookie = await login();
    // Try to transfer more than available (Savings balance is now $4,220.10 after prior test)
    const res = await post('/member/12345/transfer', cookie,
      'f1=12345-S1&f2=12345-C1&f3=999999.00');
    expect(res.status).toBe(200); // Re-renders form, not redirect
    const body = await res.text();
    expect(body).toContain('Insufficient funds');
  });

  it('sub-account persists on member detail', async () => {
    const cookie = await login();

    // Open a sub-account
    const openRes = await post('/member/45678/open-sub-account', cookie, 'f1=holiday-club');
    expect(openRes.status).toBe(302);

    // Check it appears in the accounts iframe
    const accts = await get('/member/45678/accounts', cookie);
    const body = await accts.text();
    expect(body).toContain('Holiday Club');
    expect(body).toContain('45678-N'); // new account number pattern
  });

  it('session expiry redirects to login (fault-forced)', async () => {
    const cookie = await login();
    const res = await get('/search?fault=session_expired', cookie);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/login');
    expect(loc).toContain('expired=1');

    // Follow redirect — login page shows expiry message
    const loginRes = await followRedirect(res, cookie);
    const body = await loginRes.text();
    expect(body).toContain('session has expired');
  });

  it('session warning interstitial appears and Continue proceeds', async () => {
    const cookie = await login();

    // Force session warning
    const warnRes = await get('/search?fault=session_warning', cookie);
    expect(warnRes.status).toBe(200);
    const body = await warnRes.text();
    expect(body).toContain('session is about to expire');
    expect(body).toContain('Continue');

    // POST to extend session
    const extendRes = await post('/session-extend', cookie,
      `returnTo=/t/cascade-cu/search`);
    expect(extendRes.status).toBe(302);

    // Follow redirect — normal search page
    const searchRes = await followRedirect(extendRes, cookie);
    const searchBody = await searchRes.text();
    expect(searchBody).toContain('Member Search');
  });

  it('operator blocked on restricted member, supervisor passes', async () => {
    const opCookie = await login();
    const supCookie = await loginAs('supervisor', 'demo456');

    // Operator: acknowledge compliance first for member 78901
    await post('/member/78901/compliance', opCookie,
      `ack=1&returnTo=/t/cascade-cu/member?q=78901`);

    // Operator blocked on transfer
    const opTransfer = await get('/member/78901/transfer', opCookie);
    const opBody = await opTransfer.text();
    expect(opBody).toContain('Insufficient privileges');
    expect(opBody).toContain('supervisor approval required');

    // Operator blocked on open-sub-account
    const opSub = await get('/member/78901/open-sub-account', opCookie);
    expect(await opSub.text()).toContain('Insufficient privileges');

    // Supervisor: acknowledge compliance for 78901
    await post('/member/78901/compliance', supCookie,
      `ack=1&returnTo=/t/cascade-cu/member?q=78901`);

    // Supervisor passes through to transfer form
    const supTransfer = await get('/member/78901/transfer', supCookie);
    const supBody = await supTransfer.text();
    expect(supBody).toContain('Transfer Funds');
    expect(supBody).not.toContain('Insufficient privileges');
  });

  it('compliance interstitial appears once then not again', async () => {
    const cookie = await login();

    // First access to flagged member 23456 → compliance interstitial
    const first = await get('/member?q=23456', cookie);
    const firstBody = await first.text();
    expect(firstBody).toContain('Compliance Notice');
    expect(firstBody).toContain('Address verification pending');

    // Acknowledge it
    const ackRes = await post('/member/23456/compliance', cookie,
      `ack=1&returnTo=/t/cascade-cu/member?q=23456`);
    expect(ackRes.status).toBe(302);

    // Second access → normal member detail, no interstitial
    const second = await get('/member?q=23456', cookie);
    const secondBody = await second.text();
    expect(secondBody).toContain('Member Details');
    expect(secondBody).toContain('Robert Chen');
    expect(secondBody).not.toContain('Compliance Notice');
  });

  it('fault=app_error returns 500', async () => {
    const cookie = await login();
    const res = await get('/dashboard?fault=app_error', cookie);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('Application Error');
  });
});

// Phase 1.7 core module tests — HTTP only, no imports from mock-console/.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';

const PORT = 3459;
const BASE = `http://localhost:${PORT}/t/cascade-cu`;
let server: ChildProcess;

async function waitForServer(maxMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { await fetch(`${BASE}/login`); return; }
    catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error('Mock console did not start in time');
}
async function loginAs(u: string, p: string): Promise<string> {
  const r = await fetch(`${BASE}/login`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `f1=${u}&f2=${p}`, redirect: 'manual' });
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}
function login() { return loginAs('operator', 'demo123'); }
function get(path: string, ck: string) { return fetch(`${BASE}${path}`, { headers: { cookie: ck }, redirect: 'manual' }); }
function post(path: string, ck: string, body: string) {
  return fetch(`${BASE}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ck }, body, redirect: 'manual' });
}
async function follow(r: Response, ck: string) {
  const loc = r.headers.get('location')!;
  return fetch(loc.startsWith('http') ? loc : `http://localhost:${PORT}${loc}`, { headers: { cookie: ck } });
}

beforeAll(async () => {
  server = spawn('node', ['mock-console/server.js'], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe', cwd: process.cwd() });
  await waitForServer();
});
afterAll(() => { server?.kill(); });

describe('Phase 1.7 core', () => {

  it('grouped nav renders all module sections', async () => {
    const ck = await login();
    const r = await get('/dashboard', ck);
    const b = await r.text();
    expect(b).toContain('MEMBER SERVICES');
    expect(b).toContain('TELLER');
    expect(b).toContain('LENDING');
    expect(b).toContain('OPERATIONS');
    // Existing nav items still present
    expect(b).toContain('Member Search');
    expect(b).toContain('Dashboard');
    expect(b).toContain('Reports');
    expect(b).toContain('Settings');
    expect(b).toContain('Audit Log');
  });

  it('quick-jump code routes to correct page', async () => {
    const ck = await login();
    const r = await post('/quick-jump', ck, 'qj=INQ');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('/search');
  });

  it('drawer activation required before teller line', async () => {
    const ck = await login();
    // Teller line without drawer → redirects to drawer
    const r = await get('/teller/line', ck);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('/teller/drawer');
  });

  it('code-word gate blocks wrong word, passes correct', async () => {
    const ck = await login();
    // Activate drawer first
    await post('/teller/drawer', ck, 'f1=500');
    // Wrong code word for member 12345 (correct is 'cascade')
    const wrongR = await post('/teller/line/12345/verify', ck, 'f1=wrongword');
    expect(wrongR.status).toBe(200);
    expect(await wrongR.text()).toContain('Incorrect code word');
    // Correct code word
    const rightR = await post('/teller/line/12345/verify', ck, 'f1=cascade');
    expect(rightR.status).toBe(302); // redirects to post screen
  });

  it('teller deposit mutates balance and audits', async () => {
    const ck = await login();
    await post('/teller/drawer', ck, 'f1=500');
    await post('/teller/line/12345/verify', ck, 'f1=cascade');
    // Deposit $100 cash to savings
    const r = await post('/teller/line/12345/post', ck, 'f1=12345-S1&f2=deposit&f3=100&f4=cash');
    expect(r.status).toBe(302);
    const receipt = await follow(r, ck);
    const b = await receipt.text();
    expect(b).toContain('Receipt');
    expect(b).toContain('Deposit');
    expect(b).toContain('$100.00');
    // Check audit
    const audit = await get('/audit', ck);
    expect(await audit.text()).toContain('TELLER_DEPOSIT');
  });

  it('withdrawal within limit posts without override', async () => {
    const ck = await login();
    await post('/teller/drawer', ck, 'f1=500');
    await post('/teller/line/12345/verify', ck, 'f1=cascade');
    // Withdraw $50 (under $2500 limit)
    const r = await post('/teller/line/12345/post', ck, 'f1=12345-C1&f2=withdrawal&f3=50&f4=cash');
    expect(r.status).toBe(302);
    const receipt = await follow(r, ck);
    expect(await receipt.text()).toContain('Withdrawal');
  });

  it('withdrawal over limit triggers override → wrong creds re-prompt → correct creds post + audit', async () => {
    const ck = await login();
    await post('/teller/drawer', ck, 'f1=500');
    await post('/teller/line/12345/verify', ck, 'f1=cascade');
    // Withdraw $3000 (over $2500 limit) as operator
    const r = await post('/teller/line/12345/post', ck, 'f1=12345-S1&f2=withdrawal&f3=3000&f4=cash');
    expect(r.status).toBe(302);
    // Should redirect to override page
    const overridePage = await follow(r, ck);
    const overrideBody = await overridePage.text();
    expect(overrideBody).toContain('Supervisor Override Required');
    expect(overrideBody).toContain('$3,000.00');

    // Wrong supervisor creds
    const wrongR = await post('/teller/line/12345/override?acct=12345-S1&amount=3000&ft=cash', ck,
      'f1=12345-S1&f2=3000&f3=cash&f4=operator&f5=demo123');
    expect(wrongR.status).toBe(200);
    expect(await wrongR.text()).toContain('Invalid supervisor credentials');

    // Correct supervisor creds
    const rightR = await post('/teller/line/12345/override?acct=12345-S1&amount=3000&ft=cash', ck,
      'f1=12345-S1&f2=3000&f3=cash&f4=supervisor&f5=demo456');
    expect(rightR.status).toBe(302);
    const receipt = await follow(rightR, ck);
    expect(await receipt.text()).toContain('Receipt');
    // Audit should show override
    const audit = await get('/audit', ck);
    expect(await audit.text()).toContain('TELLER_WITHDRAWAL_OVERRIDE');
  });

  it('stop payment appears on share detail', async () => {
    const ck = await login();
    // Member 12345's checking (12345-C1) has a seeded stop payment
    const r = await get('/member/12345/account/12345-C1', ck);
    const b = await r.text();
    expect(b).toContain('Stop Payment');
    expect(b).toContain('1055');     // check number
    expect(b).toContain('Lost in mail');
  });

  it('payoff quote computes amount', async () => {
    const ck = await login();
    // Member 22222 has mortgage L-22222-01
    const r = await get('/member/22222/loan/L-22222-01/payoff', ck);
    const b = await r.text();
    expect(b).toContain('Payoff Quote');
    expect(b).toContain('Per Diem Interest');
    expect(b).toContain('Total Payoff Amount');
    expect(b).toContain('$'); // should show a dollar amount
  });

  it('joint owner add persists', async () => {
    const ck = await login();
    const r = await post('/member/45678/secondary-names', ck, 'f1=Test+Person&f2=Beneficiary&f3=01/01/1990');
    const b = await r.text();
    expect(b).toContain('Secondary name added');
    expect(b).toContain('Test Person');
    expect(b).toContain('Beneficiary');
  });

  it('certificate open mutates both accounts', async () => {
    const ck = await login();
    // Open 12-month CD for $500 from member 55555 savings (balance $9,300)
    const reviewR = await post('/member/55555/open-certificate', ck, 'f1=12&f2=500&f3=55555-S1');
    expect(reviewR.status).toBe(200);
    expect(await reviewR.text()).toContain('Review Certificate');

    const confirmR = await post('/member/55555/open-certificate/confirm', ck, 'f1=12&f2=500&f3=55555-S1');
    expect(confirmR.status).toBe(302);
    // Check savings balance decreased
    const accts = await get('/member/55555/accounts', ck);
    const acctBody = await accts.text();
    expect(acctBody).toContain('$8,800.00'); // 9300 - 500
    expect(acctBody).toContain('CD'); // new CD account appears
  });

  it('close blocked on non-zero balance', async () => {
    const ck = await login();
    // Try to close member 12345's savings (has balance)
    const r = await get('/member/12345/account/12345-S1/close', ck);
    const b = await r.text();
    expect(b).toContain('Cannot close account with non-zero balance');
  });

  it('wire blocked for operator, allowed for supervisor', async () => {
    const opCk = await login();
    const supCk = await loginAs('supervisor', 'demo456');

    // Acknowledge compliance for 23456 (has alert) if needed
    // Actually 45678 has no alert, use that instead
    const opR = await get('/member/45678/wire', opCk);
    expect(await opR.text()).toContain('Insufficient privileges');

    // Supervisor: acknowledge compliance for any alerts then access wire
    const supR = await get('/member/45678/wire', supCk);
    const supBody = await supR.text();
    expect(supBody).toContain('Wire Transfer');
    expect(supBody).not.toContain('Insufficient privileges');
  });

  it('loan application persists', async () => {
    const ck = await login();
    const r = await post('/member/45678/loan-application', ck, 'f1=Auto+Loan&f2=15000&f3=60&f4=55000');
    const b = await r.text();
    expect(b).toContain('Application');
    expect(b).toContain('submitted');
    expect(b).toContain('APP-');
    // Check audit
    const audit = await get('/audit', ck);
    expect(await audit.text()).toContain('LOAN_APP_SUBMIT');
  });

  it('EOD totals reflect today actions', async () => {
    const ck = await login();
    // We've done deposits and withdrawals in this test session
    const r = await get('/eod-summary', ck);
    const b = await r.text();
    expect(b).toContain('EOD Summary');
    expect(b).toContain('Teller Deposits');
    expect(b).toContain('Supervisor Overrides');
  });

  it('delinquency screen shows past-due loans', async () => {
    const ck = await login();
    const r = await get('/lending/delinquency', ck);
    const b = await r.text();
    expect(b).toContain('Delinquency');
    expect(b).toContain('days'); // "X days" late
  });
});

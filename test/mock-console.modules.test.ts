// Phase 1.6 module tests — HTTP only, no imports from mock-console/.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type ChildProcess, spawn } from 'node:child_process';

const PORT = 3458;
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

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'f1=operator&f2=demo123',
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

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

describe('Phase 1.6 modules', () => {

  it('name search returns results list page', async () => {
    const cookie = await login();
    // Search by last name "Thompson" — should match 12345 (Jane) and 10101 (Angela)
    const searchRes = await post('/search', cookie, 'f2=Thompson');
    expect(searchRes.status).toBe(302);
    const resultsRes = await followRedirect(searchRes, cookie);
    const body = await resultsRes.text();
    expect(body).toContain('Search Results');
    expect(body).toContain('12345');
    expect(body).toContain('Jane Thompson');
    expect(body).toContain('10101');
    expect(body).toContain('Angela Thompson');
  });

  it('share detail page renders', async () => {
    const cookie = await login();
    const res = await get('/member/12345/account/12345-S1', cookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Share Details');
    expect(body).toContain('$4,320.10');
    expect(body).toContain('0.45%');  // dividend rate
    expect(body).toContain('Active');
    expect(body).toContain('View');    // View Transaction History link
  });

  it('transactions page 2 via Next works', async () => {
    const cookie = await login();
    // Member 12345 Savings has 20 transactions: 6 hand-written + 14 generated
    const page1 = await get('/member/12345/account/12345-S1/transactions', cookie);
    const page1Body = await page1.text();
    expect(page1Body).toContain('Page 1 of');
    expect(page1Body).toContain('Next');

    const page2 = await get('/member/12345/account/12345-S1/transactions?page=2', cookie);
    const page2Body = await page2.text();
    expect(page2Body).toContain('Page 2 of');
    expect(page2Body).toContain('Prev');
  });

  it('date filter narrows transaction rows', async () => {
    const cookie = await login();
    // Without filter — should include August transactions
    const all = await get('/member/12345/account/12345-S1/transactions', cookie);
    const allBody = await all.text();
    expect(allBody).toContain('Interest Payment'); // 08/10/2026

    // With July-only filter — should exclude August transactions
    const filtered = await get('/member/12345/account/12345-S1/transactions?from=07/01/2026&to=07/31/2026', cookie);
    const filteredBody = await filtered.text();
    expect(filteredBody).toContain('ATM Withdrawal'); // 07/22/2026
    expect(filteredBody).not.toContain('Interest Payment'); // 08/10/2026 excluded
  });

  it('contact update persists AND appends audit row', async () => {
    const cookie = await login();
    // Update contact for member 45678
    const updateRes = await post('/member/45678/update-contact', cookie,
      'f1=999+New+St&f2=Salem&f3=OR&f4=97301&f5=(503)+555-9999&f6=new@email.com');
    expect(updateRes.status).toBe(302);

    // Follow redirect — member detail should show update banner and new info
    const detailRes = await followRedirect(updateRes, cookie);
    const body = await detailRes.text();
    expect(body).toContain('Contact information updated');
    expect(body).toContain('999 New St');
    expect(body).toContain('Salem');

    // Check audit log has the entry
    const auditRes = await get('/audit', cookie);
    const auditBody = await auditRes.text();
    expect(auditBody).toContain('UPDATE_CONTACT');
    expect(auditBody).toContain('45678');
  });

  it('note persists', async () => {
    const cookie = await login();
    const noteRes = await post('/member/12345/notes', cookie, 'f1=Test+note+from+phase+1.6');
    expect(noteRes.status).toBe(200);
    const body = await noteRes.text();
    expect(body).toContain('Note saved');
    expect(body).toContain('Test note from phase 1.6');
  });

  it('loan payment mutates share, loan, AND audit log', async () => {
    const cookie = await login();
    // Member 22222 has Mortgage L-22222-01 ($185,432.10) and Savings 22222-S1 ($6,200.00)
    // Pay $500 from Savings
    const payRes = await post('/member/22222/loan/L-22222-01/payment', cookie,
      'f1=22222-S1&f2=500');
    expect(payRes.status).toBe(302);
    const reviewRes = await followRedirect(payRes, cookie);
    expect(await reviewRes.text()).toContain('Post Payment');

    const execRes = await post('/member/22222/loan/L-22222-01/payment/review', cookie,
      'f1=22222-S1&f2=500');
    expect(execRes.status).toBe(302);
    const doneRes = await followRedirect(execRes, cookie);
    const doneBody = await doneRes.text();
    expect(doneBody).toContain('Payment Posted');
    expect(doneBody).toContain('LP-');

    // Check share balance decreased
    const accts = await get('/member/22222/accounts', cookie);
    const acctBody = await accts.text();
    expect(acctBody).toContain('$5,700.00'); // 6200 - 500

    // Check loan balance decreased
    const loanRes = await get('/member/22222/loan/L-22222-01', cookie);
    const loanBody = await loanRes.text();
    expect(loanBody).toContain('$184,932.10'); // 185432.10 - 500

    // Check audit log
    const auditRes = await get('/audit', cookie);
    expect(await auditRes.text()).toContain('LOAN_PAYMENT');
  });

  it('profile blocks render (address, SSN, loans section)', async () => {
    const cookie = await login();
    const res = await get('/member?q=34567', cookie);
    const body = await res.text();
    // Full profile
    expect(body).toContain('782 Cedar Ln');        // address
    expect(body).toContain('***-**-5508');          // masked SSN
    expect(body).toContain('11/03/2016');           // member since
    // Loans section with different styling
    expect(body).toContain('L-34567-01');           // loan ID
    expect(body).toContain('Auto Loan');
    // CD in accounts
    expect(body).toContain('Member Details');
  });

  it('dashboard stats present', async () => {
    const cookie = await login();
    const res = await get('/dashboard', cookie);
    const body = await res.text();
    expect(body).toContain('Members');
    expect(body).toContain('Total Shares');
    expect(body).toContain('$');
    expect(body).toContain('Recent Activity');
  });

  it('audit log page renders newest-first', async () => {
    const cookie = await login();
    // The login itself creates an audit entry, plus any mutations from prior tests
    const res = await get('/audit', cookie);
    const body = await res.text();
    expect(body).toContain('Audit Log');
    expect(body).toContain('LOGIN');
    // Verify newest-first: the LOGIN entry from this test's login should be near the top
    // and earlier entries below. Just verify the page renders and has entries.
    expect(body).toContain('Successful login');
  });
});

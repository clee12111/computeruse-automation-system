// mock-console/server.js — Quarantined mock legacy bank console.
// Zero imports from ../src. Zero runtime dependencies. Plain Node http.
// Deliberately hostile UI: table layouts, iframes, no IDs, no labels, generic classes.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ── Tenant config ───────────────────────────────────────────
const tenantsDir = path.join(__dirname, 'tenants');
const tenants = {};
for (const file of fs.readdirSync(tenantsDir)) {
  if (file.endsWith('.json')) {
    const id = file.replace('.json', '');
    tenants[id] = JSON.parse(fs.readFileSync(path.join(tenantsDir, file), 'utf8'));
  }
}

// ── Synthetic member data ───────────────────────────────────
const MEMBERS = {
  '12345': {
    name: 'Jane Thompson', dob: '03/15/1985', phone: '(503) 555-0142',
    accounts: [
      { type: 'Savings',  number: '12345-S1', balance: 4320.10 },
      { type: 'Checking', number: '12345-C1', balance: 1205.63 },
    ],
  },
  '23456': {
    // TWO Savings accounts — Phase 7 ambiguity test target
    name: 'Robert Chen', dob: '11/02/1978', phone: '(503) 555-0198',
    accounts: [
      { type: 'Savings',  number: '23456-S1', balance: 8150.00 },
      { type: 'Checking', number: '23456-C1', balance: 950.22 },
      { type: 'Savings',  number: '23456-S2', balance: 2340.55 },
    ],
  },
  '34567': {
    // 4+ accounts, Savings NOT first — mixed order test
    name: 'Maria Garcia', dob: '07/22/1990', phone: '(503) 555-0234',
    accounts: [
      { type: 'Checking',     number: '34567-C1', balance: 3100.00 },
      { type: 'Money Market', number: '34567-M1', balance: 15000.00 },
      { type: 'Savings',      number: '34567-S1', balance: 500.75 },
      { type: 'CD',           number: '34567-D1', balance: 10000.00 },
    ],
  },
  '45678': {
    name: 'David Park', dob: '01/30/1965', phone: '(503) 555-0301',
    accounts: [
      { type: 'Savings', number: '45678-S1', balance: 200.00 },
    ],
  },
  '56789': {
    name: 'Lisa Williams', dob: '09/14/1992', phone: '(503) 555-0456',
    accounts: [
      { type: 'Checking', number: '56789-C1', balance: 6543.21 },
      { type: 'Savings',  number: '56789-S1', balance: 12100.00 },
    ],
  },
  '67890': {
    name: 'James Brown', dob: '05/08/1970', phone: '(503) 555-0567',
    accounts: [
      { type: 'Savings',  number: '67890-S1', balance: 0.50 },
      { type: 'Checking', number: '67890-C1', balance: 25.00 },
    ],
  },
};

// ── Session store ───────────────────────────────────────────
const sessions = new Set();

// ── Helpers ─────────────────────────────────────────────────
const SPACER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(new URLSearchParams(body)));
  });
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? match.split('=')[1] : null;
}

function isAuthed(req) {
  const sid = getCookie(req, 'sid');
  return sid && sessions.has(sid);
}

function formatMoney(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function respond(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function redirect(res, location, cookie) {
  const headers = { location };
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(302, headers);
  res.end();
}

let nextAcctSeq = 900001;

// ── HTML templates ──────────────────────────────────────────
// All rendering uses table layout, generic classes, NO id attrs,
// NO <label for>, NO name attrs except where form POST requires them.

function layout(tenant, title, bodyContent) {
  return `<!DOCTYPE html>
<html><head><title>${title} - ${tenant.name}</title>
<style>
body { margin:0; padding:0; font-family:"Times New Roman",serif; background:${tenant.themeBg}; color:#222; }
.c1 { background:${tenant.themeColor}; color:#fff; padding:6px 12px; font-size:18px; }
.c2 { font-size:11px; color:#ccc; }
.c3 { background:#e8e0d0; padding:4px 8px; font-size:11px; border-bottom:1px solid #bbb; }
.box { padding:12px; }
.item { border:1px solid #999; background:#fff; }
.hdr { background:#d4ccbc; font-weight:bold; padding:4px 6px; font-size:12px; }
.r1 { background:#fff; } .r2 { background:#f5f0e5; }
.tbl { border-collapse:collapse; }
.tbl td, .tbl th { border:1px solid #999; padding:3px 8px; font-size:12px; }
.btn { background:${tenant.themeColor}; color:#fff; border:1px outset #888; padding:3px 14px;
       font-size:12px; cursor:pointer; font-family:inherit; }
.err { color:#900; font-size:12px; }
a { color:${tenant.themeColor}; }
</style></head><body>
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="c1" colspan="2">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td><img src="${SPACER}" width="1" height="36" class="item" style="border:0;visibility:hidden"></td>
    <td width="99%"><b>${tenant.name}</b>&nbsp;&mdash;&nbsp;${tenant.labels.operatorConsole}
      <br><span class="c2">v3.2.1-legacy &bull; Session active</span></td>
  </tr></table>
</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="2"></td></tr>
<tr><td colspan="2" class="c3">&nbsp;Home&nbsp;&gt;&nbsp;${title}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr><td valign="top" class="box">${bodyContent}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="1" style="display:block;background:#999"></td></tr>
<tr><td colspan="2" style="font-size:10px;color:#888;padding:4px 8px;">&copy; ${tenant.name} &bull; Internal Use Only</td></tr>
</table>
</body></html>`;
}

function loginPage(tenant, error) {
  const errHtml = error ? `<tr><td colspan="2" class="err">${error}</td></tr>` : '';
  return layout(tenant, tenant.labels.signIn, `
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<img src="${SPACER}" width="1" height="30">
<table class="item" cellpadding="12" cellspacing="0" border="0" width="340">
<tr><td class="hdr" colspan="2">${tenant.labels.signIn}</td></tr>
${errHtml}
<tr><td colspan="2"><img src="${SPACER}" width="1" height="6"></td></tr>
<form method="POST">
<tr class="r1"><td width="120" style="font-size:12px;">Username</td>
    <td><input type="text" name="f1" class="item" style="width:150px;font-size:12px;"></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr class="r1"><td style="font-size:12px;">Password</td>
    <td><input type="password" name="f2" class="item" style="width:150px;font-size:12px;"></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td></td><td><button type="submit" class="btn">${tenant.labels.signIn}</button></td></tr>
</form>
</table>
</td></tr></table>`);
}

function searchPage(tenant) {
  return layout(tenant, tenant.labels.search, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="420">
<tr><td class="hdr" colspan="2">${tenant.labels.search}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="6"></td></tr>
<form method="POST">
<tr class="r1">
  <td width="140" style="font-size:12px;">${tenant.labels.memberNumber}</td>
  <td><input type="text" class="item" style="width:140px;font-size:12px;" name="f1"></td>
</tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td></td><td><button type="submit" class="btn">${tenant.labels.search}</button></td></tr>
</form>
</table>`);
}

function notFoundPage(tenant) {
  return layout(tenant, tenant.labels.search, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="420">
<tr><td class="hdr">${tenant.labels.search}</td></tr>
<tr class="r1"><td style="font-size:12px;">No member matches</td></tr>
<tr><td><a href="search" style="font-size:11px;">&laquo; Back</a></td></tr>
</table>`);
}

function memberPage(tenant, memberId, member) {
  const prefix = `/t/${tenant.id}`;
  return layout(tenant, tenant.labels.memberDetails, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="580">
<tr><td class="hdr" colspan="2">${tenant.labels.memberDetails}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Name</td>
    <td style="font-size:12px;">${member.name}</td></tr>
<tr class="r2"><td style="font-size:12px;">${tenant.labels.memberNumber}</td>
    <td style="font-size:12px;">${memberId}</td></tr>
<tr class="r1"><td style="font-size:12px;">Date of Birth</td>
    <td style="font-size:12px;">${member.dob}</td></tr>
<tr class="r2"><td style="font-size:12px;">Phone</td>
    <td style="font-size:12px;">${member.phone}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td colspan="2" class="hdr">Accounts</td></tr>
<tr><td colspan="2" style="padding:0;">
  <iframe src="${prefix}/member/${memberId}/accounts" width="100%" height="180"
    frameborder="1" scrolling="auto" class="box"></iframe>
</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td colspan="2">
  <a href="${prefix}/member/${memberId}/open-sub-account" class="btn"
     style="text-decoration:none;display:inline-block;">${tenant.labels.openSubAccount}</a>
</td></tr>
</table>`);
}

function accountsFrame(tenant, member) {
  let rows = '';
  member.accounts.forEach((acct, i) => {
    const cls = i % 2 === 0 ? 'r1' : 'r2';
    rows += `<tr class="${cls}">
      <td>${acct.number}</td><td>${acct.type}</td><td align="right">${formatMoney(acct.balance)}</td>
    </tr>`;
  });
  // Full HTML document for the iframe — deliberately a separate page
  return `<!DOCTYPE html>
<html><head><style>
body { margin:0; padding:0; font-family:"Times New Roman",serif; background:#fff; }
.tbl { border-collapse:collapse; width:100%; }
.tbl td, .tbl th { border:1px solid #999; padding:3px 8px; font-size:12px; }
.hdr { background:#d4ccbc; font-weight:bold; font-size:12px; }
.r1 { background:#fff; } .r2 { background:#f5f0e5; }
</style></head><body>
<table class="tbl" cellpadding="0" cellspacing="0">
<tr class="hdr">
  <th>${tenant.labels.accountNumber}</th>
  <th>${tenant.labels.accountType}</th>
  <th>${tenant.labels.accountBalance}</th>
</tr>
${rows}
</table>
</body></html>`;
}

function openSubAccountPage(tenant, memberId, member) {
  return layout(tenant, tenant.labels.openSubAccount, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">${tenant.labels.openSubAccount}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Member</td>
    <td style="font-size:12px;">${member.name} (${memberId})</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="6"></td></tr>
<form method="POST">
<tr class="r2"><td style="font-size:12px;">Account Type</td>
    <td><select class="item" style="font-size:12px;" name="f1">
      <option value="holiday-club">Holiday Club</option>
      <option value="money-market">Money Market</option>
      <option value="secondary-savings">Secondary Savings</option>
    </select></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Open Account</button></td></tr>
</form>
</table>`);
}

function confirmationPage(tenant, memberId, member, accountType, acctNum) {
  const typeLabel = { 'holiday-club': 'Holiday Club', 'money-market': 'Money Market',
                      'secondary-savings': 'Secondary Savings' }[accountType] || accountType;
  return layout(tenant, 'Confirmation', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">Account Opened</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Member</td>
    <td style="font-size:12px;">${member.name} (${memberId})</td></tr>
<tr class="r2"><td style="font-size:12px;">Account Type</td>
    <td style="font-size:12px;">${typeLabel}</td></tr>
<tr class="r1"><td style="font-size:12px;">New Account #</td>
    <td style="font-size:12px;">${acctNum}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td colspan="2" style="font-size:12px;">
  <a href="/t/${tenant.id}/search">&laquo; Return to ${tenant.labels.search}</a>
</td></tr>
</table>`);
}

// ── Request handler ─────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ── PHASE 7 FAULT INJECTION STUB ────────────────────────
  // Read the fault parameter. Currently unused — Phase 7 will
  // dispatch on this value to inject: session_dialog, slow_load,
  // app_error, not_found, permission_denied, validation_error.
  const _fault = url.searchParams.get('fault');
  void _fault;
  // ── END FAULT STUB ──────────────────────────────────────

  // Match /t/<tenantId>/...
  const tenantMatch = pathname.match(/^\/t\/([^/]+)(\/.*)?$/);
  if (!tenantMatch) {
    // Root → redirect to first tenant's login
    const firstTenant = Object.keys(tenants)[0];
    if (firstTenant) return redirect(res, `/t/${firstTenant}/login`);
    return respond(res, 404, 'No tenants configured');
  }

  const tenantId = tenantMatch[1];
  const tenant = tenants[tenantId];
  if (!tenant) return respond(res, 404, 'Unknown tenant');

  const subpath = tenantMatch[2] || '/';
  const prefix = `/t/${tenantId}`;

  // ── Login ───────────────────────────────────────────────
  if (subpath === '/login' || subpath === '/login/') {
    if (req.method === 'GET') {
      return respond(res, 200, loginPage(tenant, null));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const username = body.get('f1') || '';
      const password = body.get('f2') || '';
      if (username === 'operator' && password === 'demo123') {
        const sid = crypto.randomBytes(16).toString('hex');
        sessions.add(sid);
        return redirect(res, `${prefix}/search`, `sid=${sid}; Path=/; HttpOnly`);
      }
      return respond(res, 200, loginPage(tenant, 'Invalid credentials'));
    }
  }

  // ── Auth gate (everything below requires session) ───────
  if (!isAuthed(req)) {
    return redirect(res, `${prefix}/login`);
  }

  // ── Search ──────────────────────────────────────────────
  if (subpath === '/search' || subpath === '/search/') {
    if (req.method === 'GET') {
      return respond(res, 200, searchPage(tenant));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const memberId = (body.get('f1') || '').trim();
      return redirect(res, `${prefix}/member?q=${encodeURIComponent(memberId)}`);
    }
  }

  // ── Member detail ───────────────────────────────────────
  if (subpath === '/member' || subpath === '/member/') {
    const memberId = url.searchParams.get('q') || '';
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 200, notFoundPage(tenant));
    return respond(res, 200, memberPage(tenant, memberId, member));
  }

  // ── Accounts iframe content ─────────────────────────────
  const accountsMatch = subpath.match(/^\/member\/([^/]+)\/accounts$/);
  if (accountsMatch) {
    const memberId = accountsMatch[1];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    return respond(res, 200, accountsFrame(tenant, member));
  }

  // ── Open sub-account ────────────────────────────────────
  const subAcctMatch = subpath.match(/^\/member\/([^/]+)\/open-sub-account$/);
  if (subAcctMatch) {
    const memberId = subAcctMatch[1];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');

    if (req.method === 'GET') {
      return respond(res, 200, openSubAccountPage(tenant, memberId, member));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const accountType = body.get('f1') || 'holiday-club';
      const acctNum = `${memberId}-N${nextAcctSeq++}`;
      return redirect(res, `${prefix}/member/${memberId}/confirmation?type=${encodeURIComponent(accountType)}&acctNum=${encodeURIComponent(acctNum)}`);
    }
  }

  // ── Confirmation ────────────────────────────────────────
  const confirmMatch = subpath.match(/^\/member\/([^/]+)\/confirmation$/);
  if (confirmMatch) {
    const memberId = confirmMatch[1];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    const accountType = url.searchParams.get('type') || '';
    const acctNum = url.searchParams.get('acctNum') || '';
    return respond(res, 200, confirmationPage(tenant, memberId, member, accountType, acctNum));
  }

  // ── Fallback ────────────────────────────────────────────
  respond(res, 404, layout(tenant, 'Not Found', '<p class="err">Page not found</p>'));
}

// ── Start ───────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Mock console listening on http://localhost:${PORT}`);
  console.log(`Tenants: ${Object.keys(tenants).join(', ')}`);
});

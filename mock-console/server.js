// mock-console/server.js — Quarantined mock legacy bank console.
// Zero imports from ../src. Zero runtime dependencies. Plain Node http.
// Deliberately hostile UI: table layouts, iframes, no IDs, no labels, generic classes.
//
// Reference patterns modeled (original code, no copies):
//   AltoroJ: page skeleton (banner + left nav + content pane + footer), table grammar
//   ParaBank: flow shapes (accounts → detail → transactions; transfer → review → confirm)
//   Episys: Share ID column, label keys structured for tenant-driven vocabulary

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

// ── Constants ───────────────────────────────────────────────
const SPACER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || '600000', 10);

const CREDENTIALS = {
  operator:   { password: 'demo123', role: 'operator' },
  supervisor: { password: 'demo456', role: 'supervisor' },
};

const SUB_ACCOUNT_TYPES = {
  'holiday-club':      'Holiday Club',
  'money-market':      'Money Market',
  'secondary-savings': 'Secondary Savings',
};

// ── Synthetic member data ───────────────────────────────────
const MEMBERS = {
  '12345': {
    name: 'Jane Thompson', dob: '03/15/1985', phone: '(503) 555-0142',
    alert: null,
    accounts: [
      { type: 'Savings', number: '12345-S1', shareId: '00', balance: 4320.10,
        transactions: [
          { date: '07/01/2026', desc: 'Opening Deposit', debit: null, credit: 1000.00 },
          { date: '07/15/2026', desc: 'Payroll Direct Deposit', debit: null, credit: 2150.00 },
          { date: '07/22/2026', desc: 'ATM Withdrawal', debit: 200.00, credit: null },
          { date: '08/01/2026', desc: 'Payroll Direct Deposit', debit: null, credit: 2150.00 },
          { date: '08/05/2026', desc: 'Transfer to Checking', debit: 800.00, credit: null },
          { date: '08/10/2026', desc: 'Interest Payment', debit: null, credit: 20.10 },
        ] },
      { type: 'Checking', number: '12345-C1', shareId: '01', balance: 1205.63,
        transactions: [
          { date: '07/01/2026', desc: 'Opening Deposit', debit: null, credit: 500.00 },
          { date: '07/18/2026', desc: 'Debit Card - Corner Market', debit: 32.47, credit: null },
          { date: '07/25/2026', desc: 'Online Bill Pay - City Water', debit: 84.50, credit: null },
          { date: '08/01/2026', desc: 'Check #1042', debit: 250.00, credit: null },
          { date: '08/05/2026', desc: 'Transfer from Savings', debit: null, credit: 800.00 },
        ] },
    ],
  },
  '23456': {
    // TWO Savings accounts — Phase 7 ambiguity test target
    name: 'Robert Chen', dob: '11/02/1978', phone: '(503) 555-0198',
    alert: 'Address verification pending',
    accounts: [
      { type: 'Savings', number: '23456-S1', shareId: '00', balance: 8150.00,
        transactions: [
          { date: '07/10/2026', desc: 'Opening Deposit', debit: null, credit: 5000.00 },
          { date: '08/01/2026', desc: 'Payroll Direct Deposit', debit: null, credit: 3200.00 },
        ] },
      { type: 'Checking', number: '23456-C1', shareId: '01', balance: 950.22,
        transactions: [
          { date: '07/10/2026', desc: 'Opening Deposit', debit: null, credit: 1000.00 },
        ] },
      { type: 'Savings', number: '23456-S2', shareId: '02', balance: 2340.55,
        transactions: [
          { date: '07/15/2026', desc: 'Opening Deposit', debit: null, credit: 2500.00 },
        ] },
    ],
  },
  '34567': {
    // 4+ accounts, Savings NOT first — mixed order test
    name: 'Maria Garcia', dob: '07/22/1990', phone: '(503) 555-0234',
    alert: null,
    accounts: [
      { type: 'Checking', number: '34567-C1', shareId: '01', balance: 3100.00,
        transactions: [
          { date: '07/05/2026', desc: 'Opening Deposit', debit: null, credit: 3500.00 },
          { date: '08/02/2026', desc: 'Debit Card - Pharmacy', debit: 45.00, credit: null },
        ] },
      { type: 'Money Market', number: '34567-M1', shareId: '10', balance: 15000.00,
        transactions: [
          { date: '06/01/2026', desc: 'Opening Deposit', debit: null, credit: 15000.00 },
        ] },
      { type: 'Savings', number: '34567-S1', shareId: '00', balance: 500.75,
        transactions: [
          { date: '07/05/2026', desc: 'Opening Deposit', debit: null, credit: 500.75 },
        ] },
      { type: 'CD', number: '34567-D1', shareId: '20', balance: 10000.00,
        transactions: [
          { date: '01/15/2026', desc: '12-Month CD Opening', debit: null, credit: 10000.00 },
        ] },
    ],
  },
  '45678': {
    name: 'David Park', dob: '01/30/1965', phone: '(503) 555-0301',
    alert: null,
    accounts: [
      { type: 'Savings', number: '45678-S1', shareId: '00', balance: 200.00,
        transactions: [
          { date: '08/01/2026', desc: 'Opening Deposit', debit: null, credit: 200.00 },
        ] },
    ],
  },
  '56789': {
    name: 'Lisa Williams', dob: '09/14/1992', phone: '(503) 555-0456',
    alert: null,
    accounts: [
      { type: 'Checking', number: '56789-C1', shareId: '01', balance: 6543.21,
        transactions: [
          { date: '06/20/2026', desc: 'Opening Deposit', debit: null, credit: 7000.00 },
          { date: '07/30/2026', desc: 'Online Bill Pay - Rent', debit: 456.79, credit: null },
        ] },
      { type: 'Savings', number: '56789-S1', shareId: '00', balance: 12100.00,
        transactions: [
          { date: '06/20/2026', desc: 'Opening Deposit', debit: null, credit: 12000.00 },
          { date: '08/01/2026', desc: 'Interest Payment', debit: null, credit: 100.00 },
        ] },
    ],
  },
  '67890': {
    name: 'James Brown', dob: '05/08/1970', phone: '(503) 555-0567',
    alert: null,
    accounts: [
      { type: 'Savings', number: '67890-S1', shareId: '00', balance: 0.50,
        transactions: [
          { date: '08/01/2026', desc: 'Opening Deposit', debit: null, credit: 100.00 },
          { date: '08/10/2026', desc: 'ATM Withdrawal', debit: 99.50, credit: null },
        ] },
      { type: 'Checking', number: '67890-C1', shareId: '01', balance: 25.00,
        transactions: [
          { date: '08/01/2026', desc: 'Opening Deposit', debit: null, credit: 25.00 },
        ] },
    ],
  },
  '78901': {
    name: 'Patricia Hale', dob: '12/03/1958', phone: '(503) 555-0678',
    alert: 'Account restricted \u2014 supervisor review required',
    accounts: [
      { type: 'Savings', number: '78901-S1', shareId: '00', balance: 15750.00,
        transactions: [
          { date: '05/15/2026', desc: 'Opening Deposit', debit: null, credit: 15000.00 },
          { date: '07/01/2026', desc: 'Interest Payment', debit: null, credit: 750.00 },
        ] },
      { type: 'Checking', number: '78901-C1', shareId: '01', balance: 3200.00,
        transactions: [
          { date: '05/15/2026', desc: 'Opening Deposit', debit: null, credit: 3200.00 },
        ] },
    ],
  },
};

// ── Session store ───────────────────────────────────────────
// Map<sid, { role, username, createdAt, acknowledgedMembers: Set }>
const sessions = new Map();

function getSession(req) {
  const sid = getCookie(req, 'sid');
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  return { sid, ...s };
}

function isExpired(session) {
  return Date.now() - session.createdAt > SESSION_TTL_MS;
}

function isNearExpiry(session) {
  return Date.now() - session.createdAt > SESSION_TTL_MS * 0.8;
}

// ── Helpers ─────────────────────────────────────────────────
let nextAcctSeq = 900001;
let nextRefSeq = 1001;

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

function today() {
  const d = new Date();
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;
}

function findAccount(member, acctNum) {
  return member.accounts.find(a => a.number === acctNum) || null;
}

// ── HTML templates ──────────────────────────────────────────
// Hostility: table layout, generic classes, NO id attrs, NO <label for>,
// NO name attrs except where form POST requires them. Spacer gifs.
// Modeled on AltoroJ skeleton: top banner, left nav td, content td, footer.

function layout(tenant, title, bodyContent, session, prefix) {
  const navHtml = session ? `
    <td width="150" valign="top" style="background:#e8e0d0;border-right:1px solid #bbb;padding:0;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td class="hdr" style="padding:4px 8px;">&nbsp;</td></tr>
      <tr class="r1"><td style="padding:4px 8px;font-size:12px;">
        <a href="${prefix}/dashboard">${tenant.labels.dashboard}</a></td></tr>
      <tr class="r2"><td style="padding:4px 8px;font-size:12px;">
        <a href="${prefix}/search">${tenant.labels.search}</a></td></tr>
      <tr><td><img src="${SPACER}" width="1" height="1" style="display:block;background:#bbb;"></td></tr>
      <tr class="r1"><td style="padding:4px 8px;font-size:12px;">
        <a href="${prefix}/reports" style="color:#888;">${tenant.labels.reports}</a></td></tr>
      <tr class="r2"><td style="padding:4px 8px;font-size:12px;">
        <a href="${prefix}/settings" style="color:#888;">${tenant.labels.settings}</a></td></tr>
      <tr class="r1"><td style="padding:4px 8px;font-size:12px;">
        <a href="${prefix}/audit" style="color:#888;">${tenant.labels.auditLog}</a></td></tr>
      </table>
      <img src="${SPACER}" width="150" height="1">
    </td>` : '';

  const welcomeHtml = session
    ? `<td align="right" style="font-size:11px;padding-right:12px;">Welcome, <b>${session.username}</b>&nbsp;|&nbsp;<a href="${prefix}/logout" style="color:#ccc;">Sign Off</a></td>`
    : '';

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
.warn { background:#fff3cd; border:1px solid #d4a017; padding:6px 10px; font-size:12px; margin-bottom:8px; }
a { color:${tenant.themeColor}; }
</style></head><body>
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="c1" colspan="3">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td><img src="${SPACER}" width="1" height="36" style="visibility:hidden;border:0;"></td>
    <td width="50%"><b>${tenant.name}</b>&nbsp;&mdash;&nbsp;${tenant.labels.operatorConsole}
      <br><span class="c2">v3.2.1-legacy &bull; Session active</span></td>
    ${welcomeHtml}
  </tr></table>
</td></tr>
<tr><td colspan="3"><img src="${SPACER}" width="1" height="2"></td></tr>
<tr><td colspan="3" class="c3">&nbsp;Home&nbsp;&gt;&nbsp;${title}</td></tr>
<tr><td colspan="3"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr>
  ${navHtml}
  <td valign="top" class="box">${bodyContent}</td>
</tr>
<tr><td colspan="3"><img src="${SPACER}" width="1" height="1" style="display:block;background:#999;"></td></tr>
<tr><td colspan="3" style="font-size:10px;color:#888;padding:4px 8px;">
  &copy; ${tenant.name} &bull; Internal Use Only &bull; Unauthorized access prohibited
</td></tr>
</table>
</body></html>`;
}

function loginPage(tenant, message) {
  const msgHtml = message
    ? `<tr><td colspan="2" class="${message.includes('expired') ? 'warn' : 'err'}">${message}</td></tr>`
    : '';
  return layout(tenant, tenant.labels.signIn, `
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<img src="${SPACER}" width="1" height="30">
<table class="item" cellpadding="12" cellspacing="0" border="0" width="340">
<tr><td class="hdr" colspan="2">${tenant.labels.signIn}</td></tr>
${msgHtml}
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
</td></tr></table>`, null, '');
}

function dashboardPage(tenant, session, prefix) {
  return layout(tenant, tenant.labels.dashboard, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="520">
<tr><td class="hdr" colspan="2">${tenant.labels.dashboard}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="6"></td></tr>
<tr class="r1"><td colspan="2" style="font-size:13px;">Welcome, <b>${session.username}</b>.
  Select an action below or use the navigation menu.</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr class="r2"><td width="180" style="font-size:12px;">
  <a href="${prefix}/search">${tenant.labels.search}</a></td>
  <td style="font-size:11px;color:#666;">Look up member accounts and details</td></tr>
<tr class="r1"><td style="font-size:12px;color:#888;">${tenant.labels.reports}</td>
  <td style="font-size:11px;color:#999;">Not available in this build</td></tr>
<tr class="r2"><td style="font-size:12px;color:#888;">${tenant.labels.settings}</td>
  <td style="font-size:11px;color:#999;">Not available in this build</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="6"></td></tr>
<tr><td colspan="2" style="font-size:10px;color:#888;">Last login: 08/12/2026 14:32:05</td></tr>
</table>`, session, prefix);
}

function searchPage(tenant, session, prefix) {
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
</table>`, session, prefix);
}

function notFoundPage(tenant, session, prefix) {
  return layout(tenant, tenant.labels.search, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="420">
<tr><td class="hdr">${tenant.labels.search}</td></tr>
<tr class="r1"><td style="font-size:12px;">No member matches</td></tr>
<tr><td><a href="${prefix}/search" style="font-size:11px;">&laquo; Back</a></td></tr>
</table>`, session, prefix);
}

function memberPage(tenant, memberId, member, session, prefix) {
  const alertHtml = member.alert
    ? `<tr><td colspan="2"><table width="100%" cellpadding="0" cellspacing="0" border="0">
       <tr><td class="warn"><b>Alert:</b> ${member.alert}</td></tr></table></td></tr>`
    : '';
  return layout(tenant, tenant.labels.memberDetails, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="620">
<tr><td class="hdr" colspan="2">${tenant.labels.memberDetails}</td></tr>
${alertHtml}
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
  <iframe src="${prefix}/member/${memberId}/accounts" width="100%" height="200"
    frameborder="1" scrolling="auto" class="box"></iframe>
</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td>
  <a href="${prefix}/member/${memberId}/open-sub-account" class="btn"
     style="text-decoration:none;display:inline-block;">${tenant.labels.openSubAccount}</a>
</td><td>
  <a href="${prefix}/member/${memberId}/transfer" class="btn"
     style="text-decoration:none;display:inline-block;">${tenant.labels.transferFunds}</a>
</td></tr>
</table>`, session, prefix);
}

function accountsFrame(tenant, memberId, member, prefix) {
  let rows = '';
  member.accounts.forEach((acct, i) => {
    const cls = i % 2 === 0 ? 'r1' : 'r2';
    rows += `<tr class="${cls}">
      <td>${acct.shareId}</td>
      <td><a href="${prefix}/member/${memberId}/account/${acct.number}/transactions"
             target="_parent">${acct.number}</a></td>
      <td>${acct.type}</td>
      <td align="right">${formatMoney(acct.balance)}</td>
    </tr>`;
  });
  return `<!DOCTYPE html>
<html><head><style>
body { margin:0; padding:0; font-family:"Times New Roman",serif; background:#fff; }
.tbl { border-collapse:collapse; width:100%; }
.tbl td, .tbl th { border:1px solid #999; padding:3px 8px; font-size:12px; }
.hdr { background:#d4ccbc; font-weight:bold; font-size:12px; }
.r1 { background:#fff; } .r2 { background:#f5f0e5; }
a { color:#1a4d2e; }
</style></head><body>
<table class="tbl" cellpadding="0" cellspacing="0">
<tr class="hdr">
  <th>${tenant.labels.shareId}</th>
  <th>${tenant.labels.accountNumber}</th>
  <th>${tenant.labels.accountType}</th>
  <th>${tenant.labels.accountBalance}</th>
</tr>
${rows}
</table>
</body></html>`;
}

function transactionsPage(tenant, memberId, member, acct, session, prefix) {
  let rows = '';
  acct.transactions.forEach((tx, i) => {
    const cls = i % 2 === 0 ? 'r1' : 'r2';
    rows += `<tr class="${cls}">
      <td>${tx.date}</td><td>${tx.desc}</td>
      <td align="right">${tx.debit != null ? formatMoney(tx.debit) : ''}</td>
      <td align="right">${tx.credit != null ? formatMoney(tx.credit) : ''}</td>
    </tr>`;
  });
  // Structurally DIFFERENT from accounts iframe table: dotted borders, dark header,
  // no alternating colors on header, wider layout, inline on page (no iframe)
  return layout(tenant, tenant.labels.transactions, `
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr class="r1"><td style="font-size:12px;padding:4px 0;"><a href="${prefix}/member?q=${memberId}">&laquo; Back to ${tenant.labels.memberDetails}</a></td></tr>
</table>
<img src="${SPACER}" width="1" height="6">
<table class="item" cellpadding="8" cellspacing="0" border="0" width="620">
<tr><td class="hdr" colspan="2">${acct.type} &mdash; ${acct.number}</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Current ${tenant.labels.accountBalance}</td>
    <td style="font-size:12px;font-weight:bold;">${formatMoney(acct.balance)}</td></tr>
<tr class="r2"><td style="font-size:12px;">${tenant.labels.shareId}</td>
    <td style="font-size:12px;">${acct.shareId}</td></tr>
</table>
<img src="${SPACER}" width="1" height="8">
<table width="620" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr style="background:${tenant.themeColor};color:#fff;">
  <th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:left;">Date</th>
  <th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:left;">Description</th>
  <th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:right;">Debit</th>
  <th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:right;">Credit</th>
</tr>
${rows.replace(/class="r[12]"/g, '').replace(/<td/g, '<td style="border:1px dotted #ccc;padding:4px 10px;font-size:12px;"')}
</table>`, session, prefix);
}

function transferFormPage(tenant, memberId, member, session, prefix, error) {
  const errHtml = error ? `<tr><td colspan="2" class="err">${error}</td></tr>` : '';
  let fromOpts = '', toOpts = '';
  for (const a of member.accounts) {
    const label = `${a.type} (${a.number}) - ${formatMoney(a.balance)}`;
    fromOpts += `<option value="${a.number}">${label}</option>`;
    toOpts += `<option value="${a.number}">${label}</option>`;
  }
  return layout(tenant, tenant.labels.transferFunds, `
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
<a href="${prefix}/member?q=${memberId}" style="font-size:11px;">&laquo; Back to ${tenant.labels.memberDetails}</a>
</td></tr></table>
<img src="${SPACER}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="480">
<tr><td class="hdr" colspan="2">${tenant.labels.transferFunds}</td></tr>
${errHtml}
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Member</td>
    <td style="font-size:12px;">${member.name} (${memberId})</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="6"></td></tr>
<form method="POST">
<tr class="r2"><td style="font-size:12px;">From Account</td>
    <td><select class="item" style="font-size:12px;" name="f1">${fromOpts}</select></td></tr>
<tr class="r1"><td style="font-size:12px;">To Account</td>
    <td><select class="item" style="font-size:12px;" name="f2">${toOpts}</select></td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td>
    <td><input type="text" class="item" style="width:120px;font-size:12px;" name="f3"></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Review Transfer</button></td></tr>
</form>
</table>`, session, prefix);
}

function transferReviewPage(tenant, memberId, member, fromAcct, toAcct, amount, session, prefix) {
  return layout(tenant, tenant.labels.transferFunds + ' \u2014 Review', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="480">
<tr><td class="hdr" colspan="2">Review Transfer</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Member</td>
    <td style="font-size:12px;">${member.name} (${memberId})</td></tr>
<tr class="r2"><td style="font-size:12px;">From</td>
    <td style="font-size:12px;">${fromAcct.type} (${fromAcct.number})</td></tr>
<tr class="r1"><td style="font-size:12px;">To</td>
    <td style="font-size:12px;">${toAcct.type} (${toAcct.number})</td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td>
    <td style="font-size:12px;font-weight:bold;">${formatMoney(amount)}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<form method="POST">
<input type="hidden" name="f1" value="${fromAcct.number}">
<input type="hidden" name="f2" value="${toAcct.number}">
<input type="hidden" name="f3" value="${amount}">
<tr><td></td><td><button type="submit" class="btn">Execute Transfer</button></td></tr>
</form>
</table>`, session, prefix);
}

function transferDonePage(tenant, memberId, member, fromAcct, toAcct, amount, refNum, session, prefix) {
  return layout(tenant, 'Transfer Confirmation', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="480">
<tr><td class="hdr" colspan="2">Transfer Complete</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Reference #</td>
    <td style="font-size:12px;font-weight:bold;">${refNum}</td></tr>
<tr class="r2"><td style="font-size:12px;">From</td>
    <td style="font-size:12px;">${fromAcct.type} (${fromAcct.number}) &mdash; new balance: ${formatMoney(fromAcct.balance)}</td></tr>
<tr class="r1"><td style="font-size:12px;">To</td>
    <td style="font-size:12px;">${toAcct.type} (${toAcct.number}) &mdash; new balance: ${formatMoney(toAcct.balance)}</td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td>
    <td style="font-size:12px;">${formatMoney(amount)}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td colspan="2" style="font-size:12px;">
  <a href="${prefix}/member?q=${memberId}">&laquo; Return to ${tenant.labels.memberDetails}</a>
</td></tr>
</table>`, session, prefix);
}

function openSubAccountPage(tenant, memberId, member, session, prefix) {
  return layout(tenant, tenant.labels.openSubAccount, `
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
<a href="${prefix}/member?q=${memberId}" style="font-size:11px;">&laquo; Back to ${tenant.labels.memberDetails}</a>
</td></tr></table>
<img src="${SPACER}" width="1" height="6">
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
</table>`, session, prefix);
}

function confirmationPage(tenant, memberId, member, accountType, acctNum, session, prefix) {
  const typeLabel = SUB_ACCOUNT_TYPES[accountType] || accountType;
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
  <a href="${prefix}/member?q=${memberId}">&laquo; Return to ${tenant.labels.memberDetails}</a>
</td></tr>
</table>`, session, prefix);
}

// ── Interstitial pages (shared by organic + fault paths) ────
// These rendering functions are THE authoritative page for each state.
// Fault injection calls the same function — no separate fault-only pages.

function sessionWarningPage(tenant, session, prefix, returnTo) {
  return layout(tenant, 'Session Warning', `
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<img src="${SPACER}" width="1" height="30">
<table class="item" cellpadding="12" cellspacing="0" border="0" width="400">
<tr><td class="hdr">Session Warning</td></tr>
<tr><td class="warn" style="font-size:13px;">Your session is about to expire.</td></tr>
<tr><td style="font-size:12px;">Click Continue to extend your session, or you will be signed out automatically.</td></tr>
<tr><td><img src="${SPACER}" width="1" height="6"></td></tr>
<form method="POST" action="${prefix}/session-extend">
<input type="hidden" name="returnTo" value="${returnTo}">
<tr><td align="center"><button type="submit" class="btn">Continue</button></td></tr>
</form>
</table>
</td></tr></table>`, session, prefix);
}

function sessionExpiredMessage() {
  return 'Your session has expired. Please sign in again.';
}

function compliancePage(tenant, memberId, member, session, prefix, returnTo, error) {
  const errHtml = error ? `<tr><td class="err">${error}</td></tr>` : '';
  return layout(tenant, 'Compliance Notice', `
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<img src="${SPACER}" width="1" height="20">
<table class="item" cellpadding="12" cellspacing="0" border="0" width="460">
<tr><td class="hdr">Compliance Notice</td></tr>
<tr><td class="warn" style="font-size:13px;"><b>Alert:</b> ${member.alert}</td></tr>
<tr><td style="font-size:12px;">Member: <b>${member.name}</b> (${memberId})</td></tr>
<tr><td style="font-size:12px;">You must acknowledge this notice before accessing this member's records.</td></tr>
${errHtml}
<tr><td><img src="${SPACER}" width="1" height="6"></td></tr>
<form method="POST" action="${prefix}/member/${memberId}/compliance">
<input type="hidden" name="returnTo" value="${returnTo}">
<tr><td style="font-size:12px;"><input type="checkbox" name="ack" value="1" class="item"> I acknowledge this compliance notice</td></tr>
<tr><td><img src="${SPACER}" width="1" height="6"></td></tr>
<tr><td align="center"><button type="submit" class="btn">Continue</button></td></tr>
</form>
</table>
</td></tr></table>`, session, prefix);
}

function privilegeErrorPage(tenant, memberId, session, prefix) {
  return layout(tenant, 'Access Denied', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr">Access Denied</td></tr>
<tr><td style="font-size:12px;">Insufficient privileges &mdash; supervisor approval required</td></tr>
<tr><td><img src="${SPACER}" width="1" height="6"></td></tr>
<tr><td style="font-size:12px;">
  <a href="${prefix}/member?q=${memberId}">&laquo; Return to ${tenant.labels.memberDetails}</a>
</td></tr>
</table>`, session, prefix);
}

function appErrorPage(tenant, session, prefix) {
  return layout(tenant, 'Application Error', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" style="background:#900;color:#fff;">Application Error</td></tr>
<tr><td style="font-size:12px;">An unexpected error has occurred. Please try again later or contact your system administrator.</td></tr>
<tr><td style="font-size:10px;color:#888;">Error reference: ERR-${Date.now()}</td></tr>
</table>`, session, prefix);
}

function deadModulePage(tenant, moduleName, session, prefix) {
  return layout(tenant, moduleName, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr">${moduleName}</td></tr>
<tr><td style="font-size:12px;color:#888;">This module is not available in the current build. Contact your system administrator.</td></tr>
</table>`, session, prefix);
}

// ── Request handler ─────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ── FAULT INJECTION ─────────────────────────────────────
  // ?fault=<type> triggers the same rendering as the organic path.
  // Documented types:
  //   app_error         → 500 error page (uses appErrorPage)
  //   slow&ms=N         → delays response by N ms, then normal handling
  //   session_expired   → forces session-expired redirect to login
  //   session_warning   → forces session-warning interstitial
  //   compliance_prompt → forces compliance interstitial for current member
  const fault = url.searchParams.get('fault');

  // Handle slow fault early (delay, then continue normal handling)
  if (fault === 'slow') {
    const ms = parseInt(url.searchParams.get('ms') || '3000', 10);
    await new Promise(r => setTimeout(r, ms));
  }

  // Match /t/<tenantId>/...
  const tenantMatch = pathname.match(/^\/t\/([^/]+)(\/.*)?$/);
  if (!tenantMatch) {
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
      const expired = url.searchParams.get('expired');
      return respond(res, 200, loginPage(tenant, expired ? sessionExpiredMessage() : null));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const username = body.get('f1') || '';
      const password = body.get('f2') || '';
      const cred = CREDENTIALS[username];
      if (cred && cred.password === password) {
        const sid = crypto.randomBytes(16).toString('hex');
        sessions.set(sid, {
          role: cred.role,
          username,
          createdAt: Date.now(),
          acknowledgedMembers: new Set(),
        });
        return redirect(res, `${prefix}/dashboard`, `sid=${sid}; Path=/; HttpOnly`);
      }
      return respond(res, 200, loginPage(tenant, 'Invalid credentials'));
    }
  }

  // ── Logout ──────────────────────────────────────────────
  if (subpath === '/logout' || subpath === '/logout/') {
    const sid = getCookie(req, 'sid');
    if (sid) sessions.delete(sid);
    return redirect(res, `${prefix}/login`);
  }

  // ── Auth gate ───────────────────────────────────────────
  const session = getSession(req);
  if (!session) {
    return redirect(res, `${prefix}/login`);
  }

  // Check organic session expiry
  if (isExpired(session)) {
    sessions.delete(session.sid);
    return redirect(res, `${prefix}/login?expired=1`);
  }

  // ── Fault: app_error ────────────────────────────────────
  if (fault === 'app_error') {
    return respond(res, 500, appErrorPage(tenant, session, prefix));
  }

  // ── Fault: session_expired ──────────────────────────────
  if (fault === 'session_expired') {
    sessions.delete(session.sid);
    return redirect(res, `${prefix}/login?expired=1`);
  }

  // ── Fault: session_warning ──────────────────────────────
  if (fault === 'session_warning') {
    const cleanUrl = pathname + (url.search ? url.search.replace(/[?&]fault=session_warning/, '') : '');
    return respond(res, 200, sessionWarningPage(tenant, session, prefix, cleanUrl || prefix + '/dashboard'));
  }

  // ── Session warning (organic, GET only, skip iframes) ───
  const skipWarning = subpath.endsWith('/accounts') || subpath === '/session-extend';
  if (req.method === 'GET' && !skipWarning && isNearExpiry(session)) {
    return respond(res, 200, sessionWarningPage(tenant, session, prefix, pathname + url.search));
  }

  // ── Session extend handler ──────────────────────────────
  if (subpath === '/session-extend' && req.method === 'POST') {
    const body = await parseBody(req);
    const s = sessions.get(session.sid);
    if (s) s.createdAt = Date.now();
    return redirect(res, body.get('returnTo') || `${prefix}/dashboard`);
  }

  // ── Resolve active member (for compliance + role checks) ─
  let activeMemberId = null;
  if (subpath === '/member' || subpath === '/member/') {
    activeMemberId = url.searchParams.get('q');
  } else {
    const m = subpath.match(/^\/member\/([^/]+)/);
    if (m) activeMemberId = m[1];
  }

  // ── Compliance interstitial ─────────────────────────────
  if (activeMemberId) {
    const member = MEMBERS[activeMemberId];

    // POST handler for compliance acknowledgment
    const complianceMatch = subpath.match(/^\/member\/([^/]+)\/compliance$/);
    if (complianceMatch && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.get('ack')) {
        return respond(res, 200, compliancePage(tenant, activeMemberId, member, session, prefix,
          body.get('returnTo') || `${prefix}/member?q=${activeMemberId}`, 'You must check the acknowledgment box'));
      }
      const s = sessions.get(session.sid);
      if (s) s.acknowledgedMembers.add(activeMemberId);
      return redirect(res, body.get('returnTo') || `${prefix}/member?q=${activeMemberId}`);
    }

    // Fault: compliance_prompt (force compliance regardless of state)
    if (fault === 'compliance_prompt' && member && member.alert) {
      const cleanUrl = pathname + (url.search ? url.search.replace(/[?&]fault=compliance_prompt/, '') : '');
      return respond(res, 200, compliancePage(tenant, activeMemberId, member, session, prefix, cleanUrl));
    }

    // Organic compliance check (GET only, skip iframes and compliance page itself)
    if (member && member.alert && req.method === 'GET'
        && !subpath.endsWith('/accounts') && !subpath.endsWith('/compliance')
        && !session.acknowledgedMembers.has(activeMemberId)) {
      // Retrieve the live session's Set (session obj is a spread copy)
      const s = sessions.get(session.sid);
      if (s && !s.acknowledgedMembers.has(activeMemberId)) {
        return respond(res, 200, compliancePage(tenant, activeMemberId, member, session, prefix, pathname + url.search));
      }
    }

    // ── Role check: restricted members ────────────────────
    const isRestricted = member && member.alert && member.alert.toLowerCase().includes('restricted');
    if (isRestricted && session.role === 'operator') {
      if (subpath.match(/\/(open-sub-account|transfer)/)) {
        return respond(res, 200, privilegeErrorPage(tenant, activeMemberId, session, prefix));
      }
    }
  }

  // ── Dashboard ───────────────────────────────────────────
  if (subpath === '/dashboard' || subpath === '/dashboard/' || subpath === '/') {
    return respond(res, 200, dashboardPage(tenant, session, prefix));
  }

  // ── Dead module pages (nav traps) ───────────────────────
  if (subpath === '/reports') return respond(res, 200, deadModulePage(tenant, tenant.labels.reports, session, prefix));
  if (subpath === '/settings') return respond(res, 200, deadModulePage(tenant, tenant.labels.settings, session, prefix));
  if (subpath === '/audit') return respond(res, 200, deadModulePage(tenant, tenant.labels.auditLog, session, prefix));

  // ── Search ──────────────────────────────────────────────
  if (subpath === '/search' || subpath === '/search/') {
    if (req.method === 'GET') {
      return respond(res, 200, searchPage(tenant, session, prefix));
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
    if (!member) return respond(res, 200, notFoundPage(tenant, session, prefix));
    return respond(res, 200, memberPage(tenant, memberId, member, session, prefix));
  }

  // ── Accounts iframe content ─────────────────────────────
  const accountsMatch = subpath.match(/^\/member\/([^/]+)\/accounts$/);
  if (accountsMatch) {
    const memberId = accountsMatch[1];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    return respond(res, 200, accountsFrame(tenant, memberId, member, prefix));
  }

  // ── Transactions ────────────────────────────────────────
  const txMatch = subpath.match(/^\/member\/([^/]+)\/account\/([^/]+)\/transactions$/);
  if (txMatch) {
    const memberId = txMatch[1];
    const acctNum = txMatch[2];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    const acct = findAccount(member, acctNum);
    if (!acct) return respond(res, 404, 'Account not found');
    return respond(res, 200, transactionsPage(tenant, memberId, member, acct, session, prefix));
  }

  // ── Transfer ────────────────────────────────────────────
  const transferMatch = subpath.match(/^\/member\/([^/]+)\/transfer$/);
  if (transferMatch) {
    const memberId = transferMatch[1];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');

    if (req.method === 'GET') {
      return respond(res, 200, transferFormPage(tenant, memberId, member, session, prefix, null));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const fromNum = body.get('f1') || '';
      const toNum = body.get('f2') || '';
      const amtStr = (body.get('f3') || '').trim();
      const amount = parseFloat(amtStr);

      // Validation
      if (!amtStr || isNaN(amount) || amount <= 0) {
        return respond(res, 200, transferFormPage(tenant, memberId, member, session, prefix,
          'Please enter a valid positive amount'));
      }
      const fromAcct = findAccount(member, fromNum);
      const toAcct = findAccount(member, toNum);
      if (!fromAcct || !toAcct) {
        return respond(res, 200, transferFormPage(tenant, memberId, member, session, prefix,
          'Invalid account selection'));
      }
      if (fromNum === toNum) {
        return respond(res, 200, transferFormPage(tenant, memberId, member, session, prefix,
          'From and To accounts must be different'));
      }
      if (amount > fromAcct.balance) {
        return respond(res, 200, transferFormPage(tenant, memberId, member, session, prefix,
          'Insufficient funds: transfer amount exceeds available balance'));
      }

      return redirect(res, `${prefix}/member/${memberId}/transfer/review?from=${encodeURIComponent(fromNum)}&to=${encodeURIComponent(toNum)}&amount=${amount}`);
    }
  }

  // ── Transfer review ─────────────────────────────────────
  const reviewMatch = subpath.match(/^\/member\/([^/]+)\/transfer\/review$/);
  if (reviewMatch) {
    const memberId = reviewMatch[1];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');

    if (req.method === 'GET') {
      const fromNum = url.searchParams.get('from') || '';
      const toNum = url.searchParams.get('to') || '';
      const amount = parseFloat(url.searchParams.get('amount') || '0');
      const fromAcct = findAccount(member, fromNum);
      const toAcct = findAccount(member, toNum);
      if (!fromAcct || !toAcct || amount <= 0) {
        return redirect(res, `${prefix}/member/${memberId}/transfer`);
      }
      return respond(res, 200, transferReviewPage(tenant, memberId, member, fromAcct, toAcct, amount, session, prefix));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const fromNum = body.get('f1') || '';
      const toNum = body.get('f2') || '';
      const amount = parseFloat(body.get('f3') || '0');
      const fromAcct = findAccount(member, fromNum);
      const toAcct = findAccount(member, toNum);
      if (!fromAcct || !toAcct || amount <= 0 || fromNum === toNum) {
        return redirect(res, `${prefix}/member/${memberId}/transfer`);
      }
      if (amount > fromAcct.balance) {
        return redirect(res, `${prefix}/member/${memberId}/transfer`);
      }

      // ── STATE MUTATION: real transfer ───────────────────
      fromAcct.balance = Math.round((fromAcct.balance - amount) * 100) / 100;
      toAcct.balance = Math.round((toAcct.balance + amount) * 100) / 100;
      const dateStr = today();
      fromAcct.transactions.push({ date: dateStr, desc: `Transfer to ${toAcct.type} (${toAcct.number})`, debit: amount, credit: null });
      toAcct.transactions.push({ date: dateStr, desc: `Transfer from ${fromAcct.type} (${fromAcct.number})`, debit: null, credit: amount });

      const refNum = `REF-${nextRefSeq++}`;
      return redirect(res, `${prefix}/member/${memberId}/transfer/done?ref=${refNum}&amount=${amount}&from=${encodeURIComponent(fromNum)}&to=${encodeURIComponent(toNum)}`);
    }
  }

  // ── Transfer done ───────────────────────────────────────
  const doneMatch = subpath.match(/^\/member\/([^/]+)\/transfer\/done$/);
  if (doneMatch) {
    const memberId = doneMatch[1];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    const refNum = url.searchParams.get('ref') || '';
    const amount = parseFloat(url.searchParams.get('amount') || '0');
    const fromAcct = findAccount(member, url.searchParams.get('from') || '');
    const toAcct = findAccount(member, url.searchParams.get('to') || '');
    if (!fromAcct || !toAcct) return redirect(res, `${prefix}/member?q=${memberId}`);
    return respond(res, 200, transferDonePage(tenant, memberId, member, fromAcct, toAcct, amount, refNum, session, prefix));
  }

  // ── Open sub-account ────────────────────────────────────
  const subAcctMatch = subpath.match(/^\/member\/([^/]+)\/open-sub-account$/);
  if (subAcctMatch) {
    const memberId = subAcctMatch[1];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');

    if (req.method === 'GET') {
      return respond(res, 200, openSubAccountPage(tenant, memberId, member, session, prefix));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const accountType = body.get('f1') || 'holiday-club';
      const acctNum = `${memberId}-N${nextAcctSeq++}`;
      const shareId = `N${String(member.accounts.length).padStart(2, '0')}`;
      const typeLabel = SUB_ACCOUNT_TYPES[accountType] || accountType;

      // ── STATE MUTATION: persist new account ─────────────
      member.accounts.push({
        type: typeLabel,
        number: acctNum,
        shareId,
        balance: 0,
        transactions: [
          { date: today(), desc: `${typeLabel} account opened`, debit: null, credit: null },
        ],
      });

      return redirect(res, `${prefix}/member/${memberId}/confirmation?type=${encodeURIComponent(accountType)}&acctNum=${encodeURIComponent(acctNum)}`);
    }
  }

  // ── Sub-account confirmation ────────────────────────────
  const confirmMatch = subpath.match(/^\/member\/([^/]+)\/confirmation$/);
  if (confirmMatch) {
    const memberId = confirmMatch[1];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    const accountType = url.searchParams.get('type') || '';
    const acctNum = url.searchParams.get('acctNum') || '';
    return respond(res, 200, confirmationPage(tenant, memberId, member, accountType, acctNum, session, prefix));
  }

  // ── Fallback ────────────────────────────────────────────
  respond(res, 404, layout(tenant, 'Not Found', '<p class="err">Page not found</p>', session, prefix));
}

// ── Start ───────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Mock console listening on http://localhost:${PORT}`);
  console.log(`Tenants: ${Object.keys(tenants).join(', ')}`);
  console.log(`Session TTL: ${SESSION_TTL_MS}ms`);
});

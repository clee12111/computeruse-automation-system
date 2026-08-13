// mock-console/server.js — Quarantined mock legacy bank console.
// Zero imports from ../src. Zero runtime dependencies. Plain Node http.
// Deliberately hostile UI: table layouts, iframes, no IDs, no labels, generic classes.
// Jank: loans use DD-MMM-YYYY dates, some ALL-CAPS labels, different loan table styles.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  CREDENTIALS, SUB_ACCOUNT_TYPES, MEMBERS,
  auditLog, addAudit,
  findAccount, findLoan, searchByLastName,
  totalShares, todayTxCount,
  getNextAcctNum, getNextRef, getNextLoanPayRef,
} = require('./data');

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
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Session store ───────────────────────────────────────────
const sessions = new Map();

function getSession(req) {
  const sid = getCookie(req, 'sid');
  if (!sid) return null;
  const s = sessions.get(sid);
  return s ? { sid, ...s } : null;
}
function isExpired(session) { return Date.now() - session.createdAt > SESSION_TTL_MS; }
function isNearExpiry(session) { return Date.now() - session.createdAt > SESSION_TTL_MS * 0.8; }

// ── Helpers ─────────────────────────────────────────────────
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
function nowTimestamp() {
  return new Date().toLocaleString('en-US');
}
// Loan dates: DD-MMM-YYYY (jank: different team built this module)
function formatLoanDate(dateStr) {
  if (!dateStr) return '';
  const [m, d, y] = dateStr.split('/');
  return `${d}-${MONTHS[parseInt(m, 10) - 1]}-${y}`;
}
function parseDateForFilter(dateStr) {
  const [m, d, y] = dateStr.split('/');
  return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
}

// ── HTML templates ──────────────────────────────────────────

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
        <a href="${prefix}/audit">${tenant.labels.auditLog}</a></td></tr>
      </table>
      <img src="${SPACER}" width="150" height="1">
    </td>` : '';

  const welcomeHtml = session
    ? `<td align="right" style="font-size:11px;padding-right:12px;">Welcome, <b>${session.username}</b>&nbsp;|&nbsp;<a href="${prefix}/logout" style="color:#ccc;">Sign Off</a></td>`
    : '';

  return `<!DOCTYPE html>
<html><head><title>${title} - ${tenant.name}</title>
<style>
body{margin:0;padding:0;font-family:"Times New Roman",serif;background:${tenant.themeBg};color:#222}
.c1{background:${tenant.themeColor};color:#fff;padding:6px 12px;font-size:18px}
.c2{font-size:11px;color:#ccc}.c3{background:#e8e0d0;padding:4px 8px;font-size:11px;border-bottom:1px solid #bbb}
.box{padding:12px}.item{border:1px solid #999;background:#fff}
.hdr{background:#d4ccbc;font-weight:bold;padding:4px 6px;font-size:12px}
.r1{background:#fff}.r2{background:#f5f0e5}
.tbl{border-collapse:collapse}.tbl td,.tbl th{border:1px solid #999;padding:3px 8px;font-size:12px}
.btn{background:${tenant.themeColor};color:#fff;border:1px outset #888;padding:3px 14px;font-size:12px;cursor:pointer;font-family:inherit}
.err{color:#900;font-size:12px}
.warn{background:#fff3cd;border:1px solid #d4a017;padding:6px 10px;font-size:12px;margin-bottom:8px}
.ok{background:#d4edda;border:1px solid #28a745;padding:6px 10px;font-size:12px;margin-bottom:8px}
a{color:${tenant.themeColor}}
.lt{border-collapse:collapse}.lt td,.lt th{border:1px solid #666;padding:4px 8px;font-size:11px}
.lh{background:#334;color:#eee;font-size:11px;text-transform:uppercase;letter-spacing:1px}
.lr1{background:#f8f8f8}.lr2{background:#eef}
</style></head><body>
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="c1" colspan="3">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td><img src="${SPACER}" width="1" height="36" style="visibility:hidden;border:0"></td>
    <td width="50%"><b>${tenant.name}</b>&nbsp;&mdash;&nbsp;${tenant.labels.operatorConsole}
      <br><span class="c2">v3.2.1-legacy &bull; Session active</span></td>
    ${welcomeHtml}
  </tr></table>
</td></tr>
<tr><td colspan="3"><img src="${SPACER}" width="1" height="2"></td></tr>
<tr><td colspan="3" class="c3">&nbsp;Home&nbsp;&gt;&nbsp;${title}</td></tr>
<tr><td colspan="3"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr>${navHtml}<td valign="top" class="box">${bodyContent}</td></tr>
<tr><td colspan="3"><img src="${SPACER}" width="1" height="1" style="display:block;background:#999"></td></tr>
<tr><td colspan="3" style="font-size:10px;color:#888;padding:4px 8px;">
  &copy; ${tenant.name} &bull; Internal Use Only &bull; Unauthorized access prohibited
  <br><span style="font-size:9px;color:#bbb;">Best viewed in Internet Explorer 6</span>
</td></tr>
</table>
</body></html>`;
}

function loginPage(tenant, message) {
  const msgHtml = message
    ? `<tr><td colspan="2" class="${message.includes('expired') ? 'warn' : 'err'}">${message}</td></tr>` : '';
  return layout(tenant, tenant.labels.signIn, `
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<img src="${SPACER}" width="1" height="30">
<table class="item" cellpadding="12" cellspacing="0" border="0" width="340">
<tr><td class="hdr" colspan="2">${tenant.labels.signIn}</td></tr>
${msgHtml}
<tr><td colspan="2"><img src="${SPACER}" width="1" height="6"></td></tr>
<form method="POST">
<tr class="r1"><td width="120" style="font-size:12px;">Username</td>
    <td><input type="text" name="f1" class="item" style="width:150px;font-size:12px"></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr class="r1"><td style="font-size:12px;">Password</td>
    <td><input type="password" name="f2" class="item" style="width:150px;font-size:12px"></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td></td><td><button type="submit" class="btn">${tenant.labels.signIn}</button></td></tr>
</form></table></td></tr></table>`, null, '');
}

function dashboardPage(tenant, session, prefix) {
  const mc = Object.keys(MEMBERS).length;
  const ts = totalShares();
  const tc = todayTxCount();
  const last5 = auditLog.slice(0, 5);
  let auditRows = '';
  last5.forEach((e, i) => {
    const cls = i % 2 === 0 ? 'r1' : 'r2';
    auditRows += `<tr class="${cls}"><td style="font-size:11px;">${e.timestamp}</td>
      <td style="font-size:11px;">${e.operator}</td><td style="font-size:11px;">${e.action}</td>
      <td style="font-size:11px;">${e.memberId}</td></tr>`;
  });
  if (!last5.length) auditRows = '<tr class="r1"><td colspan="4" style="font-size:11px;color:#888;">No entries yet</td></tr>';
  return layout(tenant, tenant.labels.dashboard, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="580">
<tr><td class="hdr" colspan="4">${tenant.labels.dashboard}</td></tr>
<tr><td colspan="4"><img src="${SPACER}" width="1" height="6"></td></tr>
<tr class="r1"><td colspan="4" style="font-size:13px;">Welcome, <b>${session.username}</b>.</td></tr>
<tr><td colspan="4"><img src="${SPACER}" width="1" height="6"></td></tr>
<tr class="r2">
  <td style="font-size:12px;text-align:center;"><b>${mc}</b><br><span style="font-size:10px;color:#666;">Members</span></td>
  <td style="font-size:12px;text-align:center;"><b>${formatMoney(ts)}</b><br><span style="font-size:10px;color:#666;">Total Shares</span></td>
  <td style="font-size:12px;text-align:center;" colspan="2"><b>${tc}</b><br><span style="font-size:10px;color:#666;">Today's Transactions</span></td>
</tr>
<tr><td colspan="4"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td colspan="4" class="hdr">Recent Activity</td></tr>
${auditRows}
<tr><td colspan="4"><img src="${SPACER}" width="1" height="6"></td></tr>
<tr class="r1"><td colspan="2"><a href="${prefix}/search">${tenant.labels.search}</a></td>
  <td colspan="2"><a href="${prefix}/audit">${tenant.labels.auditLog}</a></td></tr>
</table>`, session, prefix);
}

function searchPage(tenant, session, prefix) {
  return layout(tenant, tenant.labels.search, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="460">
<tr><td class="hdr" colspan="2">${tenant.labels.search}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="6"></td></tr>
<form method="POST">
<tr class="r1"><td width="140" style="font-size:12px;">${tenant.labels.memberNumber}</td>
  <td><input type="text" class="item" style="width:140px;font-size:12px" name="f1"></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr class="r2"><td style="font-size:12px;">${tenant.labels.lastName}</td>
  <td><input type="text" class="item" style="width:140px;font-size:12px" name="f2"></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td></td><td><button type="submit" class="btn">${tenant.labels.search}</button></td></tr>
</form></table>`, session, prefix);
}

function searchResultsPage(tenant, results, query, session, prefix) {
  if (!results.length) {
    return layout(tenant, tenant.labels.searchResults, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="460">
<tr><td class="hdr">${tenant.labels.searchResults}</td></tr>
<tr class="r1"><td style="font-size:12px;">No member matches</td></tr>
<tr><td><a href="${prefix}/search" style="font-size:11px">&laquo; Back</a></td></tr>
</table>`, session, prefix);
  }
  let rows = '';
  results.forEach((r, i) => {
    const cls = i % 2 === 0 ? 'r1' : 'r2';
    rows += `<tr class="${cls}"><td style="font-size:12px;"><a href="${prefix}/member?q=${r.id}">${r.id}</a></td>
      <td style="font-size:12px;">${r.member.name}</td>
      <td style="font-size:12px;">${r.member.address ? r.member.address.city : ''}</td></tr>`;
  });
  return layout(tenant, tenant.labels.searchResults, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="520">
<tr><td class="hdr" colspan="3">${tenant.labels.searchResults} &mdash; "${query}"</td></tr>
<tr class="r2"><th style="font-size:11px;text-align:left;">${tenant.labels.memberNumber}</th>
  <th style="font-size:11px;text-align:left;">${tenant.labels.name}</th>
  <th style="font-size:11px;text-align:left;">${tenant.labels.city}</th></tr>
${rows}
<tr><td colspan="3"><a href="${prefix}/search" style="font-size:11px">&laquo; New Search</a></td></tr>
</table>`, session, prefix);
}

function notFoundPage(tenant, session, prefix) {
  return layout(tenant, tenant.labels.search, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="420">
<tr><td class="hdr">${tenant.labels.search}</td></tr>
<tr class="r1"><td style="font-size:12px;">No member matches</td></tr>
<tr><td><a href="${prefix}/search" style="font-size:11px">&laquo; Back</a></td></tr>
</table>`, session, prefix);
}

function memberPage(tenant, memberId, member, session, prefix, banner) {
  const L = tenant.labels;
  const alertHtml = member.alert
    ? `<tr><td colspan="2"><table width="100%" cellpadding="0" cellspacing="0" border="0">
       <tr><td class="warn"><b>Alert:</b> ${member.alert}</td></tr></table></td></tr>` : '';
  const bannerHtml = banner ? `<tr><td colspan="2" class="ok">${banner}</td></tr>` : '';
  const jointHtml = member.jointWith
    ? `<tr class="r1"><td style="font-size:12px;">${L.jointOwner}</td>
       <td style="font-size:12px;"><a href="${prefix}/member?q=${member.jointWith.memberId}">${member.jointWith.name} (${member.jointWith.memberId})</a></td></tr>` : '';
  const addr = member.address || {};

  // Loans section (styled differently — jank: different team, different classnames)
  let loanRows = '';
  if (member.loans && member.loans.length) {
    member.loans.forEach((ln, i) => {
      const cls = i % 2 === 0 ? 'lr1' : 'lr2';
      loanRows += `<tr class="${cls}">
        <td><a href="${prefix}/member/${memberId}/loan/${ln.loanId}">${ln.loanId}</a></td>
        <td>${ln.type}</td><td align="right">${formatMoney(ln.balance)}</td>
        <td>${formatLoanDate(ln.nextPaymentDue)}</td></tr>`;
    });
  }
  const loansHtml = member.loans && member.loans.length ? `
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td colspan="2" class="hdr">${L.loans}</td></tr>
<tr><td colspan="2" style="padding:2px;">
<table class="lt" width="100%" cellpadding="0" cellspacing="0">
<tr class="lh"><th>${L.loanId}</th><th>${L.loanType}</th><th>${L.loanBalance}</th><th>${L.nextPayment}</th></tr>
${loanRows}
</table></td></tr>` : '';

  return layout(tenant, L.memberDetails, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="640">
<tr><td class="hdr" colspan="2">${L.memberDetails}</td></tr>
${bannerHtml}${alertHtml}
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">${L.name}</td>
    <td style="font-size:12px;">${member.name}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.memberNumber}</td>
    <td style="font-size:12px;">${memberId}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.dateOfBirth}</td>
    <td style="font-size:12px;">${member.dob}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.ssn}</td>
    <td style="font-size:12px;">***-**-${member.ssnLast4 || '0000'}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.address}</td>
    <td style="font-size:12px;">${addr.street || ''}, ${addr.city || ''}, ${addr.state || ''} ${addr.zip || ''}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.phone}</td>
    <td style="font-size:12px;">${member.phone}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.email}</td>
    <td style="font-size:12px;">${member.email || ''}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.memberSince}</td>
    <td style="font-size:12px;">${member.memberSince || ''}</td></tr>
${jointHtml}
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td colspan="2" class="hdr">Accounts</td></tr>
<tr><td colspan="2" style="padding:0;">
  <iframe src="${prefix}/member/${memberId}/accounts" width="100%" height="200"
    frameborder="1" scrolling="auto" class="box"></iframe>
</td></tr>
${loansHtml}
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td>
  <a href="${prefix}/member/${memberId}/open-sub-account" class="btn" style="text-decoration:none;display:inline-block;">${L.openSubAccount}</a>
  &nbsp;<a href="${prefix}/member/${memberId}/transfer" class="btn" style="text-decoration:none;display:inline-block;">${L.transferFunds}</a>
</td><td>
  <a href="${prefix}/member/${memberId}/update-contact" class="btn" style="text-decoration:none;display:inline-block;">${L.updateContact}</a>
  &nbsp;<a href="${prefix}/member/${memberId}/notes" class="btn" style="text-decoration:none;display:inline-block;">${L.memberNotes}</a>
</td></tr>
</table>`, session, prefix);
}

function accountsFrame(tenant, memberId, member, prefix) {
  let rows = '';
  member.accounts.forEach((acct, i) => {
    const cls = i % 2 === 0 ? 'r1' : 'r2';
    rows += `<tr class="${cls}">
      <td>${acct.shareId}</td>
      <td><a href="${prefix}/member/${memberId}/account/${acct.number}" target="_parent">${acct.number}</a></td>
      <td>${acct.type}</td><td align="right">${formatMoney(acct.balance)}</td></tr>`;
  });
  return `<!DOCTYPE html><html><head><style>
body{margin:0;padding:0;font-family:"Times New Roman",serif;background:#fff}
.tbl{border-collapse:collapse;width:100%}.tbl td,.tbl th{border:1px solid #999;padding:3px 8px;font-size:12px}
.hdr{background:#d4ccbc;font-weight:bold;font-size:12px}
.r1{background:#fff}.r2{background:#f5f0e5}a{color:#1a4d2e}
</style></head><body>
<table class="tbl" cellpadding="0" cellspacing="0">
<tr class="hdr"><th>${tenant.labels.shareId}</th><th>${tenant.labels.accountNumber}</th>
  <th>${tenant.labels.accountType}</th><th>${tenant.labels.accountBalance}</th></tr>
${rows}</table></body></html>`;
}

function shareDetailPage(tenant, memberId, member, acct, session, prefix) {
  const L = tenant.labels;
  return layout(tenant, L.shareDetails, `
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
<a href="${prefix}/member?q=${memberId}" style="font-size:11px">&laquo; Back to ${L.memberDetails}</a>
</td></tr></table><img src="${SPACER}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">${L.shareDetails} &mdash; ${acct.type}</td></tr>
<tr class="r1"><td style="font-size:12px;" width="160">${L.accountNumber}</td><td style="font-size:12px;">${acct.number}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.shareId}</td><td style="font-size:12px;">${acct.shareId}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.accountBalance}</td><td style="font-size:12px;font-weight:bold;">${formatMoney(acct.balance)}</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.availableBalance}</td><td style="font-size:12px;">${formatMoney(acct.available)}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.dividendRate}</td><td style="font-size:12px;">${acct.dividendRate}%</td></tr>
<tr class="r2"><td style="font-size:12px;">${L.openedDate}</td><td style="font-size:12px;">${acct.opened}</td></tr>
<tr class="r1"><td style="font-size:12px;">${L.accountStatus}</td><td style="font-size:12px;">${acct.status}</td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="6"></td></tr>
<tr><td colspan="2"><a href="${prefix}/member/${memberId}/account/${acct.number}/transactions" class="btn" style="text-decoration:none;display:inline-block;">View ${L.transactions}</a></td></tr>
</table>`, session, prefix);
}

function transactionsPage(tenant, memberId, member, acct, txs, page, totalPages, filterFrom, filterTo, session, prefix) {
  const L = tenant.labels;
  let rows = '';
  txs.forEach((tx, i) => {
    rows += `<tr><td style="border:1px dotted #ccc;padding:4px 10px;font-size:12px;">${tx.date}</td>
      <td style="border:1px dotted #ccc;padding:4px 10px;font-size:12px;">${tx.desc}</td>
      <td style="border:1px dotted #ccc;padding:4px 10px;font-size:12px;" align="right">${tx.debit != null ? formatMoney(tx.debit) : ''}</td>
      <td style="border:1px dotted #ccc;padding:4px 10px;font-size:12px;" align="right">${tx.credit != null ? formatMoney(tx.credit) : ''}</td></tr>`;
  });
  const baseUrl = `${prefix}/member/${memberId}/account/${acct.number}/transactions`;
  const filterQs = (filterFrom ? `&from=${encodeURIComponent(filterFrom)}` : '') + (filterTo ? `&to=${encodeURIComponent(filterTo)}` : '');
  const prevLink = page > 1 ? `<a href="${baseUrl}?page=${page - 1}${filterQs}">Prev</a>` : '<span style="color:#ccc;">Prev</span>';
  const nextLink = page < totalPages ? `<a href="${baseUrl}?page=${page + 1}${filterQs}">Next</a>` : '<span style="color:#ccc;">Next</span>';

  return layout(tenant, L.transactions, `
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
<a href="${prefix}/member/${memberId}/account/${acct.number}" style="font-size:11px">&laquo; Back to ${L.shareDetails}</a>
</td></tr></table><img src="${SPACER}" width="1" height="6">
<table class="item" cellpadding="8" cellspacing="0" border="0" width="640">
<tr><td class="hdr" colspan="2">${acct.type} &mdash; ${acct.number}</td></tr>
<tr class="r1"><td style="font-size:12px;" width="160">Current ${L.accountBalance}</td>
    <td style="font-size:12px;font-weight:bold;">${formatMoney(acct.balance)}</td></tr>
</table><img src="${SPACER}" width="1" height="6">
<table class="item" cellpadding="6" cellspacing="0" border="0" width="640">
<tr><td class="hdr" colspan="4">Date Filter</td></tr>
<form method="GET" action="${baseUrl}">
<tr class="r1"><td style="font-size:11px;">From</td>
  <td><input type="text" name="from" value="${filterFrom || ''}" class="item" style="width:90px;font-size:11px" placeholder="MM/DD/YYYY"></td>
  <td style="font-size:11px;">To</td>
  <td><input type="text" name="to" value="${filterTo || ''}" class="item" style="width:90px;font-size:11px" placeholder="MM/DD/YYYY">
    &nbsp;<button type="submit" class="btn" style="padding:2px 8px;">Filter</button></td>
</tr></form></table><img src="${SPACER}" width="1" height="4">
<table width="640" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr style="background:${tenant.themeColor};color:#fff;">
  <th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:left;">Date</th>
  <th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:left;">Description</th>
  <th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:right;">Debit</th>
  <th style="border:1px dotted #666;padding:5px 10px;font-size:12px;text-align:right;">Credit</th>
</tr>${rows}</table>
<table width="640" cellpadding="4" cellspacing="0" border="0">
<tr><td style="font-size:11px;">${prevLink} &nbsp; Page ${page} of ${totalPages} &nbsp; ${nextLink}</td></tr>
</table>`, session, prefix);
}

function transferFormPage(tenant, memberId, member, session, prefix, error) {
  const errHtml = error ? `<tr><td colspan="2" class="err">${error}</td></tr>` : '';
  let opts = '';
  for (const a of member.accounts) {
    opts += `<option value="${a.number}">${a.type} (${a.number}) - ${formatMoney(a.balance)}</option>`;
  }
  return layout(tenant, tenant.labels.transferFunds, `
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
<a href="${prefix}/member?q=${memberId}" style="font-size:11px">&laquo; Back to ${tenant.labels.memberDetails}</a>
</td></tr></table><img src="${SPACER}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">${tenant.labels.transferFunds}</td></tr>
${errHtml}
<tr><td colspan="2"><img src="${SPACER}" width="1" height="4"></td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Member</td><td style="font-size:12px;">${member.name} (${memberId})</td></tr>
<form method="POST">
<tr class="r2"><td style="font-size:12px;">From Account</td><td><select class="item" style="font-size:12px" name="f1">${opts}</select></td></tr>
<tr class="r1"><td style="font-size:12px;">To Account</td><td><select class="item" style="font-size:12px" name="f2">${opts}</select></td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td><input type="text" class="item" style="width:120px;font-size:12px" name="f3"></td></tr>
<tr class="r1"><td style="font-size:12px;">${tenant.labels.memo}</td><td><input type="text" class="item" style="width:200px;font-size:12px" name="f4"></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Review Transfer</button></td></tr>
</form></table>`, session, prefix);
}

function transferReviewPage(tenant, memberId, member, fromAcct, toAcct, amount, memo, session, prefix) {
  const memoRow = memo ? `<tr class="r1"><td style="font-size:12px;">${tenant.labels.memo}</td><td style="font-size:12px;">${memo}</td></tr>` : '';
  return layout(tenant, tenant.labels.transferFunds + ' \u2014 Review', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">Review Transfer</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Member</td><td style="font-size:12px;">${member.name} (${memberId})</td></tr>
<tr class="r2"><td style="font-size:12px;">From</td><td style="font-size:12px;">${fromAcct.type} (${fromAcct.number})</td></tr>
<tr class="r1"><td style="font-size:12px;">To</td><td style="font-size:12px;">${toAcct.type} (${toAcct.number})</td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td style="font-size:12px;font-weight:bold;">${formatMoney(amount)}</td></tr>
${memoRow}
<form method="POST">
<input type="hidden" name="f1" value="${fromAcct.number}">
<input type="hidden" name="f2" value="${toAcct.number}">
<input type="hidden" name="f3" value="${amount}">
<input type="hidden" name="f4" value="${memo || ''}">
<tr><td></td><td><button type="submit" class="btn">Execute Transfer</button></td></tr>
</form></table>`, session, prefix);
}

function transferDonePage(tenant, memberId, member, fromAcct, toAcct, amount, memo, refNum, session, prefix) {
  const memoRow = memo ? `<tr class="r1"><td style="font-size:12px;">${tenant.labels.memo}</td><td style="font-size:12px;">${memo}</td></tr>` : '';
  return layout(tenant, 'Transfer Confirmation', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">Transfer Complete</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Reference #</td><td style="font-size:12px;font-weight:bold;">${refNum}</td></tr>
<tr class="r2"><td style="font-size:12px;">From</td><td style="font-size:12px;">${fromAcct.type} (${fromAcct.number}) &mdash; new balance: ${formatMoney(fromAcct.balance)}</td></tr>
<tr class="r1"><td style="font-size:12px;">To</td><td style="font-size:12px;">${toAcct.type} (${toAcct.number}) &mdash; new balance: ${formatMoney(toAcct.balance)}</td></tr>
<tr class="r2"><td style="font-size:12px;">Amount</td><td style="font-size:12px;">${formatMoney(amount)}</td></tr>
${memoRow}
<tr><td colspan="2"><a href="${prefix}/member?q=${memberId}">&laquo; Return to ${tenant.labels.memberDetails}</a></td></tr>
</table>`, session, prefix);
}

function openSubAccountPage(tenant, memberId, member, session, prefix) {
  return layout(tenant, tenant.labels.openSubAccount, `
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
<a href="${prefix}/member?q=${memberId}" style="font-size:11px">&laquo; Back</a>
</td></tr></table><img src="${SPACER}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">${tenant.labels.openSubAccount}</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Member</td><td style="font-size:12px;">${member.name} (${memberId})</td></tr>
<form method="POST">
<tr class="r2"><td style="font-size:12px;">Account Type</td>
    <td><select class="item" style="font-size:12px" name="f1">
      <option value="holiday-club">Holiday Club</option>
      <option value="money-market">Money Market</option>
      <option value="secondary-savings">Secondary Savings</option>
    </select></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Open Account</button></td></tr>
</form></table>`, session, prefix);
}

function confirmationPage(tenant, memberId, member, accountType, acctNum, session, prefix) {
  return layout(tenant, 'Confirmation', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" colspan="2">Account Opened</td></tr>
<tr class="r1"><td style="font-size:12px;" width="140">Member</td><td style="font-size:12px;">${member.name} (${memberId})</td></tr>
<tr class="r2"><td style="font-size:12px;">Account Type</td><td style="font-size:12px;">${SUB_ACCOUNT_TYPES[accountType] || accountType}</td></tr>
<tr class="r1"><td style="font-size:12px;">New Account #</td><td style="font-size:12px;">${acctNum}</td></tr>
<tr><td colspan="2"><a href="${prefix}/member?q=${memberId}">&laquo; Return to ${tenant.labels.memberDetails}</a></td></tr>
</table>`, session, prefix);
}

function updateContactPage(tenant, memberId, member, session, prefix, error) {
  const L = tenant.labels;
  const a = member.address || {};
  const errHtml = error ? `<tr><td colspan="2" class="err">${error}</td></tr>` : '';
  return layout(tenant, L.updateContact, `
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
<a href="${prefix}/member?q=${memberId}" style="font-size:11px">&laquo; Back</a>
</td></tr></table><img src="${SPACER}" width="1" height="6">
<table class="item" cellpadding="10" cellspacing="0" border="0" width="500">
<tr><td class="hdr" colspan="2">${L.updateContact}</td></tr>
${errHtml}
<form method="POST">
<tr class="r1"><td style="font-size:12px;" width="140">${L.address}</td>
    <td><input type="text" class="item" style="width:220px;font-size:12px" name="f1" value="${a.street || ''}"></td></tr>
<tr class="r2"><td style="font-size:12px;">${L.city}</td>
    <td><input type="text" class="item" style="width:160px;font-size:12px" name="f2" value="${a.city || ''}"></td></tr>
<tr class="r1"><td style="font-size:12px;">${L.state}</td>
    <td><input type="text" class="item" style="width:40px;font-size:12px" name="f3" value="${a.state || ''}"></td></tr>
<tr class="r2"><td style="font-size:12px;">${L.zip}</td>
    <td><input type="text" class="item" style="width:80px;font-size:12px" name="f4" value="${a.zip || ''}"></td></tr>
<tr class="r1"><td style="font-size:12px;">${L.phone}</td>
    <td><input type="text" class="item" style="width:160px;font-size:12px" name="f5" value="${member.phone || ''}"></td></tr>
<tr class="r2"><td style="font-size:12px;">${L.email}</td>
    <td><input type="text" class="item" style="width:220px;font-size:12px" name="f6" value="${member.email || ''}"></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Save Changes</button></td></tr>
</form></table>`, session, prefix);
}

function notesPage(tenant, memberId, member, session, prefix, banner) {
  const L = tenant.labels;
  const bannerHtml = banner ? `<tr><td colspan="2" class="ok">${banner}</td></tr>` : '';
  let rows = '';
  (member.notes || []).forEach((n, i) => {
    const cls = i % 2 === 0 ? 'r1' : 'r2';
    rows += `<tr class="${cls}"><td style="font-size:11px;">${n.timestamp}</td>
      <td style="font-size:11px;">${n.operator}</td><td style="font-size:12px;">${n.text}</td></tr>`;
  });
  if (!member.notes || !member.notes.length) rows = '<tr class="r1"><td colspan="3" style="font-size:11px;color:#888;">No notes</td></tr>';
  return layout(tenant, L.memberNotes, `
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
<a href="${prefix}/member?q=${memberId}" style="font-size:11px">&laquo; Back</a>
</td></tr></table><img src="${SPACER}" width="1" height="6">
<table class="item" cellpadding="8" cellspacing="0" border="0" width="600">
<tr><td class="hdr" colspan="3">${L.memberNotes} &mdash; ${member.name} (${memberId})</td></tr>
${bannerHtml}${rows}
<tr><td colspan="3"><img src="${SPACER}" width="1" height="8"></td></tr>
<tr><td colspan="3" class="hdr">Add Note</td></tr>
<form method="POST">
<tr class="r1"><td colspan="3"><textarea name="f1" rows="3" style="width:95%;font-size:12px;font-family:inherit" class="item"></textarea></td></tr>
<tr><td colspan="3"><button type="submit" class="btn">Save Note</button></td></tr>
</form></table>`, session, prefix);
}

// Loan detail uses DD-MMM-YYYY dates and different table styling (jank)
function loanDetailPage(tenant, memberId, member, loan, session, prefix) {
  const L = tenant.labels;
  let payRows = '';
  (loan.payments || []).forEach((p, i) => {
    const cls = i % 2 === 0 ? 'lr1' : 'lr2';
    payRows += `<tr class="${cls}"><td>${formatLoanDate(p.date)}</td>
      <td align="right">${formatMoney(p.amount)}</td><td>${p.ref}</td></tr>`;
  });
  if (!loan.payments || !loan.payments.length) payRows = '<tr class="lr1"><td colspan="3" style="color:#888;">No payments recorded</td></tr>';
  return layout(tenant, L.loanDetails, `
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
<a href="${prefix}/member?q=${memberId}" style="font-size:11px">&laquo; Back to ${L.memberDetails}</a>
</td></tr></table><img src="${SPACER}" width="1" height="6">
<table class="lt" cellpadding="8" cellspacing="0" width="540">
<tr class="lh"><td colspan="2">${L.loanDetails} &mdash; ${loan.type}</td></tr>
<tr class="lr1"><td width="160">${L.loanId}</td><td>${loan.loanId}</td></tr>
<tr class="lr2"><td>${L.loanType}</td><td>${loan.type}</td></tr>
<tr class="lr1"><td>${L.loanBalance}</td><td style="font-weight:bold;">${formatMoney(loan.balance)}</td></tr>
<tr class="lr2"><td>${L.loanRate}</td><td>${loan.rate}%</td></tr>
<tr class="lr1"><td>${L.monthlyPayment}</td><td>${formatMoney(loan.monthlyPayment)}</td></tr>
<tr class="lr2"><td>${L.nextPayment}</td><td>${formatLoanDate(loan.nextPaymentDue)}</td></tr>
<tr class="lr1"><td>${L.openedDate}</td><td>${formatLoanDate(loan.opened)}</td></tr>
<tr class="lr2"><td>${L.accountStatus}</td><td>${loan.status}</td></tr>
</table><img src="${SPACER}" width="1" height="8">
<table class="lt" cellpadding="6" cellspacing="0" width="540">
<tr class="lh"><td>DATE</td><td>AMOUNT</td><td>REFERENCE</td></tr>
${payRows}
</table><img src="${SPACER}" width="1" height="8">
<a href="${prefix}/member/${memberId}/loan/${loan.loanId}/payment" class="btn" style="text-decoration:none;display:inline-block;">${L.makePayment}</a>
`, session, prefix);
}

function loanPaymentFormPage(tenant, memberId, member, loan, session, prefix, error) {
  const L = tenant.labels;
  const errHtml = error ? `<tr><td colspan="2" class="err">${error}</td></tr>` : '';
  let opts = '';
  for (const a of member.accounts) {
    opts += `<option value="${a.number}">${a.type} (${a.number}) - ${formatMoney(a.balance)}</option>`;
  }
  return layout(tenant, L.makePayment, `
<table cellpadding="0" cellspacing="0" border="0"><tr><td>
<a href="${prefix}/member/${memberId}/loan/${loan.loanId}" style="font-size:11px">&laquo; Back to ${L.loanDetails}</a>
</td></tr></table><img src="${SPACER}" width="1" height="6">
<table class="lt" cellpadding="10" cellspacing="0" width="480">
<tr class="lh"><td colspan="2">${L.makePayment} &mdash; ${loan.type} (${loan.loanId})</td></tr>
${errHtml}
<tr class="lr1"><td width="140">${L.loanBalance}</td><td>${formatMoney(loan.balance)}</td></tr>
<tr class="lr2"><td>${L.monthlyPayment}</td><td>${formatMoney(loan.monthlyPayment)}</td></tr>
<form method="POST">
<tr class="lr1"><td>From Share</td><td><select class="item" style="font-size:12px" name="f1">${opts}</select></td></tr>
<tr class="lr2"><td>Amount</td><td><input type="text" class="item" style="width:120px;font-size:12px" name="f2" value="${loan.monthlyPayment}"></td></tr>
<tr><td colspan="2"><img src="${SPACER}" width="1" height="6"></td></tr>
<tr><td></td><td><button type="submit" class="btn">Review Payment</button></td></tr>
</form></table>`, session, prefix);
}

function loanPaymentReviewPage(tenant, memberId, member, loan, fromAcct, amount, session, prefix) {
  const L = tenant.labels;
  return layout(tenant, L.makePayment + ' \u2014 Review', `
<table class="lt" cellpadding="10" cellspacing="0" width="480">
<tr class="lh"><td colspan="2">Review Payment</td></tr>
<tr class="lr1"><td width="140">Loan</td><td>${loan.type} (${loan.loanId})</td></tr>
<tr class="lr2"><td>From</td><td>${fromAcct.type} (${fromAcct.number})</td></tr>
<tr class="lr1"><td>Amount</td><td style="font-weight:bold;">${formatMoney(amount)}</td></tr>
<form method="POST">
<input type="hidden" name="f1" value="${fromAcct.number}">
<input type="hidden" name="f2" value="${amount}">
<tr><td></td><td><button type="submit" class="btn">Post Payment</button></td></tr>
</form></table>`, session, prefix);
}

function loanPaymentDonePage(tenant, memberId, member, loan, fromAcct, amount, ref, session, prefix) {
  return layout(tenant, 'Payment Confirmation', `
<table class="lt" cellpadding="10" cellspacing="0" width="480">
<tr class="lh"><td colspan="2">Payment Posted</td></tr>
<tr class="lr1"><td width="140">Reference #</td><td style="font-weight:bold;">${ref}</td></tr>
<tr class="lr2"><td>Loan</td><td>${loan.type} (${loan.loanId}) &mdash; new balance: ${formatMoney(loan.balance)}</td></tr>
<tr class="lr1"><td>From</td><td>${fromAcct.type} (${fromAcct.number}) &mdash; new balance: ${formatMoney(fromAcct.balance)}</td></tr>
<tr class="lr2"><td>Amount</td><td>${formatMoney(amount)}</td></tr>
<tr><td colspan="2"><a href="${prefix}/member?q=${memberId}">&laquo; Return to ${tenant.labels.memberDetails}</a></td></tr>
</table>`, session, prefix);
}

function auditLogPage(tenant, session, prefix) {
  let rows = '';
  auditLog.forEach((e, i) => {
    const cls = i % 2 === 0 ? 'r1' : 'r2';
    rows += `<tr class="${cls}"><td style="font-size:11px;">${e.timestamp}</td>
      <td style="font-size:11px;">${e.operator}</td><td style="font-size:11px;">${e.action}</td>
      <td style="font-size:11px;">${e.memberId}</td><td style="font-size:11px;">${e.details}</td></tr>`;
  });
  if (!auditLog.length) rows = '<tr class="r1"><td colspan="5" style="font-size:11px;color:#888;">No audit entries</td></tr>';
  return layout(tenant, tenant.labels.auditLog, `
<table class="item" cellpadding="6" cellspacing="0" border="0" width="700">
<tr><td class="hdr" colspan="5">${tenant.labels.auditLog}</td></tr>
<tr class="r2"><th style="font-size:11px;text-align:left;">Timestamp</th>
  <th style="font-size:11px;text-align:left;">Operator</th>
  <th style="font-size:11px;text-align:left;">Action</th>
  <th style="font-size:11px;text-align:left;">Member</th>
  <th style="font-size:11px;text-align:left;">Details</th></tr>
${rows}
</table>`, session, prefix);
}

// ── Interstitials (shared by organic + fault paths) ─────────

function sessionWarningPage(tenant, session, prefix, returnTo) {
  return layout(tenant, 'Session Warning', `
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<img src="${SPACER}" width="1" height="30">
<table class="item" cellpadding="12" cellspacing="0" border="0" width="400">
<tr><td class="hdr">Session Warning</td></tr>
<tr><td class="warn" style="font-size:13px;">Your session is about to expire.</td></tr>
<tr><td style="font-size:12px;">Click Continue to extend your session.</td></tr>
<form method="POST" action="${prefix}/session-extend">
<input type="hidden" name="returnTo" value="${returnTo}">
<tr><td align="center"><button type="submit" class="btn">Continue</button></td></tr>
</form></table></td></tr></table>`, session, prefix);
}
function sessionExpiredMessage() { return 'Your session has expired. Please sign in again.'; }

function compliancePage(tenant, memberId, member, session, prefix, returnTo, error) {
  const errHtml = error ? `<tr><td class="err">${error}</td></tr>` : '';
  return layout(tenant, 'Compliance Notice', `
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<img src="${SPACER}" width="1" height="20">
<table class="item" cellpadding="12" cellspacing="0" border="0" width="460">
<tr><td class="hdr">Compliance Notice</td></tr>
<tr><td class="warn"><b>Alert:</b> ${member.alert}</td></tr>
<tr><td style="font-size:12px;">Member: <b>${member.name}</b> (${memberId})</td></tr>
${errHtml}
<form method="POST" action="${prefix}/member/${memberId}/compliance">
<input type="hidden" name="returnTo" value="${returnTo}">
<tr><td style="font-size:12px;"><input type="checkbox" name="ack" value="1" class="item"> I acknowledge this compliance notice</td></tr>
<tr><td align="center"><button type="submit" class="btn">Continue</button></td></tr>
</form></table></td></tr></table>`, session, prefix);
}

function privilegeErrorPage(tenant, memberId, session, prefix) {
  return layout(tenant, 'Access Denied', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr">Access Denied</td></tr>
<tr><td style="font-size:12px;">Insufficient privileges &mdash; supervisor approval required</td></tr>
<tr><td><a href="${prefix}/member?q=${memberId}">&laquo; Return to ${tenant.labels.memberDetails}</a></td></tr>
</table>`, session, prefix);
}

function appErrorPage(tenant, session, prefix) {
  return layout(tenant, 'Application Error', `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr" style="background:#900;color:#fff;">Application Error</td></tr>
<tr><td style="font-size:12px;">An unexpected error has occurred.</td></tr>
<tr><td style="font-size:10px;color:#888;">Error reference: ERR-${Date.now()}</td></tr>
</table>`, session, prefix);
}

function deadModulePage(tenant, moduleName, session, prefix) {
  return layout(tenant, moduleName, `
<table class="item" cellpadding="10" cellspacing="0" border="0" width="440">
<tr><td class="hdr">${moduleName}</td></tr>
<tr><td style="font-size:12px;color:#888;">This module is not available in the current build.</td></tr>
</table>`, session, prefix);
}

// ── Request handler ─────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ── Fault injection ─────────────────────────────────────
  const fault = url.searchParams.get('fault');
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
      return respond(res, 200, loginPage(tenant, url.searchParams.get('expired') ? sessionExpiredMessage() : null));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const username = body.get('f1') || '';
      const password = body.get('f2') || '';
      const cred = CREDENTIALS[username];
      if (cred && cred.password === password) {
        const sid = crypto.randomBytes(16).toString('hex');
        sessions.set(sid, { role: cred.role, username, createdAt: Date.now(), acknowledgedMembers: new Set() });
        addAudit(username, 'LOGIN', '', 'Successful login');
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
  if (!session) return redirect(res, `${prefix}/login`);
  if (isExpired(session)) { sessions.delete(session.sid); return redirect(res, `${prefix}/login?expired=1`); }

  // ── Faults ──────────────────────────────────────────────
  if (fault === 'app_error') return respond(res, 500, appErrorPage(tenant, session, prefix));
  if (fault === 'session_expired') { sessions.delete(session.sid); return redirect(res, `${prefix}/login?expired=1`); }
  if (fault === 'session_warning') {
    const clean = pathname + (url.search ? url.search.replace(/[?&]fault=session_warning/, '') : '');
    return respond(res, 200, sessionWarningPage(tenant, session, prefix, clean || prefix + '/dashboard'));
  }

  // ── Session warning (organic) ───────────────────────────
  const skipWarn = subpath.endsWith('/accounts') || subpath === '/session-extend';
  if (req.method === 'GET' && !skipWarn && isNearExpiry(session)) {
    return respond(res, 200, sessionWarningPage(tenant, session, prefix, pathname + url.search));
  }

  // ── Session extend ──────────────────────────────────────
  if (subpath === '/session-extend' && req.method === 'POST') {
    const body = await parseBody(req);
    const s = sessions.get(session.sid);
    if (s) s.createdAt = Date.now();
    return redirect(res, body.get('returnTo') || `${prefix}/dashboard`);
  }

  // ── Resolve active member ───────────────────────────────
  let activeMemberId = null;
  if (subpath === '/member' || subpath === '/member/') activeMemberId = url.searchParams.get('q');
  else { const m = subpath.match(/^\/member\/([^/]+)/); if (m) activeMemberId = m[1]; }

  // ── Compliance + role checks ────────────────────────────
  if (activeMemberId) {
    const member = MEMBERS[activeMemberId];

    const compMatch = subpath.match(/^\/member\/([^/]+)\/compliance$/);
    if (compMatch && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.get('ack')) return respond(res, 200, compliancePage(tenant, activeMemberId, member, session, prefix,
        body.get('returnTo') || `${prefix}/member?q=${activeMemberId}`, 'You must check the acknowledgment box'));
      const s = sessions.get(session.sid);
      if (s) s.acknowledgedMembers.add(activeMemberId);
      return redirect(res, body.get('returnTo') || `${prefix}/member?q=${activeMemberId}`);
    }

    if (fault === 'compliance_prompt' && member && member.alert) {
      const clean = pathname + (url.search ? url.search.replace(/[?&]fault=compliance_prompt/, '') : '');
      return respond(res, 200, compliancePage(tenant, activeMemberId, member, session, prefix, clean));
    }

    if (member && member.alert && req.method === 'GET'
        && !subpath.endsWith('/accounts') && !subpath.endsWith('/compliance')) {
      const s = sessions.get(session.sid);
      if (s && !s.acknowledgedMembers.has(activeMemberId))
        return respond(res, 200, compliancePage(tenant, activeMemberId, member, session, prefix, pathname + url.search));
    }

    const isRestricted = member && member.alert && member.alert.toLowerCase().includes('restricted');
    if (isRestricted && session.role === 'operator' && subpath.match(/\/(open-sub-account|transfer|loan\/[^/]+\/payment)/))
      return respond(res, 200, privilegeErrorPage(tenant, activeMemberId, session, prefix));
  }

  // ── Dashboard ───────────────────────────────────────────
  if (subpath === '/dashboard' || subpath === '/dashboard/' || subpath === '/') return respond(res, 200, dashboardPage(tenant, session, prefix));

  // ── Dead modules ────────────────────────────────────────
  if (subpath === '/reports') return respond(res, 200, deadModulePage(tenant, tenant.labels.reports, session, prefix));
  if (subpath === '/settings') return respond(res, 200, deadModulePage(tenant, tenant.labels.settings, session, prefix));

  // ── Audit log ───────────────────────────────────────────
  if (subpath === '/audit') return respond(res, 200, auditLogPage(tenant, session, prefix));

  // ── Search ──────────────────────────────────────────────
  if (subpath === '/search' || subpath === '/search/') {
    if (req.method === 'GET') return respond(res, 200, searchPage(tenant, session, prefix));
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const memberId = (body.get('f1') || '').trim();
      const lastName = (body.get('f2') || '').trim();
      if (memberId) return redirect(res, `${prefix}/member?q=${encodeURIComponent(memberId)}`);
      if (lastName) return redirect(res, `${prefix}/search-results?name=${encodeURIComponent(lastName)}`);
      return redirect(res, `${prefix}/search`);
    }
  }

  // ── Search results (name) ───────────────────────────────
  if (subpath === '/search-results') {
    const name = url.searchParams.get('name') || '';
    const results = searchByLastName(name);
    return respond(res, 200, searchResultsPage(tenant, results, name, session, prefix));
  }

  // ── Member detail ───────────────────────────────────────
  if (subpath === '/member' || subpath === '/member/') {
    const memberId = url.searchParams.get('q') || '';
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 200, notFoundPage(tenant, session, prefix));
    const banner = url.searchParams.get('updated') ? 'Contact information updated successfully.' : null;
    return respond(res, 200, memberPage(tenant, memberId, member, session, prefix, banner));
  }

  // ── Accounts iframe ─────────────────────────────────────
  const accountsMatch = subpath.match(/^\/member\/([^/]+)\/accounts$/);
  if (accountsMatch) {
    const member = MEMBERS[accountsMatch[1]];
    if (!member) return respond(res, 404, 'Not found');
    return respond(res, 200, accountsFrame(tenant, accountsMatch[1], member, prefix));
  }

  // ── Share detail ────────────────────────────────────────
  const shareMatch = subpath.match(/^\/member\/([^/]+)\/account\/([^/]+)$/);
  if (shareMatch) {
    const [, memberId, acctNum] = shareMatch;
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    const acct = findAccount(member, acctNum);
    if (!acct) return respond(res, 404, 'Not found');
    return respond(res, 200, shareDetailPage(tenant, memberId, member, acct, session, prefix));
  }

  // ── Transactions (with pagination + date filter) ────────
  const txMatch = subpath.match(/^\/member\/([^/]+)\/account\/([^/]+)\/transactions$/);
  if (txMatch) {
    const [, memberId, acctNum] = txMatch;
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    const acct = findAccount(member, acctNum);
    if (!acct) return respond(res, 404, 'Not found');

    let txs = [...acct.transactions];
    // Sort newest-first so newly appended ledger rows appear on page 1
    txs.sort((a, b) => parseDateForFilter(b.date) - parseDateForFilter(a.date));
    const filterFrom = url.searchParams.get('from') || '';
    const filterTo = url.searchParams.get('to') || '';
    if (filterFrom) { const d = parseDateForFilter(filterFrom); txs = txs.filter(t => parseDateForFilter(t.date) >= d); }
    if (filterTo) { const d = parseDateForFilter(filterTo); txs = txs.filter(t => parseDateForFilter(t.date) <= d); }

    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(txs.length / perPage));
    const pageTxs = txs.slice((page - 1) * perPage, page * perPage);

    return respond(res, 200, transactionsPage(tenant, memberId, member, acct, pageTxs, page, totalPages, filterFrom, filterTo, session, prefix));
  }

  // ── Transfer ────────────────────────────────────────────
  const transferMatch = subpath.match(/^\/member\/([^/]+)\/transfer$/);
  if (transferMatch) {
    const memberId = transferMatch[1];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    if (req.method === 'GET') return respond(res, 200, transferFormPage(tenant, memberId, member, session, prefix, null));
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const fromNum = body.get('f1') || '', toNum = body.get('f2') || '';
      const amtStr = (body.get('f3') || '').trim();
      const memo = (body.get('f4') || '').trim();
      const amount = parseFloat(amtStr);
      if (!amtStr || isNaN(amount) || amount <= 0) return respond(res, 200, transferFormPage(tenant, memberId, member, session, prefix, 'Please enter a valid positive amount'));
      const fromAcct = findAccount(member, fromNum), toAcct = findAccount(member, toNum);
      if (!fromAcct || !toAcct) return respond(res, 200, transferFormPage(tenant, memberId, member, session, prefix, 'Invalid account selection'));
      if (fromNum === toNum) return respond(res, 200, transferFormPage(tenant, memberId, member, session, prefix, 'From and To accounts must be different'));
      if (amount > fromAcct.balance) return respond(res, 200, transferFormPage(tenant, memberId, member, session, prefix, 'Insufficient funds: transfer amount exceeds available balance'));
      return redirect(res, `${prefix}/member/${memberId}/transfer/review?from=${encodeURIComponent(fromNum)}&to=${encodeURIComponent(toNum)}&amount=${amount}&memo=${encodeURIComponent(memo)}`);
    }
  }

  // ── Transfer review ─────────────────────────────────────
  const reviewMatch = subpath.match(/^\/member\/([^/]+)\/transfer\/review$/);
  if (reviewMatch) {
    const memberId = reviewMatch[1];
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    if (req.method === 'GET') {
      const fromAcct = findAccount(member, url.searchParams.get('from') || '');
      const toAcct = findAccount(member, url.searchParams.get('to') || '');
      const amount = parseFloat(url.searchParams.get('amount') || '0');
      const memo = url.searchParams.get('memo') || '';
      if (!fromAcct || !toAcct || amount <= 0) return redirect(res, `${prefix}/member/${memberId}/transfer`);
      return respond(res, 200, transferReviewPage(tenant, memberId, member, fromAcct, toAcct, amount, memo, session, prefix));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const fromNum = body.get('f1') || '', toNum = body.get('f2') || '';
      const amount = parseFloat(body.get('f3') || '0');
      const memo = (body.get('f4') || '').trim();
      const fromAcct = findAccount(member, fromNum), toAcct = findAccount(member, toNum);
      if (!fromAcct || !toAcct || amount <= 0 || fromNum === toNum || amount > fromAcct.balance)
        return redirect(res, `${prefix}/member/${memberId}/transfer`);

      fromAcct.balance = Math.round((fromAcct.balance - amount) * 100) / 100;
      toAcct.balance = Math.round((toAcct.balance + amount) * 100) / 100;
      const d = today();
      const memoSuffix = memo ? ` - ${memo}` : '';
      fromAcct.transactions.push({ date: d, desc: `Transfer to ${toAcct.type} (${toAcct.number})${memoSuffix}`, debit: amount, credit: null });
      toAcct.transactions.push({ date: d, desc: `Transfer from ${fromAcct.type} (${fromAcct.number})${memoSuffix}`, debit: null, credit: amount });
      const refNum = getNextRef();
      addAudit(session.username, 'TRANSFER', memberId, `${fromNum} -> ${toNum} ${formatMoney(amount)}${memo ? ' (' + memo + ')' : ''}`);
      return redirect(res, `${prefix}/member/${memberId}/transfer/done?ref=${refNum}&amount=${amount}&from=${encodeURIComponent(fromNum)}&to=${encodeURIComponent(toNum)}&memo=${encodeURIComponent(memo)}`);
    }
  }

  // ── Transfer done ───────────────────────────────────────
  const doneMatch = subpath.match(/^\/member\/([^/]+)\/transfer\/done$/);
  if (doneMatch) {
    const memberId = doneMatch[1], member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    const fromAcct = findAccount(member, url.searchParams.get('from') || '');
    const toAcct = findAccount(member, url.searchParams.get('to') || '');
    if (!fromAcct || !toAcct) return redirect(res, `${prefix}/member?q=${memberId}`);
    return respond(res, 200, transferDonePage(tenant, memberId, member, fromAcct, toAcct,
      parseFloat(url.searchParams.get('amount') || '0'), url.searchParams.get('memo') || '',
      url.searchParams.get('ref') || '', session, prefix));
  }

  // ── Open sub-account ────────────────────────────────────
  const subAcctMatch = subpath.match(/^\/member\/([^/]+)\/open-sub-account$/);
  if (subAcctMatch) {
    const memberId = subAcctMatch[1], member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    if (req.method === 'GET') return respond(res, 200, openSubAccountPage(tenant, memberId, member, session, prefix));
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const accountType = body.get('f1') || 'holiday-club';
      const acctNum = getNextAcctNum(memberId);
      const shareId = `N${String(member.accounts.length).padStart(2, '0')}`;
      const typeLabel = SUB_ACCOUNT_TYPES[accountType] || accountType;
      member.accounts.push({
        type: typeLabel, number: acctNum, shareId, balance: 0, available: 0,
        dividendRate: 0.25, opened: today(), status: 'Active',
        transactions: [{ date: today(), desc: `${typeLabel} account opened`, debit: null, credit: null }],
      });
      addAudit(session.username, 'OPEN_SUB_ACCOUNT', memberId, `${typeLabel} ${acctNum}`);
      return redirect(res, `${prefix}/member/${memberId}/confirmation?type=${encodeURIComponent(accountType)}&acctNum=${encodeURIComponent(acctNum)}`);
    }
  }

  // ── Sub-account confirmation ────────────────────────────
  const confirmMatch = subpath.match(/^\/member\/([^/]+)\/confirmation$/);
  if (confirmMatch) {
    const memberId = confirmMatch[1], member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    return respond(res, 200, confirmationPage(tenant, memberId, member, url.searchParams.get('type') || '', url.searchParams.get('acctNum') || '', session, prefix));
  }

  // ── Update contact info ─────────────────────────────────
  const contactMatch = subpath.match(/^\/member\/([^/]+)\/update-contact$/);
  if (contactMatch) {
    const memberId = contactMatch[1], member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    if (req.method === 'GET') return respond(res, 200, updateContactPage(tenant, memberId, member, session, prefix, null));
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const zip = (body.get('f4') || '').trim();
      const phone = (body.get('f5') || '').trim();
      const email = (body.get('f6') || '').trim();
      // Validation
      if (zip && !/^\d{5}$/.test(zip)) return respond(res, 200, updateContactPage(tenant, memberId, member, session, prefix, 'ZIP code must be 5 digits'));
      if (phone && !/^\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}$/.test(phone)) return respond(res, 200, updateContactPage(tenant, memberId, member, session, prefix, 'Invalid phone number format'));
      if (email && !email.includes('@')) return respond(res, 200, updateContactPage(tenant, memberId, member, session, prefix, 'Email must contain @'));
      // Mutate
      if (!member.address) member.address = {};
      member.address.street = (body.get('f1') || '').trim();
      member.address.city = (body.get('f2') || '').trim();
      member.address.state = (body.get('f3') || '').trim();
      member.address.zip = zip;
      member.phone = phone;
      member.email = email;
      addAudit(session.username, 'UPDATE_CONTACT', memberId, 'Contact information updated');
      return redirect(res, `${prefix}/member?q=${memberId}&updated=1`);
    }
  }

  // ── Member notes ────────────────────────────────────────
  const notesMatch = subpath.match(/^\/member\/([^/]+)\/notes$/);
  if (notesMatch) {
    const memberId = notesMatch[1], member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    if (req.method === 'GET') return respond(res, 200, notesPage(tenant, memberId, member, session, prefix, null));
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const text = (body.get('f1') || '').trim();
      if (text) {
        if (!member.notes) member.notes = [];
        member.notes.unshift({ timestamp: nowTimestamp(), operator: session.username, text });
        addAudit(session.username, 'ADD_NOTE', memberId, text.substring(0, 60));
      }
      return respond(res, 200, notesPage(tenant, memberId, member, session, prefix, text ? 'Note saved.' : null));
    }
  }

  // ── Loan detail ─────────────────────────────────────────
  const loanMatch = subpath.match(/^\/member\/([^/]+)\/loan\/([^/]+)$/);
  if (loanMatch) {
    const [, memberId, loanId] = loanMatch;
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    const loan = findLoan(member, loanId);
    if (!loan) return respond(res, 404, 'Loan not found');
    return respond(res, 200, loanDetailPage(tenant, memberId, member, loan, session, prefix));
  }

  // ── Loan payment ────────────────────────────────────────
  const lpMatch = subpath.match(/^\/member\/([^/]+)\/loan\/([^/]+)\/payment$/);
  if (lpMatch) {
    const [, memberId, loanId] = lpMatch;
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    const loan = findLoan(member, loanId);
    if (!loan) return respond(res, 404, 'Loan not found');
    if (req.method === 'GET') return respond(res, 200, loanPaymentFormPage(tenant, memberId, member, loan, session, prefix, null));
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const fromNum = body.get('f1') || '';
      const amtStr = (body.get('f2') || '').trim();
      const amount = parseFloat(amtStr);
      if (!amtStr || isNaN(amount) || amount <= 0) return respond(res, 200, loanPaymentFormPage(tenant, memberId, member, loan, session, prefix, 'Please enter a valid positive amount'));
      const fromAcct = findAccount(member, fromNum);
      if (!fromAcct) return respond(res, 200, loanPaymentFormPage(tenant, memberId, member, loan, session, prefix, 'Invalid account'));
      if (amount > fromAcct.balance) return respond(res, 200, loanPaymentFormPage(tenant, memberId, member, loan, session, prefix, 'Insufficient funds'));
      return redirect(res, `${prefix}/member/${memberId}/loan/${loanId}/payment/review?from=${encodeURIComponent(fromNum)}&amount=${amount}`);
    }
  }

  // ── Loan payment review ─────────────────────────────────
  const lprMatch = subpath.match(/^\/member\/([^/]+)\/loan\/([^/]+)\/payment\/review$/);
  if (lprMatch) {
    const [, memberId, loanId] = lprMatch;
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    const loan = findLoan(member, loanId);
    if (!loan) return respond(res, 404, 'Loan not found');
    if (req.method === 'GET') {
      const fromAcct = findAccount(member, url.searchParams.get('from') || '');
      const amount = parseFloat(url.searchParams.get('amount') || '0');
      if (!fromAcct || amount <= 0) return redirect(res, `${prefix}/member/${memberId}/loan/${loanId}/payment`);
      return respond(res, 200, loanPaymentReviewPage(tenant, memberId, member, loan, fromAcct, amount, session, prefix));
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const fromNum = body.get('f1') || '';
      const amount = parseFloat(body.get('f2') || '0');
      const fromAcct = findAccount(member, fromNum);
      if (!fromAcct || amount <= 0 || amount > fromAcct.balance)
        return redirect(res, `${prefix}/member/${memberId}/loan/${loanId}/payment`);

      // STATE MUTATION: loan payment
      fromAcct.balance = Math.round((fromAcct.balance - amount) * 100) / 100;
      loan.balance = Math.round((loan.balance - amount) * 100) / 100;
      const d = today();
      fromAcct.transactions.push({ date: d, desc: `Loan Payment - ${loan.type} (${loan.loanId})`, debit: amount, credit: null });
      const ref = getNextLoanPayRef();
      if (!loan.payments) loan.payments = [];
      loan.payments.push({ date: d, amount, ref });
      addAudit(session.username, 'LOAN_PAYMENT', memberId, `${loan.loanId} ${formatMoney(amount)} from ${fromNum}`);
      return redirect(res, `${prefix}/member/${memberId}/loan/${loanId}/payment/done?ref=${ref}&amount=${amount}&from=${encodeURIComponent(fromNum)}`);
    }
  }

  // ── Loan payment done ───────────────────────────────────
  const lpdMatch = subpath.match(/^\/member\/([^/]+)\/loan\/([^/]+)\/payment\/done$/);
  if (lpdMatch) {
    const [, memberId, loanId] = lpdMatch;
    const member = MEMBERS[memberId];
    if (!member) return respond(res, 404, 'Not found');
    const loan = findLoan(member, loanId);
    const fromAcct = findAccount(member, url.searchParams.get('from') || '');
    if (!loan || !fromAcct) return redirect(res, `${prefix}/member?q=${memberId}`);
    return respond(res, 200, loanPaymentDonePage(tenant, memberId, member, loan, fromAcct,
      parseFloat(url.searchParams.get('amount') || '0'), url.searchParams.get('ref') || '', session, prefix));
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
  console.log(`Members: ${Object.keys(MEMBERS).length}`);
  console.log(`Session TTL: ${SESSION_TTL_MS}ms`);
});
